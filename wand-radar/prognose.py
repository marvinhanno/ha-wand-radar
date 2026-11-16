"""Eigene Regenvorhersage DA50 (Plan: plaene/wand-radar-prognose/PLAN.md im privaten Konfig-Repo, „Entscheidungen 0d“).

DA50 = A (dichtes Bewegungsfeld aus den letzten Radar-Analysen, konstant, Rückwärts-Verschiebung, Drehung bleibt)
+ ICON-D2-RUC eingemischt, Gewicht linear 0 → 0,5 bei +120 min, RUC vorher per Quantil-Abgleich an das Radar angeglichen.
Ergebnis: np.ndarray (24, Zeilen, Spalten) in dBZ für +5 … +120 min. Nur numpy/cv2.

Schlanke Kopie von werkzeuge/radar-prognose/kandidaten.py (Mess-Werkzeug, dort die Quelle): nur die Teile für DA50,
die Funktionen wörtlich übernommen. Einzige Abweichung: Eingang liest nur die Analysen 0 … 20 min zurück (mehr braucht A nicht).
Erwartet von e.fall: analyse(t), ruc_lauf_fuer(t0), ruc_dbz(lauf, t).
"""
import datetime as dt

import cv2
import numpy as np

TROCKEN = -10.0          # dBZ für „kein Echo“ (wie read_h5 in der App)

SCHRITTE = 24            # 24 × 5 min = +120 min
SUB = 2                  # Teilschritte je 5 min beim Rückwärtsverfolgen (gekrümmte Bahnen)
NASS = 10.0              # dBZ ab der ein Pixel als Echo für die Bewegungsschätzung zählt
MIN5 = dt.timedelta(minutes=5)
ZURUECK = 5              # Analysen t0, t0 − 5 … t0 − 20 min (Paare in bewegung_radar)


class Eingang:
    """Alles, was ein Kandidat zur Radarzeit t0 wissen darf (nichts aus der Zukunft)."""

    def __init__(self, fall, t0):
        self.fall, self.t0 = fall, t0
        self.analysen = {k: fall.analyse(t0 - k * MIN5) for k in range(0, ZURUECK)}    # k = Schritte zurück
        self.ruc_lauf = fall.ruc_lauf_fuer(t0)
        self._cache = {}

    def jetzt(self):
        return self.analysen[0]

    def ruc(self, k):
        """RUC-dBZ zur Zeit t0 + k·5 min aus dem verfügbaren Lauf (None ohne Lauf)."""
        return None if self.ruc_lauf is None else self.fall.ruc_dbz(self.ruc_lauf, self.t0 + k * MIN5)

    def merke(self, key, fn):
        if key not in self._cache:
            self._cache[key] = fn()
        return self._cache[key]


# ---------- Bausteine ----------
def norm8(d):
    return (np.clip((d - 5) / 50, 0, 1) * 255).astype(np.uint8)      # wie norm() in der App


def halb(d):
    return cv2.resize(d, (d.shape[1] // 2, d.shape[0] // 2), interpolation=cv2.INTER_AREA)


_DIS = None


def fluss(a, b):
    """Optischer Fluss a → b auf 2 km (DIS aus OpenCV), in 2-km-Pixeln je Bildabstand, dazu Gewicht (Echo in beiden Bildern)."""
    global _DIS
    if _DIS is None:
        _DIS = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    a2, b2 = halb(a), halb(b)
    f = _DIS.calc(norm8(a2), norm8(b2), None)
    w = cv2.dilate(((a2 > NASS) | (b2 > NASS)).astype(np.uint8), np.ones((5, 5), np.uint8)).astype(np.float32)
    return f, w


def glaetten(f, w, sigma=12):
    """Bewegungsfeld glätten und trockene Flächen aus der Umgebung füllen (normierte Faltung, dann gröber, dann Mittelwert)."""
    out = np.empty_like(f)
    sigma2 = min(sigma * 4, 60)          # größere Kerne als das Bild liefern bei OpenCV Unsinn
    g1, g2 = cv2.GaussianBlur(w, (0, 0), sigma), cv2.GaussianBlur(w, (0, 0), sigma2)
    a1, a2 = np.clip(g1 * 8, 0, 1), np.clip(g2 * 8, 0, 1)
    for c in range(2):
        fw = f[..., c] * w
        v1 = cv2.GaussianBlur(fw, (0, 0), sigma) / np.maximum(g1, 1e-6)
        v2 = cv2.GaussianBlur(fw, (0, 0), sigma2) / np.maximum(g2, 1e-6)
        m = fw.sum() / max(w.sum(), 1e-6)
        out[..., c] = a1 * v1 + (1 - a1) * (a2 * v2 + (1 - a2) * m)
    return out


def bewegung_radar(e, paare=((4, 2), (3, 1), (2, 0))):
    """Bewegungsfeld aus den letzten Analysen: Paare im Abstand 10 min (Schritte zurück), gemittelt, je 5 min."""
    def rechnen():
        fs, ws = [], []
        for a, b in paare:
            if e.analysen[a] is None or e.analysen[b] is None:
                continue
            f, w = fluss(e.analysen[a], e.analysen[b])
            fs.append(f / (a - b) * w[..., None])
            ws.append(w)
        if not ws:
            return np.zeros(halb(e.jetzt()).shape + (2,), np.float32)
        w = np.sum(ws, axis=0)
        return glaetten(np.sum(fs, axis=0) / np.maximum(w, 1e-6)[..., None], np.minimum(w, 1))
    return e.merke("v_radar", rechnen)


def _gitter(shape):
    gx, gy = np.meshgrid(np.arange(shape[1], dtype=np.float32), np.arange(shape[0], dtype=np.float32))
    return gx, gy


def verschiebungen(v_fuer, schritte=SCHRITTE):
    """Rückwärts-Verschiebung je Vorhersageschritt k (1 … schritte) auf 2 km: D_k(x) = x − Herkunft.
    v_fuer(j) = Bewegungsfeld im Intervall (j−1, j] (2-km-Pixel je 5 min). Ein konstantes Feld wird nur einmal verfolgt."""
    v0 = v_fuer(1)
    gx, gy = _gitter(v0.shape[:2])
    konstant = all(v_fuer(j) is v0 for j in range(2, schritte + 1))
    out = []
    if konstant:
        D = np.zeros_like(v0)
        for _ in range(schritte):
            for _ in range(SUB):
                vx = cv2.remap(v0[..., 0], gx - D[..., 0], gy - D[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
                vy = cv2.remap(v0[..., 1], gx - D[..., 0], gy - D[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
                D = D + np.dstack([vx, vy]) / SUB
            out.append(D.copy())
        return out
    for k in range(1, schritte + 1):         # zeitabhängig: für jedes Ziel k von k bis 0 zurückgehen
        D = np.zeros_like(v0)
        for j in range(k, 0, -1):
            v = v_fuer(j)
            for _ in range(SUB):
                vx = cv2.remap(v[..., 0], gx - D[..., 0], gy - D[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
                vy = cv2.remap(v[..., 1], gx - D[..., 0], gy - D[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
                D = D + np.dstack([vx, vy]) / SUB
        out.append(D)
    return out


def verlagern(feld, Ds):
    """Radarfeld (1 km) mit den 2-km-Verschiebungen Ds verschieben."""
    gx, gy = _gitter(feld.shape)
    out = []
    for D in Ds:
        D1 = cv2.resize(D, (feld.shape[1], feld.shape[0]), interpolation=cv2.INTER_LINEAR) * 2
        out.append(cv2.remap(feld, gx - D1[..., 0], gy - D1[..., 1], cv2.INTER_LINEAR, borderValue=TROCKEN))
    return np.array(out)


# ---------- DA50 ----------
def A(e):
    """Konstantes, aber ortsabhängiges Bewegungsfeld aus dem Radar – gekrümmte Bahnen, Drehung bleibt."""
    def rechnen():
        v = bewegung_radar(e)
        return verlagern(e.jetzt(), verschiebungen(lambda j: v))
    return e.merke("A", rechnen)


# --- DA50: RUC zunehmend eingemischt ---
BODEN = 5.0      # dBZ-Untergrenze beim Mischen (darunter gilt als trocken)


def quantil_abgleich(ruc0, radar0):
    """Abbildung RUC-dBZ → Radar-dBZ über die Werteverteilung zur Zeit t0 (im ganzen Rechengebiet)."""
    q = np.linspace(0, 100, 201)
    a, b = np.percentile(ruc0, q), np.percentile(radar0, q)
    a = np.maximum.accumulate(a + np.arange(len(a)) * 1e-6)
    return lambda x: np.interp(x, a, b).astype(np.float32)


def mit_ruc(basis_fn, ende=0.5, name=None):
    """Mischen oberhalb von BODEN (ein Echo gegen „trocken“ ergibt kein Loch), danach Werteverteilung = Mischung der Verteilungen
    von Basis und angeglichenem RUC (so wächst/schrumpft die Regenfläche, wie RUC es vorhersagt, ohne dass sie ausfranst)."""
    def kandidat(e):
        basis = basis_fn(e)
        r0 = e.ruc(0)
        if r0 is None:
            return basis
        abb = quantil_abgleich(r0, e.jetzt())
        out = []
        for k in range(SCHRITTE):
            r = e.ruc(k + 1)
            if r is None:
                out.append(basis[k])
                continue
            w = ende * (k + 1) / SCHRITTE
            b, m = np.maximum(basis[k], BODEN), np.maximum(abb(r), BODEN)
            f = (1 - w) * b + w * m
            ziel = (1 - w) * np.sort(b.ravel()) + w * np.sort(m.ravel())
            f = ziel[np.argsort(np.argsort(f.ravel()))].reshape(f.shape)
            out.append(np.where(f <= BODEN, TROCKEN, f).astype(np.float32))
        return np.array(out)
    kandidat.__name__ = name or f"D_{basis_fn.__name__}_{int(ende * 100)}"
    kandidat.__doc__ = f"{basis_fn.__name__} mit RUC (Quantil-Abgleich), Gewicht linear bis {ende} bei +120 min"
    return kandidat


DA50 = mit_ruc(A, 0.5, "DA50")

ALLE = {"A": A, "DA50": DA50}
