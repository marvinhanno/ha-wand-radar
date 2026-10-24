"""Vorhersage-Kandidaten (Plan: plaene/wand-radar-prognose/PLAN.md, Abschnitt „Kandidaten“).

Jeder Kandidat: kandidat(e: Eingang) -> np.ndarray (24, Zeilen, Spalten) in dBZ für +5 … +120 min.
Nur numpy/cv2 (pysteps gibt es nur als Quellpaket mit C/OpenMP-Teilen, siehe messung.md).
Bewegung auf 2 km (halbe Auflösung), Verschiebung des Radarbilds auf 1 km, immer rückwärts (Semi-Lagrange).

Dieselbe Datei liegt als prognose.py in der App (../ha-wand-radar/wand-radar/) – nur hier ändern und dorthin kopieren.
Erwartet von e.fall: analyse(t), ruc_lauf_fuer(t0), ruc_dbz(lauf, t), für WN zusätzlich wn(t0).
"""
import datetime as dt

import cv2
import numpy as np

TROCKEN = -10.0          # dBZ für „kein Echo“ (wie read_h5 in der App)

SCHRITTE = 24            # 24 × 5 min = +120 min
SUB = 2                  # Teilschritte je 5 min beim Rückwärtsverfolgen (gekrümmte Bahnen)
NASS = 10.0              # dBZ ab der ein Pixel als Echo für die Bewegungsschätzung zählt
MIN5 = dt.timedelta(minutes=5)


class Eingang:
    """Alles, was ein Kandidat zur Radarzeit t0 wissen darf (nichts aus der Zukunft)."""

    def __init__(self, fall, t0):
        self.fall, self.t0 = fall, t0
        self.analysen = {k: fall.analyse(t0 - k * MIN5) for k in range(0, 13)}    # k = Schritte zurück (0 … 60 min)
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


# ---------- Kandidaten ----------
def P(e):
    """Persistenz: das Bild von jetzt bleibt stehen (Unterkante)."""
    return np.repeat(e.jetzt()[None], SCHRITTE, axis=0)


def WN(e):
    """DWD-Vorhersage (heutiger Stand). Als Liste: aus dem App-Archiv gibt es nur +30/+60/+120 min, der Rest ist None."""
    return e.fall.wn(e.t0)


def A(e):
    """Konstantes, aber ortsabhängiges Bewegungsfeld aus dem Radar – gekrümmte Bahnen, Drehung bleibt."""
    def rechnen():
        v = bewegung_radar(e)
        return verlagern(e.jetzt(), verschiebungen(lambda j: v))
    return e.merke("A", rechnen)


def bewegung_ruc(e):
    """Bewegungsfelder aus aufeinanderfolgenden RUC-Bildern (15 min Abstand), je 5 min, Mitte des Intervalls bei t0 + (k+1,5)·5 min."""
    def rechnen():
        feld = {k: e.ruc(k) for k in range(-3, SCHRITTE + 4, 3)}
        vs = {}
        for k in range(-3, SCHRITTE + 1, 3):
            if feld.get(k) is None or feld.get(k + 3) is None:
                continue
            f, w = fluss(feld[k], feld[k + 3])
            vs[k + 1.5] = glaetten(f / 3, w)
        return vs
    return e.merke("v_ruc", rechnen)


def A2(e):
    """Wie A, das Feld ändert sich aber mit der Zeit so, wie es sich im RUC ändert: v(k) = v_radar + (v_ruc(k) − v_ruc(0))."""
    def rechnen():
        v0 = bewegung_radar(e)
        vs = bewegung_ruc(e)
        if len(vs) < 2:
            return A(e)
        mitten = np.array(sorted(vs))
        stapel = np.array([vs[m] for m in mitten])

        def v_ruc(k):          # zwischen den Intervallmitten linear, außen festhalten
            k = np.clip(k, mitten[0], mitten[-1])
            i = min(np.searchsorted(mitten, k, side="right") - 1, len(mitten) - 2)
            f = (k - mitten[i]) / (mitten[i + 1] - mitten[i])
            return stapel[i] * (1 - f) + stapel[i + 1] * f
        basis = v_ruc(0)
        felder = {j: (v0 + (v_ruc(j - 0.5) - basis)).astype(np.float32) for j in range(1, SCHRITTE + 1)}
        return verlagern(e.jetzt(), verschiebungen(lambda j: felder[j]))
    return e.merke("A2", rechnen)


# --- B: Zerfall je nach Größe (S-PROG-Art, ohne pysteps) ---
BODEN = 5.0      # dBZ-Untergrenze für die Skalenzerlegung (darunter gilt als trocken)
EBENEN = 8       # Skalen 500 … 4 km (Faktor 2)
_FILTER = {}


def _filter(shape):
    """Gaussche Bandpässe über log2(Wellenzahl), Summe je Wellenzahl = 1."""
    if shape not in _FILTER:
        ky = np.fft.fftfreq(shape[0]) * shape[0]
        kx = np.fft.rfftfreq(shape[1]) * shape[1]
        k = np.sqrt(ky[:, None] ** 2 * (shape[1] / shape[0]) ** 2 + kx[None, :] ** 2)
        lk = np.log2(np.maximum(k, 0.5))
        w = np.array([np.exp(-(lk - l) ** 2 / (2 * 0.6 ** 2)) for l in range(EBENEN)])
        w[0][k < 1] = 1
        w[1:, k < 1] = 0
        _FILTER[shape] = w / w.sum(axis=0)
    return _FILTER[shape]


def zerlegen(feld):
    F = np.fft.rfft2(feld)
    return np.array([np.fft.irfft2(F * w, s=feld.shape) for w in _filter(feld.shape)]).astype(np.float32)


def rho_ebenen(e, D2):
    """Lagrange-Autokorrelation je Skala über 10 min: Analyse t0−10 mit der Bewegung verschoben gegen t0, auf 5 min umgerechnet."""
    alt = e.analysen[2]
    if alt is None:
        return np.full(EBENEN, 0.95)
    vorher = zerlegen(np.maximum(verlagern(alt, [D2])[0], BODEN))
    jetzt = zerlegen(np.maximum(e.jetzt(), BODEN))
    r = []
    for a, b in zip(vorher, jetzt):
        a, b = a - a.mean(), b - b.mean()
        c = float((a * b).sum() / max(np.sqrt((a * a).sum() * (b * b).sum()), 1e-9))
        r.append(np.sqrt(np.clip(c, 0.01, 0.9999)))
    r = np.array(r)
    r[0] = 1.0             # größte Skala (Mittelwert) bleibt
    return r


def zerfall(e, basis, Ds, cdf=False):
    rho = rho_ebenen(e, Ds[1])
    out = []
    for k in range(SCHRITTE):
        lv = zerlegen(np.maximum(basis[k], BODEN))
        f = np.tensordot(rho ** (k + 1), lv, axes=1)
        if cdf:             # Werteverteilung der reinen Verschiebung übernehmen (Regenfläche bleibt, Muster wird weicher)
            ziel = np.sort(basis[k].ravel())
            rang = np.argsort(np.argsort(f.ravel()))
            f = ziel[rang].reshape(f.shape)
        out.append(np.where(f < BODEN, TROCKEN, f).astype(np.float32))
    return np.array(out)


def B(e):
    """A + kleine Skalen verlieren mit der Zeit an Gewicht (Vorhersage wird weicher und schwächer)."""
    def rechnen():
        v = bewegung_radar(e)
        Ds = verschiebungen(lambda j: v)
        return zerfall(e, A(e), Ds)
    return e.merke("B", rechnen)


def Bm(e):
    """Wie B, aber mit der Werteverteilung von A (Fläche und Stärken bleiben, nur das Muster wird weicher)."""
    def rechnen():
        v = bewegung_radar(e)
        Ds = verschiebungen(lambda j: v)
        return zerfall(e, A(e), Ds, cdf=True)
    return e.merke("Bm", rechnen)


# --- D: RUC zunehmend eingemischt ---
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


D = mit_ruc(A2, 0.5, "D")

ALLE = {"WN": WN, "P": P, "A": A, "A2": A2, "B": B, "Bm": Bm, "D": D}
VARIANTEN = {"D25": mit_ruc(A2, 0.25, "D25"), "D75": mit_ruc(A2, 0.75, "D75"), "D_B": mit_ruc(B, 0.5, "D_B"),
             "D_Bm": mit_ruc(Bm, 0.5, "D_Bm")}
