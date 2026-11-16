"""Eigene Regenvorhersage DA50 im Radar-Lauf (Option prognose: eigen | dwd, seit 0.19.0).

Je Lauf, im Rechengebiet ≈ 500 × 500 km um Zuhause (archiv.Gebiet):
- Analysen t0 … t0 − 20 min aus /data/past (fehlende einzeln vom DWD nachgeladen wie die Vergangenheit des Videos),
- ICON-D2-RUC DBZ_CMAX, stündlicher Lauf, nur Laufbeginn + 30 … 225 min (14 Felder), auf 2 km; die Zuordnung Dreieck → Gitter liegt
  einmal berechnet in /data, der letzte Lauf kompakt in /data/ruc (übersteht einen Neustart),
- prognose.DA50 → Felder +5 … +120 min. Fehlt RUC, rechnet DA50 nur mit dem Radar-Bewegungsfeld (A).
Sparsam: kein Echo ≥ rain_threshold_dbz im Rechengebiet und RUC dort ohne Regen → nichts rechnen, alle Felder trocken.
felder() gibt None zurück (Grund im Log), wenn die eigene Vorhersage nicht geht; dann nimmt der Lauf die DWD-Vorhersage (WN).
Seit 0.20.0 für das Video: bewegung (Bewegungsfeld des letzten Laufs, daraus die Zwischenbilder der Vorhersage) und
ruc_regen() (zeigt RUC im Wand-Ausschnitt Regen in 2 h? – Teil der Regel „trocken = kein Video“).
"""
import datetime as dt
import os
import time

import numpy as np

import archiv
import prognose

# Fest (Tor R1, 16.11.2026; Länge nachgerechnet): nur so weit, wie die +2-h-Vorhersage braucht, über 2 h rechnet HA mit met.no.
# Der Lauf ist bei t0 schon 40 … 100 min alt (verfügbar ≈ RUC_VERZUG nach Beginn) → gebraucht wird Beginn + 30 … ≈ 220 min.
RUC_MINUTEN = range(30, 226, 15)
RUC_HALTEN = dt.timedelta(hours=3)
WIEDERHOLEN = 300                     # s bis zum nächsten Versuch, wenn ein RUC-Lauf fehlt oder unvollständig ist
UTC = dt.timezone.utc


class Vorhersage:
    """Hält Rechengebiet, RUC-Zuordnung und RUC-Läufe zwischen den Läufen. Die Felder für archiv.AppFall/prognose.Eingang:
    cfg, gebiet, read_h5, ruc."""

    def __init__(self, cfg, home, read_h5, past_blob, log):
        self.cfg, self.home, self.read_h5, self.past_blob, self.log = cfg, home, read_h5, past_blob, log
        self.thr = cfg["rain_threshold_dbz"]
        self.ordner = os.path.join(cfg["data_dir"], "ruc")
        self.gebiet, self.idx = None, None
        self.ruc = {}                    # Laufbeginn -> (14, h/2, w/2) dBZ, erstes Feld = Laufbeginn + RUC_MINUTEN[0]
        self.ruc_ab_min = RUC_MINUTEN[0]  # für archiv.AppFall.ruc_dbz
        self.ruc_versuch = 0.0
        self.bewegung = None             # Bewegungsfeld des letzten Laufs (2 km, Rechengebiet, 2-km-Pixel je 5 min) oder None

    # ---------- ein Lauf ----------
    def felder(self, t0, dbz0, where):
        """{Minuten: dBZ-Feld auf dem DWD-Gitter} für +5 … +120 oder None (dann WN)."""
        start = time.time()
        self.bewegung = None
        if self.gebiet is None:
            self.gebiet = archiv.Gebiet(where, dbz0.shape, *self.home)
            self._ruc_laden()
        try:
            self.ruc_holen(t0)
        except Exception as e:
            self.log("Vorhersage: RUC holen fehlgeschlagen:", repr(e))
            self.ruc_versuch = time.time()
        t_ruc = time.time() - start

        for k in range(1, prognose.ZURUECK):            # liegen meist schon in /data/past (auch nach einem Neustart)
            self.past_blob(self.cfg, t0 - k * prognose.MIN5)
        fall = archiv.AppFall(self)
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
        ok = [r for r in self.ruc if r + dt.timedelta(minutes=archiv.RUC_VERZUG) <= t0]
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
        """Den RUC-Lauf holen, den die Radarzeit t0 braucht (archiv.RUC_VERZUG nach Laufbeginn), sofern noch nicht da."""
        lauf = (t0 - dt.timedelta(minutes=archiv.RUC_VERZUG)).replace(minute=0, second=0, microsecond=0)
        if lauf in self.ruc or time.time() - self.ruc_versuch < WIEDERHOLEN:
            return
        t = time.time()
        if self.idx is None:
            g = self.gebiet
            p = os.path.join(self.cfg["data_dir"], f"ruc_index_{g.r0}_{g.c0}_{archiv.GROESSE}.npy")   # derselbe wie im Archiv
            if os.path.exists(p):
                self.idx = np.load(p)
            else:
                clat, clon = archiv.ruc_get("CLAT", lauf, 0), archiv.ruc_get("CLON", lauf, 0)
                if clat is None or clon is None:
                    self.ruc_versuch = time.time()
                    return
                self.idx = archiv.ruc_index(g, archiv.lies_grib(clat), archiv.lies_grib(clon))
                np.save(p, self.idx)
                self.log(f"Vorhersage: RUC-Gitterzuordnung berechnet ({time.time() - t:.0f} s)")
        felder = []
        for m in RUC_MINUTEN:
            b = archiv.ruc_get("DBZ_CMAX", lauf, m)
            if b is None:                        # Lauf noch nicht vollständig: beim nächsten Lauf in ≥ 5 min wieder
                self.ruc_versuch = time.time()
                return
            v = archiv.lies_grib(b)[self.idx]
            felder.append(np.maximum(np.nan_to_num(v, nan=prognose.TROCKEN), prognose.TROCKEN))
        c = archiv.kodieren(np.array(felder, np.float32))     # 0,5-dB-Stufen wie in der Messung (Ergebnis gleich, Datei klein)
        self.ruc = {k: v for k, v in self.ruc.items() if k > lauf - RUC_HALTEN}
        self.ruc[lauf] = archiv.dekodieren(c)
        self._ruc_speichern(lauf, c)
        self.log(f"Vorhersage: RUC-Lauf {lauf:%H}Z geholt ({len(felder)} Schritte, {time.time() - t:.1f} s)")

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
                    self.ruc[lauf] = archiv.dekodieren(z["dbz"])
            except Exception:
                continue
        if self.ruc:
            self.log("Vorhersage: RUC-Läufe aus /data übernommen:", ", ".join(f"{k:%d.%m. %H}Z" for k in sorted(self.ruc)))
