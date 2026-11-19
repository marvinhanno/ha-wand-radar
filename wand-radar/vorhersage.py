"""Eigene Regenvorhersage DA50 im Radar-Lauf (Option prognose: eigen | dwd, seit 0.19.0).

Je Lauf, im Rechengebiet ≈ 500 × 500 km um Zuhause (Gebiet):
- Analysen t0 … t0 − 20 min aus /data/past (fehlende einzeln vom DWD nachgeladen wie die Vergangenheit des Videos),
- ICON-D2-RUC DBZ_CMAX, stündlicher Lauf, nur Laufbeginn + 30 … 225 min (14 Felder), auf 2 km; die Zuordnung Dreieck → Gitter liegt
  einmal berechnet in /data, der letzte Lauf kompakt in /data/ruc (übersteht einen Neustart),
- prognose.DA50 → Felder +5 … +120 min. Fehlt RUC, rechnet DA50 nur mit dem Radar-Bewegungsfeld (A).
Sparsam: kein Echo ≥ rain_threshold_dbz im Rechengebiet und RUC dort ohne Regen → nichts rechnen, alle Felder trocken.
felder() gibt None zurück (Grund im Log), wenn die eigene Vorhersage nicht geht; dann nimmt der Lauf die DWD-Vorhersage (WN).
Seit 0.20.0 für das Video: bewegung (Bewegungsfeld des letzten Laufs, daraus die Zwischenbilder der Vorhersage) und
ruc_regen() (zeigt RUC im Wand-Ausschnitt Regen in 2 h? – Teil der Regel „trocken = kein Video“).
Seit 0.21.0 liegen hier auch Rechengebiet, RUC-Abruf und -Zuordnung (bis 0.20.x in archiv.py, das mit der Messphase entfallen ist).
"""
import datetime as dt
import os
import time

import cv2
import numpy as np
import requests
from pyproj import Transformer

import prognose

# Fest (Tor R1, 16.11.2026; Länge nachgerechnet): nur so weit, wie die +2-h-Vorhersage braucht, über 2 h rechnet HA mit met.no.
# Der Lauf ist bei t0 schon 40 … 100 min alt (verfügbar ≈ RUC_VERZUG nach Beginn) → gebraucht wird Beginn + 30 … ≈ 220 min.
RUC_MINUTEN = range(30, 226, 15)
RUC_HALTEN = dt.timedelta(hours=3)
WIEDERHOLEN = 300                     # s bis zum nächsten Versuch, wenn ein RUC-Lauf fehlt oder unvollständig ist
RUC_ZURUECK = 3                       # h: so weit greift die App auf ältere Läufe zurück, wenn der fällige fehlt (seit 0.20.3)
UTC = dt.timezone.utc
RUC = "https://opendata.dwd.de/weather/nwp/v1/m/icon-d2-ruc/p/"
RUC_VERZUG = 40                       # min nach Laufbeginn, ab denen ein Lauf geholt wird
GROESSE = 500                         # Kantenlänge des Rechengebiets in km
UA = {"User-Agent": "ha-wand-radar/0.21 (Home Assistant add-on)"}


def kodieren(dbz):
    return np.where(dbz < 5, 0, np.clip(np.round((dbz + 10) * 2), 1, 255)).astype(np.uint8)


def dekodieren(c):
    return np.where(c == 0, prognose.TROCKEN, c.astype(np.float32) / 2 - 10).astype(np.float32)


class Gebiet:
    """Rechengebiet im DWD-Radargitter (GROESSE km um Zuhause), gleiche Rechnung wie werkzeuge/radar-prognose/daten.py."""

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


def ruc_get(var, lauf, minuten):
    """Ein GRIB2-Feld eines ICON-D2-RUC-Laufs (None, solange es noch nicht da ist)."""
    url = f"{RUC}{var}/r/{lauf:%Y-%m-%dT%H}%3A00/s/PT{minuten // 60:03d}H{minuten % 60:02d}M.grib2"
    r = requests.get(url, headers=UA, timeout=60)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.content


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


class Fall:
    """Schnittstelle, die prognose.py erwartet (e.fall), aus den Analysebildern in /data/past und den RUC-Läufen im Speicher."""

    def __init__(self, vorhersage):
        self.a = vorhersage
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
        m = (t - lauf).total_seconds() / 60 - RUC_MINUTEN[0]    # das erste gehaltene Feld ist Laufbeginn + 30 min
        k = m / 15
        st = self.a.ruc[lauf]
        if k < 0 or k > len(st) - 1:
            return None
        i = min(int(k), len(st) - 2)
        f = st[i] + (st[i + 1] - st[i]) * (k - i)
        h, w = self.a.gebiet.r1 - self.a.gebiet.r0, self.a.gebiet.c1 - self.a.gebiet.c0
        return cv2.resize(f, (w, h), interpolation=cv2.INTER_LINEAR)



class Vorhersage:
    """Hält Rechengebiet, RUC-Zuordnung und RUC-Läufe zwischen den Läufen. Die Felder für Fall/prognose.Eingang:
    cfg, gebiet, read_h5, ruc."""

    def __init__(self, cfg, home, read_h5, past_blob, log):
        self.cfg, self.home, self.read_h5, self.past_blob, self.log = cfg, home, read_h5, past_blob, log
        self.thr = cfg["rain_threshold_dbz"]
        self.ordner = os.path.join(cfg["data_dir"], "ruc")
        self.gebiet, self.idx = None, None
        self.ruc = {}                    # Laufbeginn -> (14, h/2, w/2) dBZ, erstes Feld = Laufbeginn + RUC_MINUTEN[0]
        self.ruc_versuch = 0.0
        self._verspaetet = None          # fälliger RUC-Lauf, dessen Verspätung schon im Log steht
        self.bewegung = None             # Bewegungsfeld des letzten Laufs (2 km, Rechengebiet, 2-km-Pixel je 5 min) oder None

    # ---------- ein Lauf ----------
    def felder(self, t0, dbz0, where):
        """{Minuten: dBZ-Feld auf dem DWD-Gitter} für +5 … +120 oder None (dann WN)."""
        start = time.time()
        self.bewegung = None
        if self.gebiet is None:
            self.gebiet = Gebiet(where, dbz0.shape, *self.home)
            self._ruc_laden()
        try:
            self.ruc_holen(t0)
        except Exception as e:
            self.log("Vorhersage: RUC holen fehlgeschlagen:", repr(e))
            self.ruc_versuch = time.time()
        t_ruc = time.time() - start

        for k in range(1, prognose.ZURUECK):            # liegen meist schon in /data/past (auch nach einem Neustart)
            self.past_blob(self.cfg, t0 - k * prognose.MIN5)
        fall = Fall(self)
        fall._analyse[t0] = self.gebiet.crop(dbz0)
        e = prognose.Eingang(fall, t0)
        paare = sum(e.analysen[a] is not None and e.analysen[b] is not None for a, b in ((4, 2), (3, 1), (2, 0)))
        if paare < 2:
            self.log(f"Vorhersage: zu wenige Analysen ({paare} von 3 Bildpaaren), nehme DWD")
            return None

        lauf = e.ruc_lauf
        alter = (t0 - lauf).total_seconds() / 60 if lauf else None
        mit_ruc = 0 if lauf is None else sum(RUC_MINUTEN[0] <= alter + 5 * k <= RUC_MINUTEN[-1] for k in range(0, prognose.SCHRITTE + 1)) - 1
        nass = float((e.jetzt() >= self.thr).mean() * 100)
        ruc_nass = lauf is not None and bool((self.ruc[lauf] >= self.thr).any())
        t = time.time()
        if nass == 0 and not ruc_nass:
            v = None
            art = "trocken, nicht gerechnet"
        else:
            v = prognose.DA50(e)
            art = "DA50" if mit_ruc > 0 else "A (ohne RUC)"
            self.bewegung = e.merke("v_radar", lambda: None)
        rechnen = time.time() - t
        ruc_txt = f"RUC {lauf:%H}Z ({alter:.0f} min alt, {max(mit_ruc, 0)}/24 Schritte)" if lauf else "RUC fehlt"
        self.log(f"Vorhersage: eigen {art}, {ruc_txt}, Regenfläche {nass:.1f} %, Rechnen {rechnen:.2f} s, "
                 f"gesamt {time.time() - start:.1f} s (RUC {t_ruc:.1f} s)")

        g = self.gebiet
        out = {}
        for k in range(prognose.SCHRITTE):
            f = np.full(dbz0.shape, prognose.TROCKEN, np.float32)
            if v is not None:
                f[g.r0:g.r1, g.c0:g.c1] = v[k]
            out[(k + 1) * 5] = f
        return out

    def ruc_regen(self, t0, kasten, maske=None, min_km2=0):
        """Zeigt der RUC-Lauf für t0 im Kasten (Zeilen r0:r1, Spalten c0:c1 im DWD-Gitter, z. B. der Wand-Ausschnitt; maske: DWD-Pixel
        darin, die zählen) zwischen t0 und t0 + 120 min in einem Schritt mehr als min_km2 Echo ≥ rain_threshold_dbz? None ohne RUC-Lauf.
        Rohwerte des Modells (ohne Angleichen), 15-min-Schritte, 2 km (je Zelle 4 km²)."""
        if self.gebiet is None:
            return None
        ok = [r for r in self.ruc if r + dt.timedelta(minutes=RUC_VERZUG) <= t0]
        if not ok:
            return None
        lauf = max(ok)
        alter = (t0 - lauf).total_seconds() / 60
        sel = [i for i, m in enumerate(RUC_MINUTEN) if alter - 15 < m < alter + 120 + 15]
        if not sel:
            return None
        g, (r0, r1, c0, c1) = self.gebiet, kasten
        rr0, rr1 = max(0, (r0 - g.r0) // 2), max(0, (r1 - g.r0 + 1) // 2)
        cc0, cc1 = max(0, (c0 - g.c0) // 2), max(0, (c1 - g.c0 + 1) // 2)
        nass = self.ruc[lauf][sel, rr0:rr1, cc0:cc1] >= self.thr
        if maske is not None:                    # Maske (1 km) auf 2 km: Zelle zählt, wenn eines ihrer Pixel im Bild liegt
            m = np.zeros(nass.shape[1:], bool)
            yy, xx = np.nonzero(maske[:(r1 - r0), :(c1 - c0)])
            yy, xx = (yy + r0 - g.r0) // 2 - rr0, (xx + c0 - g.c0) // 2 - cc0
            ok = (yy >= 0) & (yy < m.shape[0]) & (xx >= 0) & (xx < m.shape[1])
            m[yy[ok], xx[ok]] = True
            nass &= m
        return bool(nass.reshape(len(sel), -1).sum(axis=1).max() * 4 >= max(min_km2, 1))

    # ---------- ICON-D2-RUC ----------
    def ruc_holen(self, t0):
        """Den RUC-Lauf holen, den die Radarzeit t0 braucht (RUC_VERZUG nach Laufbeginn), sofern noch nicht da. Fehlt er beim DWD
        (verspätet), seit 0.20.3 den neuesten vollständigen der letzten RUC_ZURUECK Stunden, wenn er neuer ist als der gehaltene;
        den fälligen weiter alle WIEDERHOLEN s versuchen. Ein Log-Eintrag je verspätetem Lauf, nicht bei jedem Versuch."""
        faellig = (t0 - dt.timedelta(minutes=RUC_VERZUG)).replace(minute=0, second=0, microsecond=0)
        if faellig in self.ruc or time.time() - self.ruc_versuch < WIEDERHOLEN:
            return
        if self.idx is None and not self._index(faellig):
            self.ruc_versuch = time.time()
            return
        gehalten = max(self.ruc) if self.ruc else None
        for k in range(RUC_ZURUECK + 1):
            lauf = faellig - dt.timedelta(hours=k)
            if gehalten is not None and lauf <= gehalten:
                break                            # nichts Neueres als der gehaltene Lauf
            if self._lauf_holen(lauf):
                break
        if faellig not in self.ruc:              # beim nächsten Lauf in ≥ 5 min wieder
            self.ruc_versuch = time.time()
            if self._verspaetet != faellig:
                self._verspaetet = faellig
                ersatz = max(self.ruc) if self.ruc else None
                self.log(f"Vorhersage: RUC-Lauf {faellig:%H}Z fehlt beim DWD noch (verspätet), "
                         + (f"nehme {ersatz:%H}Z" if ersatz else "kein älterer Lauf da, rechne ohne RUC") + "; versuche ihn alle 5 min wieder")

    def _index(self, lauf):
        """Zuordnung Dreieck → Gitter laden oder einmal berechnen (CLAT/CLON eines Laufs)."""
        t = time.time()
        g = self.gebiet
        p = os.path.join(self.cfg["data_dir"], f"ruc_index_{g.r0}_{g.c0}_{GROESSE}.npy")
        if os.path.exists(p):
            self.idx = np.load(p)
            return True
        for k in range(RUC_ZURUECK + 1):
            clat, clon = ruc_get("CLAT", lauf - dt.timedelta(hours=k), 0), ruc_get("CLON", lauf - dt.timedelta(hours=k), 0)
            if clat is not None and clon is not None:
                self.idx = ruc_index(g, lies_grib(clat), lies_grib(clon))
                np.save(p, self.idx)
                self.log(f"Vorhersage: RUC-Gitterzuordnung berechnet ({time.time() - t:.0f} s)")
                return True
        return False

    def _lauf_holen(self, lauf):
        """Alle RUC_MINUTEN-Felder eines Laufs holen; False, solange er beim DWD nicht vollständig ist."""
        t = time.time()
        felder = []
        for m in RUC_MINUTEN:
            b = ruc_get("DBZ_CMAX", lauf, m)
            if b is None:
                return False
            v = lies_grib(b)[self.idx]
            felder.append(np.maximum(np.nan_to_num(v, nan=prognose.TROCKEN), prognose.TROCKEN))
        c = kodieren(np.array(felder, np.float32))     # 0,5-dB-Stufen wie in der Messung (Ergebnis gleich, Datei klein)
        neuester = max([lauf] + list(self.ruc))
        self.ruc = {k: v for k, v in self.ruc.items() if k > neuester - RUC_HALTEN}
        self.ruc[lauf] = dekodieren(c)
        self._ruc_speichern(lauf, c)
        self.log(f"Vorhersage: RUC-Lauf {lauf:%H}Z geholt ({len(felder)} Schritte, {time.time() - t:.1f} s)")
        return True

    def _ruc_speichern(self, lauf, c):
        os.makedirs(self.ordner, exist_ok=True)
        p = os.path.join(self.ordner, lauf.strftime("%Y%m%d_%H") + ".npz")
        np.savez_compressed(p + ".part.npz", dbz=c, gebiet=np.array([self.gebiet.r0, self.gebiet.c0]))
        os.replace(p + ".part.npz", p)
        for f in os.listdir(self.ordner):                # nur die letzten Läufe behalten
            try:
                t = dt.datetime.strptime(f[:11], "%Y%m%d_%H").replace(tzinfo=UTC)
            except ValueError:
                continue
            if t <= lauf - RUC_HALTEN:
                os.remove(os.path.join(self.ordner, f))

    def _ruc_laden(self):
        """Nach einem Neustart die gespeicherten Läufe übernehmen (nur, wenn sie zum selben Rechengebiet gehören)."""
        if not os.path.isdir(self.ordner):
            return
        for f in sorted(os.listdir(self.ordner)):
            try:
                lauf = dt.datetime.strptime(f[:11], "%Y%m%d_%H").replace(tzinfo=UTC)
                z = np.load(os.path.join(self.ordner, f))
                if list(z["gebiet"]) == [self.gebiet.r0, self.gebiet.c0] and len(z["dbz"]) == len(RUC_MINUTEN):
                    self.ruc[lauf] = dekodieren(z["dbz"])
            except Exception:
                continue
        if self.ruc:
            self.log("Vorhersage: RUC-Läufe aus /data übernommen:", ", ".join(f"{k:%d.%m. %H}Z" for k in sorted(self.ruc)))
