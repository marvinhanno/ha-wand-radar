"""Nur für die Messphase der eigenen Regenvorhersage (Optionen archiv_tage, prognose_test).

Eigener Thread: der Radar-Lauf legt nur (t0, Vorhersage-Bytes) in eine Warteschlange und wartet nie darauf.
- archiv_tage > 0: je Lauf das Analysebild (Rechengebiet ≈ 500 × 500 km um Zuhause, 1 km), alle 15 min dazu die DWD-Vorhersage
  bei +30/+60/+120 min und ihre Reihe am Zuhause-Punkt, je stündlichem ICON-D2-RUC-Lauf DBZ_CMAX 0 … 240 min (15 min, auf 2 km)
  nach /share/wand-radar-archiv/. Kodierung uint8: 0 = trocken (< 5 dBZ), sonst dBZ = Wert / 2 − 10. Ältere Tage werden gelöscht.
- prognose_test: alle 15 min die Kandidaten aus prognose.py zusätzlich rechnen, nur die Zeiten ins Log (Präfix „Prognose-Test:“).
Fehler bleiben hier (Log „Archiv:“), der Radar-Lauf merkt davon nichts.
"""
import datetime as dt
import json
import os
import queue
import shutil
import threading
import time

import cv2
import numpy as np
import requests
from pyproj import Transformer

import prognose

ZIEL = "/share/wand-radar-archiv"
RUC = "https://opendata.dwd.de/weather/nwp/v1/m/icon-d2-ruc/p/"
RUC_VERZUG = 40           # min nach Laufbeginn, ab denen ein Lauf geholt wird
RUC_MINUTEN = range(0, 241, 15)
GROESSE = 500             # Kantenlänge des Rechengebiets in km
UA = {"User-Agent": "ha-wand-radar/0.17 (Home Assistant add-on)"}
UTC = dt.timezone.utc


def kodieren(dbz):
    return np.where(dbz < 5, 0, np.clip(np.round((dbz + 10) * 2), 1, 255)).astype(np.uint8)


def dekodieren(c):
    return np.where(c == 0, prognose.TROCKEN, c.astype(np.float32) / 2 - 10).astype(np.float32)


class Gebiet:
    """Rechengebiet im DWD-Radargitter, gleiche Rechnung wie werkzeuge/radar-prognose/daten.py (Mitte = Zuhause)."""

    def __init__(self, where, shape, lat, lon):
        self.where, self.shape = where, shape
        self.proj = where["projdef"].decode()
        tr = Transformer.from_crs("EPSG:4326", self.proj, always_xy=True)
        self.xul, self.yul = tr.transform(where["UL_lon"], where["UL_lat"])
        hx, hy = tr.transform(lon, lat)
        hc, hr = (hx - self.xul) / 1000 - 0.5, (self.yul - hy) / 1000 - 0.5
        self.r0 = max(0, int(round(hr)) - GROESSE // 2)
        self.c0 = max(0, int(round(hc)) - GROESSE // 2)
        self.r1, self.c1 = min(shape[0], self.r0 + GROESSE), min(shape[1], self.c0 + GROESSE)
        self.home = (int(round(hr)) - self.r0, int(round(hc)) - self.c0)

    def crop(self, a):
        return np.ascontiguousarray(a[self.r0:self.r1, self.c0:self.c1])

    def json(self):
        return {"r0": self.r0, "c0": self.c0, "r1": self.r1, "c1": self.c1, "home": self.home, "groesse_km": GROESSE,
                "dwd_gitter": list(self.shape), "where": {k: v.decode() if isinstance(v, bytes) else float(v) for k, v in self.where.items()},
                "kodierung": "uint8: 0 = trocken (< 5 dBZ), sonst dBZ = Wert / 2 - 10", "ruc": "2 km (halbe Auflösung), Schritte 0 … 240 min je 15 min"}


def ruc_index(gebiet, clat, clon):
    """Nächste ICON-Dreieckszelle je 2-km-Pixel (ohne scipy: Zellen einsortieren, die nächste gewinnt, Lücken aus Nachbarn füllen)."""
    tr = Transformer.from_crs("EPSG:4326", gebiet.proj, always_xy=True)
    x, y = tr.transform(clon.astype(np.float64), clat.astype(np.float64))
    col = (x - gebiet.xul) / 1000 - 0.5 - gebiet.c0
    row = (gebiet.yul - y) / 1000 - 0.5 - gebiet.r0
    h2, w2 = (gebiet.r1 - gebiet.r0) // 2, (gebiet.c1 - gebiet.c0) // 2
    j, i = np.floor((col + 0.5) / 2).astype(np.int64), np.floor((row + 0.5) / 2).astype(np.int64)
    ok = np.nonzero((i >= 0) & (i < h2) & (j >= 0) & (j < w2))[0]
    d = (col[ok] - (2 * j[ok] + 0.5)) ** 2 + (row[ok] - (2 * i[ok] + 0.5)) ** 2
    ok = ok[np.argsort(-d)]                      # weiteste zuerst, die nächste Zelle schreibt zuletzt
    idx = np.full((h2, w2), -1, np.float32)      # float32: Zellnummern < 2^24 bleiben exakt, cv2.dilate geht
    idx[i[ok], j[ok]] = ok
    for _ in range(20):
        if not (idx < 0).any():
            break
        idx = np.where(idx < 0, cv2.dilate(idx, np.ones((3, 3), np.uint8)), idx)
    return idx.astype(np.int64)


def lies_grib(blob):
    import eccodes                                # nur hier gebraucht, Import kostet Zeit
    g = eccodes.codes_new_from_message(blob)
    try:
        v = eccodes.codes_get_values(g).astype(np.float32)
        fehlt = eccodes.codes_get(g, "missingValue")
    finally:
        eccodes.codes_release(g)
    v[v == fehlt] = np.nan
    return v


class AppFall:
    """Schnittstelle, die prognose.py erwartet, aus den Analysebildern in /data/past und den RUC-Läufen im Speicher."""

    def __init__(self, archiv):
        self.a = archiv
        self._analyse = {}

    def analyse(self, t):
        if t not in self._analyse:
            p = os.path.join(self.a.cfg["data_dir"], "past", t.strftime("%Y%m%d_%H%M") + ".h5")
            self._analyse[t] = self.a.gebiet.crop(self.a.read_h5(open(p, "rb").read())[0]) if os.path.exists(p) else None
        return self._analyse[t]

    def ruc_lauf_fuer(self, t0):
        ok = [r for r in self.a.ruc if r + dt.timedelta(minutes=RUC_VERZUG) <= t0]
        return max(ok) if ok else None

    def ruc_dbz(self, lauf, t):
        m = (t - lauf).total_seconds() / 60
        k = m / 15
        st = self.a.ruc[lauf]
        if k < 0 or k > len(st) - 1:
            return None
        i = min(int(k), len(st) - 2)
        f = st[i] + (st[i + 1] - st[i]) * (k - i)
        h, w = self.a.gebiet.r1 - self.a.gebiet.r0, self.a.gebiet.c1 - self.a.gebiet.c0
        return cv2.resize(f, (w, h), interpolation=cv2.INTER_LINEAR)


class Archiv(threading.Thread):
    def __init__(self, cfg, home, read_h5, log):
        super().__init__(daemon=True, name="archiv")
        self.cfg, self.home, self.read_h5, self.log = cfg, home, read_h5, log
        self.tage = int(cfg.get("archiv_tage") or 0)
        self.test = bool(cfg.get("prognose_test"))
        self.q = queue.Queue(maxsize=4)
        self.gebiet, self.idx = None, None
        self.ruc = {}                 # Laufbeginn -> (Schritte, h/2, w/2) dBZ
        self.ruc_versuch = 0

    def neuer_lauf(self, t0, forecast):
        """Vom Radar-Thread: nie blockieren."""
        try:
            self.q.put_nowait((t0, forecast))
        except queue.Full:
            self.log("Archiv: Warteschlange voll, Lauf übersprungen:", t0.strftime("%H:%M"))

    def run(self):
        self.log(f"Archiv: an (archiv_tage {self.tage}, prognose_test {self.test}), Ziel {ZIEL}")
        while True:
            try:
                t0, fc = self.q.get(timeout=60)
            except queue.Empty:
                t0 = fc = None
            if t0 is not None:
                try:
                    self.lauf(t0, fc)
                except Exception as e:
                    self.log("Archiv: Lauf", t0.strftime("%H:%M"), "fehlgeschlagen:", repr(e))
            if self.gebiet is not None:
                try:
                    self.ruc_holen()
                except Exception as e:
                    self.log("Archiv: RUC fehlgeschlagen:", repr(e))
                    self.ruc_versuch = time.time()
            if t0 is not None and self.test and t0.minute % 15 == 0:
                try:
                    self.prognose_test(t0)
                except Exception as e:
                    self.log("Prognose-Test: fehlgeschlagen:", repr(e))

    # ---------- Radar ----------
    def lauf(self, t0, fc):
        dbz, cover, where = self.read_h5(fc[0])
        if self.gebiet is None:
            self.gebiet = Gebiet(where, dbz.shape, *self.home)
            if self.tage:
                os.makedirs(ZIEL, exist_ok=True)
                json.dump(self.gebiet.json(), open(os.path.join(ZIEL, "gebiet.json"), "w"), indent=1)
                np.savez_compressed(os.path.join(ZIEL, "cover.npz"), cover=self.gebiet.crop(cover))
        if not self.tage:
            return
        t = time.time()
        g = self.gebiet
        out = {"a": kodieren(g.crop(dbz))}
        if t0.minute % 15 == 0:                     # DWD-Vorhersage als Vergleich: drei Felder + Reihe am Zuhause-Punkt
            felder = [g.crop(self.read_h5(fc[m])[0]) for m in range(5, 121, 5) if m in fc]
            if len(felder) == 24:
                r, c = g.home
                out["wn"] = kodieren(np.array([felder[5], felder[11], felder[23]]))
                out["wn_home"] = np.array([f[r - 2:r + 3, c - 2:c + 3].max() for f in felder], np.float32)
        d = os.path.join(ZIEL, t0.strftime("%Y%m%d"))
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, "a_" + t0.strftime("%H%M") + ".npz")
        np.savez_compressed(p + ".part.npz", **out)
        os.replace(p + ".part.npz", p)
        self.aufraeumen(t0)
        if t0.minute == 0:
            self.log(f"Archiv: {t0:%H:%M}Z gespeichert ({os.path.getsize(p) // 1024} KB, {time.time() - t:.1f} s), "
                     f"heute {sum(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d)) // 2 ** 20} MB")

    def aufraeumen(self, t0):
        grenze = (t0 - dt.timedelta(days=self.tage)).strftime("%Y%m%d")
        for f in os.listdir(ZIEL):
            if f.isdigit() and len(f) == 8 and f < grenze:
                shutil.rmtree(os.path.join(ZIEL, f), ignore_errors=True)
                self.log("Archiv: alter Tag gelöscht:", f)

    # ---------- ICON-D2-RUC ----------
    def _get(self, var, lauf, minuten):
        url = f"{RUC}{var}/r/{lauf:%Y-%m-%dT%H}%3A00/s/PT{minuten // 60:03d}H{minuten % 60:02d}M.grib2"
        r = requests.get(url, headers=UA, timeout=60)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.content

    def ruc_holen(self):
        jetzt = dt.datetime.now(UTC)
        lauf = (jetzt - dt.timedelta(minutes=RUC_VERZUG)).replace(minute=0, second=0, microsecond=0)
        if lauf in self.ruc or time.time() - self.ruc_versuch < 300:
            return
        t = time.time()
        if self.idx is None:
            p = os.path.join(self.cfg["data_dir"], f"ruc_index_{self.gebiet.r0}_{self.gebiet.c0}_{GROESSE}.npy")
            if os.path.exists(p):
                self.idx = np.load(p)
            else:
                clat, clon = self._get("CLAT", lauf, 0), self._get("CLON", lauf, 0)
                if clat is None or clon is None:
                    self.ruc_versuch = time.time()
                    return
                self.idx = ruc_index(self.gebiet, lies_grib(clat), lies_grib(clon))
                np.save(p, self.idx)
                self.log(f"Archiv: RUC-Gitterzuordnung berechnet ({time.time() - t:.0f} s)")
        felder = []
        for m in RUC_MINUTEN:
            b = self._get("DBZ_CMAX", lauf, m)
            if b is None:                        # Lauf noch nicht vollständig: in 5 min wieder
                self.ruc_versuch = time.time()
                return
            v = lies_grib(b)[self.idx]
            felder.append(np.maximum(np.nan_to_num(v, nan=prognose.TROCKEN), prognose.TROCKEN))
        st = np.array(felder, np.float32)
        self.ruc = {k: v for k, v in self.ruc.items() if k > lauf - dt.timedelta(hours=3)}
        self.ruc[lauf] = st
        if self.tage:
            d = os.path.join(ZIEL, lauf.strftime("%Y%m%d"))
            os.makedirs(d, exist_ok=True)
            p = os.path.join(d, "ruc_" + lauf.strftime("%H%M") + ".npz")
            np.savez_compressed(p + ".part.npz", dbz=kodieren(st))
            os.replace(p + ".part.npz", p)
        self.log(f"Archiv: RUC-Lauf {lauf:%H}Z geholt ({len(felder)} Schritte, {time.time() - t:.0f} s)")

    # ---------- Rechenzeit der Kandidaten ----------
    def prognose_test(self, t0):
        fall = AppFall(self)
        t = time.time()
        e0 = prognose.Eingang(fall, t0)
        lesen = time.time() - t
        if e0.jetzt() is None or any(e0.analysen[k] is None for k in range(5)):
            self.log("Prognose-Test: zu wenige Analysebilder, übersprungen")
            return
        zeiten = []
        for n in ("A", "A2", "Bm", "D"):
            e = prognose.Eingang(fall, t0)        # frisch je Kandidat: Zeit enthält die Bewegungsschätzung
            t = time.time()
            prognose.ALLE[n](e)
            zeiten.append(f"{n} {time.time() - t:.1f} s")
        nass = float((e0.jetzt() >= 14).mean() * 100)
        self.log(f"Prognose-Test: {t0:%H:%M}Z, Regenfläche {nass:.0f} %, RUC {'ja' if e0.ruc_lauf else 'nein'}, "
                 f"Lesen {lesen:.1f} s, " + ", ".join(zeiten))


def start(cfg, home, read_h5, log):
    if not int(cfg.get("archiv_tage") or 0) and not cfg.get("prognose_test"):
        return None
    a = Archiv(cfg, home, read_h5, log)
    a.start()
    return a
