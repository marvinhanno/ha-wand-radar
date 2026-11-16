#!/usr/bin/env python3
"""Wand-Radar: rechnet das DWD-Regenradar (WN-Komposit, 1 km, 5 min) zu fertigen Wand-Hintergründen.

Vorhersage +5 … +120 min: eigene (DA50, vorhersage.py/prognose.py, Option prognose: eigen) oder die des DWD (WN, prognose: dwd
und Rückweg bei jedem Fehler der eigenen).

Ausgabe in output_dir:
  still.jpg   Karte + Radar "jetzt"
  still_panel.jpg   dasselbe in klein für ein Bedienpanel (nur mit panel_width/panel_height, eigener Zoom möglich)
  radar.mp4   H.264, -past_minutes … +120 min, je 5-min-Schritt 4 berechnete Zwischenbilder – seit 0.20.0 nur bei Regen im
              Wand-Ausschnitt (trocken: meta.json video: false, kein Video; button.wand_radar_video rechnet es auf Abruf)
  meta.json   Zeiten, Verlauf am Zuhause-Punkt, Regenbeginn
Dazu per MQTT der Sensor "Wand-Radar Regen ab" (sensor.wand_radar_regen_ab) und seit 0.20.0 der Knopf button.wand_radar_video.
"""
import datetime as dt
import io
import json
import math
import os
import resource
import subprocess
import sys
import tarfile
import threading
import time
import zlib
from zoneinfo import ZoneInfo

import cv2
import h5py
import imageio_ffmpeg
import numpy as np
import requests
from PIL import Image
from pyproj import Transformer

import archiv
import route
import vorhersage

DWD = "https://opendata.dwd.de/weather/radar/composite/wn/"
ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/"
SUPERVISOR = "http://supervisor"
STEP = 5          # Minuten zwischen zwei DWD-Bildern
SUB = 5           # Unterteilung je Schritt (= 4 Zwischenbilder)
POLL = 60         # Sekunden zwischen zwei Prüfungen auf neue Daten
STALE_AFTER = 30 * 60   # ohne neue Daten: Sensor "nicht verfügbar"
REGEN_KM2 = 20          # ab so viel Echo ≥ rain_threshold_dbz im Wand-Ausschnitt gilt er als nass (kleiner: Störflecken, kein Video)
UA = {"User-Agent": "ha-wand-radar/0.1 (Home Assistant add-on)"}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def cpu_s():
    """Verbrauchte CPU-Zeit dieses Prozesses samt beendeter Kindprozesse (ffmpeg) in s – das Maß für den Strom, nicht die Wandzeit."""
    a, b = resource.getrusage(resource.RUSAGE_SELF), resource.getrusage(resource.RUSAGE_CHILDREN)
    return a.ru_utime + a.ru_stime + b.ru_utime + b.ru_stime


# ---------- Konfiguration ----------
def load_config():
    """Add-on-Optionen aus /data/options.json, lokal aus Umgebungsvariablen (WR_*)."""
    cfg = dict(zoom=9, width=1366, height=1024, past_minutes=60, fps=18, rain_threshold_dbz=14,
               timezone="Europe/Berlin", preset="veryfast", output_dir="out", latitude=None, longitude=None,
               panel_width=0, panel_height=0, panel_zoom=0, archiv_tage=0, prognose_test=False, prognose="eigen")
    if os.path.exists("/data/options.json"):
        cfg.update({k: v for k, v in json.load(open("/data/options.json")).items() if v is not None})
    for k in cfg:
        env = os.environ.get("WR_" + k.upper())
        if env:
            cfg[k] = (env.lower() in ("1", "true", "ja")) if isinstance(cfg[k], bool) else type(cfg[k])(env) if cfg[k] is not None else float(env)
    cfg["data_dir"] = os.environ.get("WR_DATA_DIR", "/data" if os.path.isdir("/data") else "cache")
    return cfg


def sup_get(path):
    r = requests.get(SUPERVISOR + path, headers={"Authorization": "Bearer " + os.environ["SUPERVISOR_TOKEN"]}, timeout=15)
    r.raise_for_status()
    return r.json()


def home_position(cfg):
    if cfg["latitude"] is not None and cfg["longitude"] is not None:
        return float(cfg["latitude"]), float(cfg["longitude"])
    a = route.ha_get("/states/zone.home")["attributes"]          # sonst: Zone "Zuhause" aus HA (lokal über HA_URL/HA_TOKEN)
    return float(a["latitude"]), float(a["longitude"])


# ---------- Zwischenspeicher & Downloads ----------
def cached(path, url):
    if not os.path.exists(path):
        r = requests.get(url, headers=UA, timeout=60)
        r.raise_for_status()
        tmp = path + ".part"
        open(tmp, "wb").write(r.content)
        os.replace(tmp, path)
    return open(path, "rb").read()


def tar_members(blob):
    t = tarfile.open(fileobj=io.BytesIO(blob))
    return {m.name: t.extractfile(m).read() for m in t.getmembers() if m.isfile()}


def tag_of(t):
    return t.strftime("%Y%m%d_%H%M")


def past_blob(cfg, t):
    """Analysebild (_000) des Laufs um t. Einmal geholt, danach nur noch aus dem Zwischenspeicher."""
    p = os.path.join(cfg["data_dir"], "past", f"{tag_of(t)}.h5")
    if os.path.exists(p):
        return open(p, "rb").read()
    try:
        m = tar_members(fetch_tar(f"{DWD}composite_wn_{tag_of(t)}.tar"))
    except Exception as e:
        log("Vergangenheitsbild fehlt:", tag_of(t), e)
        return None
    blob = m[sorted(m)[0]]
    store_past(cfg, t, blob)
    return blob


def fetch_tar(url):
    r = requests.get(url, headers=UA, timeout=60)
    r.raise_for_status()
    return r.content


def store_past(cfg, t, blob):
    d = os.path.join(cfg["data_dir"], "past")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, f"{tag_of(t)}.h5")
    if not os.path.exists(p):
        open(p + ".part", "wb").write(blob)
        os.replace(p + ".part", p)


def clean_past(cfg, t0):
    d = os.path.join(cfg["data_dir"], "past")
    if not os.path.isdir(d):
        return
    for f in os.listdir(d):
        try:
            t = dt.datetime.strptime(f[:13], "%Y%m%d_%H%M").replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
        if t < t0 - dt.timedelta(hours=4):
            os.remove(os.path.join(d, f))


def read_h5(blob):
    f = h5py.File(io.BytesIO(blob), "r")
    d = f["dataset1/data1/data"][()].astype(np.float32)
    w = f["dataset1/data1/what"].attrs
    dbz = d * w["gain"] + w["offset"]
    dbz[(d == w["undetect"]) | (d == w["nodata"])] = -10
    return dbz, d != w["nodata"], dict(f["where"].attrs)


# ---------- Kartenausschnitt (Web-Mercator wie Leaflet) ----------
class Geo:
    def __init__(self, cfg, lat, lon):
        self.cfg, self.lat, self.lon = cfg, lat, lon
        self.z, self.w, self.h = cfg["zoom"], cfg["width"], cfg["height"]
        self.world = 256 * 2 ** self.z
        self.cx, self.cy = self.merc(lat, lon)
        self.left, self.top = self.cx - self.w / 2, self.cy - self.h / 2
        self._maps = None

    def merc(self, lat, lon):
        x = (lon + 180) / 360 * self.world
        s = math.sin(math.radians(lat))
        y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * self.world
        return x, y

    def basemap(self, layer):
        x0, x1 = int(self.left // 256), int((self.left + self.w) // 256)
        y0, y1 = int(self.top // 256), int((self.top + self.h) // 256)
        canvas = Image.new("RGBA", ((x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256))
        tiles = os.path.join(self.cfg["data_dir"], "tiles")
        os.makedirs(tiles, exist_ok=True)
        for tx in range(x0, x1 + 1):
            for ty in range(y0, y1 + 1):
                b = cached(os.path.join(tiles, f"{layer}_{self.z}_{ty}_{tx}.png"),
                           f"{ESRI}{layer}/MapServer/tile/{self.z}/{ty}/{tx}")
                canvas.paste(Image.open(io.BytesIO(b)).convert("RGBA"), ((tx - x0) * 256, (ty - y0) * 256))
        ox, oy = int(round(self.left - x0 * 256)), int(round(self.top - y0 * 256))
        return np.asarray(canvas.crop((ox, oy, ox + self.w, oy + self.h))).astype(np.float32) / 255

    def maps(self):
        if self._maps is None:      # Karte und Beschriftung einmal holen, danach aus dem Zwischenspeicher
            self._maps = (self.basemap("World_Dark_Gray_Base")[..., :3] * 0.5, self.basemap("World_Dark_Gray_Reference"))
        return self._maps


# ---------- Farbskala (feste dBZ-Stützpunkte, dazwischen linear) ----------
STOPS = [  # dBZ, Farbe, Deckkraft   (mm/h nach Z = 200 R^1.6)
    (8, "#3a7bd5", 0.00),
    (14, "#3a7bd5", 0.55),   # ~0,2 mm/h  leicht
    (21, "#2ba8de", 0.80),   # ~0,7
    (28, "#2ec4b6", 0.90),   # ~2
    (34, "#8bd450", 0.95),   # ~5  mäßig
    (40, "#f6d743", 1.00),   # ~12
    (46, "#ff9f1c", 1.00),   # ~25 stark
    (52, "#ff4d4d", 1.00),   # ~60
    (58, "#e040c8", 1.00),   # ~140 Unwetter/Hagel
    (65, "#f3c6ff", 1.00),
]


def build_lut():
    lut = np.zeros((321, 4), np.float32)
    dv = np.linspace(-10, 70, 321)
    hexrgb = lambda h: [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    sd = [s[0] for s in STOPS]
    for ch in range(3):
        lut[:, ch] = np.interp(dv, sd, [hexrgb(s[1])[ch] for s in STOPS])
    lut[:, 3] = np.interp(dv, sd, [s[2] for s in STOPS])
    return lut


LUT = build_lut()


def mm_per_h(dbz):
    return (10 ** (dbz / 10) / 200) ** (1 / 1.6)


def norm(d):
    return (np.clip((d - 5) / 50, 0, 1) * 255).astype(np.uint8)




# ---------- ein Durchlauf ----------
class Scene:
    """Bildausschnitt (Geo) gegen das DWD-Raster: Umprojektion, Grundkarte, Datenrand; compose() färbt ein Radarbild ein."""

    def __init__(self, geo, where, cover):
        W, H = geo.w, geo.h
        # Umprojektion: Bildschirmpixel -> DWD-Raster
        proj = where["projdef"].decode()
        tr = Transformer.from_crs("EPSG:4326", proj, always_xy=True)
        xul, yul = tr.transform(where["UL_lon"], where["UL_lat"])
        ii, jj = np.meshgrid(np.arange(W) + 0.5 + geo.left, np.arange(H) + 0.5 + geo.top)
        lon = ii / geo.world * 360 - 180
        lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * jj / geo.world))))
        px, py = tr.transform(lon, lat)
        col = (px - xul) / 1000 - 0.5
        row = (yul - py) / 1000 - 0.5
        self.c0, self.c1 = int(col.min()) - 40, int(col.max()) + 40      # Ausschnitt, damit Optical Flow schnell bleibt
        self.r0, self.r1 = int(row.min()) - 40, int(row.max()) + 40
        self.mapx = (col - self.c0).astype(np.float32)
        self.mapy = (row - self.r0).astype(np.float32)
        self.gx, self.gy = np.meshgrid(np.arange(self.c1 - self.c0, dtype=np.float32), np.arange(self.r1 - self.r0, dtype=np.float32))
        self.im_bild = np.zeros(self.gx.shape, bool)                 # DWD-Pixel (1 km²), die im Wand-Bild liegen
        self.im_bild[np.round(self.mapy).astype(int), np.round(self.mapx).astype(int)] = True

        base, ref = geo.maps()
        # Datenrand (z. B. IJsselmeer): Radar über ~10 km weich ausblenden, außerhalb die Karte leicht abdunkeln
        cov = cv2.remap(cover[self.r0:self.r1, self.c0:self.c1].astype(np.float32), self.mapx, self.mapy, cv2.INTER_LINEAR, borderValue=0)
        cov = cv2.GaussianBlur(cov, (0, 0), 18)
        fade = np.clip(cov * 2 - 1, 0, 1)[..., None]
        base = base * (0.75 + 0.25 * np.clip(cov * 2, 0, 1)[..., None])
        hx, hy = tr.transform(geo.lon, geo.lat)
        self.hc, self.hr = (hx - xul) / 1000 - 0.5 - self.c0, (yul - hy) / 1000 - 0.5 - self.r0

        la = ref[..., 3:4] * 0.4                                     # Ortsnamen ÜBER dem Radar
        dryf = base * (1 - la) + ref[..., :3] * la                   # Karte ohne Regen
        self.dry = (np.clip(dryf, 0, 1) * 255).astype(np.uint8)
        # Einfärben (seit 0.20.0, Formel wie bis 0.19.0, nur umgestellt):
        #   Bild = (Karte·(1−a) + Farbe·a)·(1−la) + Namen·la, a = Deckkraft(dBZ)·0,9·fade
        #        = Karte_trocken + g·(Deckkraft·Farbe) − Deckkraft·(g·Karte),   g = fade·(1−la) je Pixel
        # Die dBZ-Stufe (0,25 dB) wird ein uint8-Index k (0 = ≤ 8 dBZ = trocken), Deckkraft·Farbe und Deckkraft kommen per cv2.LUT.
        g = (fade * (1 - la)).astype(np.float32)
        self._dryf = (dryf * 255).astype(np.float32)
        self._g3 = np.ascontiguousarray(np.repeat(g, 3, axis=2))
        self._gb = (g * base * 255).astype(np.float32)
        i0 = int(round((STOPS[0][0] + 10) * 4))                      # LUT-Zeile von 8 dBZ
        i = np.minimum(np.arange(256), len(LUT) - 1 - i0) + i0
        deck = LUT[i, 3] * 0.9
        self._lut_farbe = (deck[:, None] * LUT[i, :3] * 255).astype(np.float32).reshape(1, 256, 3)
        self._lut_deck = np.ascontiguousarray(np.repeat(deck.astype(np.float32).reshape(1, 256, 1), 3, axis=2))

    def crop(self, frames):
        return [f[self.r0:self.r1, self.c0:self.c1] for f in frames]

    VOLLBILD_AB = 0.05      # Anteil Regenpixel, ab dem das ganze Bild in OpenCV schneller ist als nur die Regenpixel (gemessen 16.11.2026)

    def compose(self, dbz_crop):
        """Ein Radarbild (dBZ, Ausschnitt) einfärben: Karte darunter, Ortsnamen darüber. Ganz trocken → das fertige Kartenbild
        (dasselbe Objekt, nicht verändern). Seit 0.20.0: bis VOLLBILD_AB nur die Regenpixel, darüber das ganze Bild in OpenCV
        (bei viel Regen ≈ 6–15× schneller als bis 0.19.0), Abweichung ≤ 1/255."""
        if float(dbz_crop.max()) <= STOPS[0][0]:
            return self.dry
        d = cv2.remap(dbz_crop, self.mapx, self.mapy, cv2.INTER_LINEAR, borderValue=-10)
        k = cv2.convertScaleAbs(np.maximum(d, STOPS[0][0]), alpha=4, beta=-4 * STOPS[0][0])     # Stufe über 8 dBZ, 0 … 255
        n = cv2.countNonZero(k)
        if n < self.VOLLBILD_AB * k.size:            # wenig Regen: nur die Regenpixel rechnen (gleiche Formel)
            img = self.dry.copy()
            if n:
                nz = np.flatnonzero(k)
                kk = k.ravel()[nz]
                out = self._dryf.reshape(-1, 3)[nz] + self._g3.reshape(-1, 3)[nz, :1] * self._lut_farbe[0, kk] \
                    - self._lut_deck[0, kk, :1] * self._gb.reshape(-1, 3)[nz]
                img.reshape(-1, 3)[nz] = np.clip(out, 0, 255).astype(np.uint8)
            return img
        k3 = cv2.merge([k, k, k])
        out = cv2.subtract(cv2.add(self._dryf, cv2.multiply(self._g3, cv2.LUT(k3, self._lut_farbe))),
                           cv2.multiply(cv2.LUT(k3, self._lut_deck), self._gb))
        return cv2.convertScaleAbs(out)

    def nass_km2(self, dbz_crop, thr):
        """Fläche in km² mit Echo ≥ thr im Wand-Ausschnitt (genau das Bild des Videos)."""
        if float(dbz_crop.max()) < thr:
            return 0
        return int(np.count_nonzero((dbz_crop >= thr) & self.im_bild))

    def fluss(self, bewegung, gebiet):
        """Bewegungsfeld der eigenen Vorhersage (2 km im Rechengebiet, 2-km-Pixel je 5 min) auf den Ausschnitt (1 km): (fx, fy) oder None."""
        if bewegung is None or gebiet is None:
            return None
        V = cv2.resize(bewegung, (bewegung.shape[1] * 2, bewegung.shape[0] * 2), interpolation=cv2.INTER_LINEAR) * 2   # wie prognose.verlagern
        r0, c0, h, w = self.r0 - gebiet.r0, self.c0 - gebiet.c0, self.r1 - self.r0, self.c1 - self.c0
        if r0 < 0 or c0 < 0 or r0 + h > V.shape[0] or c0 + w > V.shape[1]:
            return None
        V = V[r0:r0 + h, c0:c0 + w].astype(np.float32)
        return np.ascontiguousarray(V[..., 0]), np.ascontiguousarray(V[..., 1])

    def zwischen(self, a, b, n, fluss=None):
        """n − 1 Zwischenbilder von a nach b: beide Bilder entlang des Flusses verschoben und überblendet. Fluss = Bewegungsfeld der
        eigenen Vorhersage (Vorhersageteil, seit 0.20.0) oder per Optical Flow (Farneback) aus a und b geschätzt (Vergangenheit, DWD)."""
        if float(a.max()) <= STOPS[0][0] and float(b.max()) <= STOPS[0][0]:
            return [a] * (n - 1)                                         # beide trocken: alles Karte
        if fluss is None:
            flow = cv2.calcOpticalFlowFarneback(norm(a), norm(b), None, 0.5, 4, 21, 3, 7, 1.5, 0)
            fx, fy = flow[..., 0], flow[..., 1]
        else:
            fx, fy = fluss
        out = []
        for s in range(1, n):
            f = s / n
            A = cv2.remap(a, self.gx - f * fx, self.gy - f * fy, cv2.INTER_LINEAR, borderValue=-10)
            B = cv2.remap(b, self.gx + (1 - f) * fx, self.gy + (1 - f) * fy, cv2.INTER_LINEAR, borderValue=-10)
            out.append((1 - f) * A + f * B)
        return out


class Bildspeicher:
    """Eingefärbte Bilder der Vergangenheit (Analysen + Zwischenbilder) von Lauf zu Lauf (seit 0.20.0): Sie ändern sich nicht mehr, jeder
    Lauf rechnet nur das neue Paar (letzte Analyse → jetzt). Gespeichert als XOR gegen die Karte, zlib-gepackt (trocken ≈ 0, starker
    Regen ≈ 1 MB je Bild). Hält auch die Scene; beides gilt, solange Ausschnitt und Radar-Abdeckung gleich bleiben. Die Abdeckung
    ändert sich fast jeden Lauf um einzelne Pixel (Störechos); erst ab COVER_NEU geänderten Pixeln im Ausschnitt wird neu gebaut
    (ein Pixel ändert die weich gezeichnete Randblende um < 0,1 %)."""
    COVER_NEU = 100

    def __init__(self):
        self.schluessel, self.sc, self.cover, self.bilder = None, None, None, {}

    def scene(self, geo, where, cover):
        k = repr((geo.z, geo.w, geo.h, geo.cx, geo.cy, sorted(where.items())))
        if k == self.schluessel and self.sc is not None:
            c = cover[self.sc.r0:self.sc.r1, self.sc.c0:self.sc.c1]
            if c.shape == self.cover.shape and int(np.count_nonzero(c != self.cover)) <= self.COVER_NEU:
                return self.sc
        self.schluessel, self.sc, self.bilder = k, Scene(geo, where, cover), {}
        self.cover = cover[self.sc.r0:self.sc.r1, self.sc.c0:self.sc.c1].copy()
        return self.sc

    def hole(self, key):
        z = self.bilder.get(key)
        if z is None:
            return None
        if not z:
            return self.sc.dry
        return cv2.bitwise_xor(np.frombuffer(zlib.decompress(z), np.uint8).reshape(self.sc.dry.shape), self.sc.dry)

    def lege(self, key, img):
        self.bilder[key] = b"" if img is self.sc.dry else zlib.compress(cv2.bitwise_xor(img, self.sc.dry).tobytes(), 1)

    def aufraeumen(self, ab_epoch):
        for k in [k for k in self.bilder if k[0] < ab_epoch]:
            del self.bilder[k]

    def mb(self):
        return sum(len(z) for z in self.bilder.values()) / 1e6


class Lauf:
    """Alles, was ein Video auf Abruf braucht, ohne neu zu laden (letzter Lauf, im Speicher bis zum nächsten)."""

    def __init__(self, t0, times, crop, echt, now, sc, fluss, meta):
        self.t0, self.times, self.crop, self.echt, self.now, self.sc, self.fluss, self.meta = t0, times, crop, echt, now, sc, fluss, meta
        self.epochs = [int(t.timestamp()) for t in times]


def panel_geometry(cfg, lat, lon):
    """Ausschnitt fürs kleine Panel-Standbild (Optionen panel_width/panel_height/panel_zoom); None = aus."""
    w, h = int(cfg.get("panel_width") or 0), int(cfg.get("panel_height") or 0)
    if w <= 0 or h <= 0:
        return None
    return Geo({**cfg, "width": w, "height": h, "zoom": int(cfg.get("panel_zoom") or cfg["zoom"])}, lat, lon)


def render_panel_still(cfg, geo, where, cover, dbz_now, path):
    """Nur das Standbild „jetzt“ für das Panel. Ein Fehler hier darf die Wand-Ausgabe nicht aufhalten."""
    try:
        t = time.time()
        sc = Scene(geo, where, cover)
        Image.fromarray(sc.compose(sc.crop([dbz_now])[0])).save(path, format="JPEG", quality=82, optimize=True)
        log(f"Panel-Standbild {geo.w}×{geo.h}, Zoom {geo.z}: {time.time() - t:.1f} s, {os.path.getsize(path) // 1024} KB")
        return True
    except Exception as e:
        log("Panel-Standbild fehlgeschlagen:", repr(e))
        try:
            os.remove(path)
        except OSError:
            pass
        return False


def dwd_felder(forecast):
    """Die DWD-Vorhersage (WN) aus dem Lauf: {Minuten: dBZ} für +5 … +120."""
    return {m: read_h5(b)[0] for m, b in forecast.items() if m > 0}


def tmp_pfad(out_dir, name):
    return os.path.join(out_dir, "." + name + ".tmp")


def meta_schreiben(out_dir, meta):
    open(tmp_pfad(out_dir, "meta.json"), "w").write(json.dumps(meta, ensure_ascii=False))
    os.replace(tmp_pfad(out_dir, "meta.json"), os.path.join(out_dir, "meta.json"))    # zuletzt: Karte lädt erst danach neu


def video_schreiben(cfg, lauf, speicher, pfad):
    """radar.mp4 aus dem Lauf: je 5-min-Schritt das Bild und SUB − 1 Zwischenbilder, eingefärbt, an ffmpeg (H.264).
    Fertige Bilder der Vergangenheit kommen aus dem Bildspeicher, neue landen dort."""
    sc, crop, now, ep, W, H, fps = lauf.sc, lauf.crop, lauf.now, lauf.epochs, cfg["width"], cfg["height"], cfg["fps"]
    cpu0 = resource.getrusage(resource.RUSAGE_CHILDREN)
    ff = subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error",
                           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
                           "-c:v", "libx264", "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
                           "-crf", "24", "-preset", cfg["preset"], "-tune", "animation", "-g", str(SUB + 1),
                           "-movflags", "+faststart", "-f", "mp4", pfad], stdin=subprocess.PIPE)
    z = {"flow": 0.0, "comp": 0.0, "write": 0.0, "speicher": 0}

    def put(img):
        t = time.time()
        ff.stdin.write(memoryview(np.ascontiguousarray(img)))
        z["write"] += time.time() - t

    def bild(key, fertig, dbz):
        if fertig:
            img = speicher.hole(key)
            if img is not None:
                z["speicher"] += 1
                return img
        t = time.time()
        img = sc.compose(dbz)
        z["comp"] += time.time() - t
        if fertig:
            speicher.lege(key, img)
        return img

    try:
        for k in range(len(crop)):
            put(bild((ep[k], 0), k <= now and lauf.echt[k], crop[k]))
            if k == len(crop) - 1:
                break
            fertig = k + 1 <= now and lauf.echt[k] and lauf.echt[k + 1]           # Paar liegt ganz in der Vergangenheit
            keys = [(ep[k], s) for s in range(1, SUB)]
            imgs = [speicher.hole(key) for key in keys] if fertig else [None]
            if all(i is not None for i in imgs):
                z["speicher"] += len(imgs)
                for i in imgs:
                    put(i)
                continue
            t = time.time()
            mids = sc.zwischen(crop[k], crop[k + 1], SUB, None if k < now else lauf.fluss)
            z["flow"] += time.time() - t
            for key, m in zip(keys, mids):
                put(bild(key, fertig, m))
    finally:
        try:
            ff.stdin.close()
        except OSError:
            pass
    t = time.time()
    if ff.wait() != 0:
        raise RuntimeError("ffmpeg fehlgeschlagen")
    cpu1 = resource.getrusage(resource.RUSAGE_CHILDREN)
    log(f"Zeiten: Zwischenbilder {z['flow']:.1f} s, Einfärben {z['comp']:.1f} s, aus Speicher {z['speicher']} Bilder ({speicher.mb():.0f} MB), "
        f"an ffmpeg {z['write']:.1f} s, warten {time.time() - t:.1f} s, ffmpeg-CPU {cpu1.ru_utime + cpu1.ru_stime - cpu0.ru_utime - cpu0.ru_stime:.1f} s")


def render(cfg, geo, t0, now_h5, fields, out_dir, panel_geo=None, prognose="dwd", speicher=None, bewegung=None, ruc_regen=None):
    """now_h5: (dBZ, Abdeckung, where) der Analyse; fields: {Minuten: dBZ} für +5 … +120 (eigene oder DWD-Vorhersage).
    bewegung: (Bewegungsfeld, Rechengebiet) der eigenen Vorhersage für die Zwischenbilder, ruc_regen(kasten, maske, km²): RUC-Regen im Ausschnitt.
    Schreibt still.jpg, meta.json (und still_panel.jpg, wenn panel_geo gesetzt), radar.mp4 nur bei Regen im Wand-Ausschnitt
    (sonst video: false, ein altes Video wird gelöscht); gibt den Lauf (mit meta) zurück."""
    speicher = speicher or Bildspeicher()
    tz = ZoneInfo(cfg["timezone"])
    n_past = cfg["past_minutes"] // STEP
    thr = cfg["rain_threshold_dbz"]

    frames, times = [], []
    for k in range(n_past, 0, -1):                        # Vergangenheit
        t = t0 - dt.timedelta(minutes=k * STEP)
        b = past_blob(cfg, t)
        frames.append(read_h5(b)[0] if b else None)
        times.append(t)
    dbz_now, cover, where = now_h5                        # jetzt + Vorhersage
    frames.append(dbz_now)
    times.append(t0)
    for m in sorted(fields):
        frames.append(fields[m])
        times.append(t0 + dt.timedelta(minutes=m))
    now = n_past
    echt = [f is not None for f in frames]
    for k in range(len(frames)):                          # Lücken (fehlende DWD-Läufe) mit dem Nachbarbild füllen
        if frames[k] is None:
            src = next((frames[j] for j in list(range(k - 1, -1, -1)) + list(range(k + 1, len(frames))) if frames[j] is not None), None)
            frames[k] = src
    log(f"Bilder: {len(frames)}, {times[0]:%H:%M}Z … {times[-1]:%H:%M}Z, Vorhersage {prognose}")

    sc = speicher.scene(geo, where, cover)
    crop = sc.crop(frames)

    os.makedirs(out_dir, exist_ok=True)
    tmp = lambda name: tmp_pfad(out_dir, name)
    still = sc.compose(crop[now])
    Image.fromarray(still).save(tmp("still.jpg"), format="JPEG", quality=88)
    speicher.lege((int(t0.timestamp()), 0), still)       # dasselbe Bild ist im Video „jetzt“ und ab dem nächsten Lauf Vergangenheit
    speicher.aufraeumen(int(times[0].timestamp()))       # älter als der Anfang des Videos: weg (auch in langen Trockenphasen)
    panel_still = render_panel_still(cfg, panel_geo, where, cover, frames[now], tmp("still_panel.jpg")) if panel_geo else False

    # Kennzahlen am Zuhause-Punkt (größter Wert im 5×5-km-Feld)
    y, x = int(round(sc.hr)), int(round(sc.hc))
    series = [round(float(f[y - 2:y + 3, x - 2:x + 3].max()), 1) for f in crop]
    fps = cfg["fps"]

    # Trocken (Entscheidung 16.11.2026): im Wand-Ausschnitt kein Echo ≥ Schwelle jetzt (ab REGEN_KM2, kleinere Flecken sind meist Störechos),
    # keins in den Vorhersagebildern, RUC dort ohne Regen in 2 h und am Zuhause-Punkt kein Regen → kein vorgerechnetes Video
    # (▶ fordert es auf Abruf an).
    km2 = [sc.nass_km2(c, thr) for c in crop[now:]]
    grund = [n for n, ja in (("Zuhause", any(v >= thr for v in series[now:])),
                             (f"jetzt {km2[0]} km²", km2[0] >= REGEN_KM2),
                             (f"Vorhersage bis {max(km2[1:], default=0)} km²", max(km2[1:], default=0) >= REGEN_KM2),
                             ("RUC", bool(ruc_regen and ruc_regen((sc.r0, sc.r1, sc.c0, sc.c1), sc.im_bild, REGEN_KM2)))) if ja]
    video = bool(grund)
    log("Wand-Ausschnitt: Regen (" + ", ".join(grund) + ") → Video" if video else
        f"Wand-Ausschnitt: trocken (jetzt {km2[0]} km², Vorhersage bis {max(km2[1:], default=0)} km²) → kein Video, ▶ rechnet auf Abruf")
    loc = lambda t: t.astimezone(tz)
    hhmm = lambda t: loc(t).strftime("%H:%M")
    rain = [v >= thr for v in series]
    start = next((k for k in range(now, len(rain)) if rain[k]), None)
    end = next((k for k in range(start + 1, len(rain)) if not rain[k]), None) if start is not None else None
    mmh = [round(float(mm_per_h(v)), 2) if v >= thr else 0.0 for v in series]
    rng = range(start, end if end is not None else len(rain)) if start is not None else []
    meta = {
        "version": int(t0.timestamp()), "generated": int(time.time()),
        "t0": hhmm(t0), "t0_epoch": int(t0.timestamp()),
        "now_index": now, "step_min": STEP, "sub": SUB, "fps": fps,
        "frames": len(crop), "duration_s": ((len(crop) - 1) * SUB + 1) / fps,
        "times": [hhmm(t) for t in times], "epochs": [int(t.timestamp()) for t in times],
        "home_dbz": series, "thr_dbz": thr,
        "regnet_jetzt": bool(rain[now]),
        "regen_ab": hhmm(times[start]) if start is not None else None,
        "regen_ab_iso": loc(times[start]).isoformat() if start is not None and not rain[now] else None,
        "regen_bis": hhmm(times[end]) if end is not None else None,
        "regen_dauer_min": (((end if end is not None else len(rain)) - start) * STEP) if start is not None else 0,
        "max_mm_h": max((mmh[k] for k in rng), default=0.0),
        "summe_mm": round(sum(mmh[k] for k in rng) * STEP / 60, 2),
        "verlauf": mmh[now:now + 24],    # mm/h am Zuhause-Punkt ab jetzt, ein Wert je Schritt (STEP min)
        "prognose": prognose,            # Quelle der Vorhersage dieses Laufs: eigen (DA50) oder dwd (WN)
        "video": video,                  # seit 0.20.0: false = kein radar.mp4 (trocken), die Karte fordert es per button.wand_radar_video an
    }
    lauf = Lauf(t0, times, crop, echt, now, sc, sc.fluss(*bewegung) if bewegung else None, meta)
    if video:
        video_schreiben(cfg, lauf, speicher, tmp("radar.mp4"))
    for name in ("still.jpg",) + (("radar.mp4",) if video else ()) + (("still_panel.jpg",) if panel_still else ()):
        os.replace(tmp(name), os.path.join(out_dir, name))
    for name, weg in (("radar.mp4", not video), ("still_panel.jpg", not panel_still)):
        if weg:              # kein Video (trocken) bzw. Panel-Option aus oder Fehler: nichts Altes unter neuen Zeiten stehen lassen
            try:
                os.remove(os.path.join(out_dir, name))
            except OSError:
                pass
    meta_schreiben(out_dir, meta)
    return lauf


def video_auf_abruf(cfg, lauf, speicher, out_dir):
    """▶ bei Trockenheit (button.wand_radar_video): Video aus dem letzten Lauf rechnen, nichts neu laden. Gilt bis zum nächsten Lauf."""
    if lauf is None:
        log("Video auf Abruf: noch kein Lauf seit dem Start")
        return
    if lauf.meta.get("video"):
        log(f"Video auf Abruf: für Lauf {lauf.meta['t0']} liegt schon eins vor")
        return
    t, cpu0 = time.time(), cpu_s()
    video_schreiben(cfg, lauf, speicher, tmp_pfad(out_dir, "radar.mp4"))
    os.replace(tmp_pfad(out_dir, "radar.mp4"), os.path.join(out_dir, "radar.mp4"))
    lauf.meta = dict(lauf.meta, video=True, version=lauf.meta["t0_epoch"] + 1, generated=int(time.time()))   # +1: nie gleich einem t0
    meta_schreiben(out_dir, lauf.meta)
    log(f"Video auf Abruf für Lauf {lauf.meta['t0']}: fertig in {time.time() - t:.1f} s (CPU {cpu_s() - cpu0:.1f} s mit ffmpeg)")


# ---------- MQTT: Sensor und Knopf ----------
class Mqtt:
    BASE = "wand_radar"

    def __init__(self):
        self.client = None
        self.abruf = threading.Event()        # button.wand_radar_video gedrückt

    def connect(self):
        import paho.mqtt.client as mqtt
        s = sup_get("/services/mqtt")["data"]
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="wand_radar")
        c.username_pw_set(s["username"], s["password"])
        if s.get("ssl"):
            c.tls_set()
        c.will_set(f"{self.BASE}/availability", "offline", retain=True)
        c.on_connect = lambda cl, u, f, rc, p=None: self.discover(cl)
        c.on_message = lambda cl, u, msg: self.abruf.set() if msg.topic == f"{self.BASE}/video/set" else None
        c.connect_async(s["host"], int(s["port"]), 60)
        c.loop_start()
        self.client = c

    def discover(self, c):
        dev = {"identifiers": ["wand_radar"], "name": "Wand-Radar", "manufacturer": "ha-wand-radar"}
        c.publish("homeassistant/sensor/wand_radar/regen_ab/config", json.dumps({
            "name": "Regen ab", "unique_id": "wand_radar_regen_ab", "default_entity_id": "sensor.wand_radar_regen_ab",
            "device_class": "timestamp", "icon": "mdi:weather-rainy",
            "state_topic": f"{self.BASE}/state", "value_template": "{{ value_json.regen_ab_iso }}",
            "json_attributes_topic": f"{self.BASE}/state",
            "availability_topic": f"{self.BASE}/availability", "device": dev}), retain=True)
        c.publish("homeassistant/button/wand_radar/video/config", json.dumps({          # seit 0.20.0: Video auf Abruf
            "name": "Video rechnen", "unique_id": "wand_radar_video", "default_entity_id": "button.wand_radar_video",
            "icon": "mdi:play-circle-outline", "command_topic": f"{self.BASE}/video/set", "payload_press": "PRESS",
            "availability_topic": f"{self.BASE}/availability", "device": dev}), retain=True)
        c.subscribe(f"{self.BASE}/video/set")
        c.publish(f"{self.BASE}/availability", "online", retain=True)

    def publish(self, meta):
        if not self.client:
            return
        keys = ("regnet_jetzt", "regen_ab", "regen_bis", "regen_dauer_min", "max_mm_h", "summe_mm", "t0", "t0_epoch", "verlauf", "prognose")
        p = {k: meta[k] for k in keys}
        p["regen_ab_iso"] = meta["regen_ab_iso"]
        self.client.publish(f"{self.BASE}/state", json.dumps(p), retain=True)
        self.client.publish(f"{self.BASE}/availability", "online", retain=True)

    def offline(self):
        if self.client:
            self.client.publish(f"{self.BASE}/availability", "offline", retain=True)


def publish_card(out_dir):
    """Legt die Dashboard-Karte neben die Radardateien (Ressource /local/wand-radar/wand-radar-card.js)."""
    src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wand-radar-card.js")
    if not os.path.exists(src):
        return
    os.makedirs(out_dir, exist_ok=True)
    dst = os.path.join(out_dir, "wand-radar-card.js")
    tmp = os.path.join(out_dir, ".wand-radar-card.js.tmp")
    open(tmp, "wb").write(open(src, "rb").read())
    os.replace(tmp, dst)


# ---------- Hauptschleife ----------
def main():
    cfg = load_config()
    out_dir = cfg["output_dir"]
    lat, lon = home_position(cfg)
    log(f"Wand-Radar startet: Zuhause {lat:.4f}, {lon:.4f}, Zoom {cfg['zoom']}, {cfg['width']}×{cfg['height']}, Ausgabe {out_dir}, "
        f"Vorhersage {cfg['prognose']}")
    if "--route-once" in sys.argv:                   # Test: nur die Route einmal rechnen
        route.RouteWorker(cfg, (lat, lon)).tick()
        return
    if route.ha_available():
        route.start_thread(cfg, (lat, lon))          # eigener Thread, damit ein langer Radar-Durchlauf die Route nicht aufhält
    geo = Geo(cfg, lat, lon)
    panel_geo = panel_geometry(cfg, lat, lon)
    publish_card(out_dir)
    arch = archiv.start(cfg, (lat, lon), read_h5, log)     # nur Messphase der eigenen Vorhersage (archiv_tage, prognose_test)
    eigen = vorhersage.Vorhersage(cfg, (lat, lon), read_h5, past_blob, log) if cfg["prognose"] != "dwd" else None
    speicher = Bildspeicher()
    letzter = None                                   # letzter Lauf, für das Video auf Abruf
    mq = Mqtt()
    if "SUPERVISOR_TOKEN" in os.environ:
        try:
            mq.connect()
        except Exception as e:
            log("MQTT nicht verfügbar:", e)
    at = os.environ.get("WR_AT")                     # Test: älteren Lauf rendern, z. B. WR_AT=20260928_1340 (UTC)
    latest = DWD + (f"composite_wn_{at}.tar" if at else "composite_wn__LATEST.tar")
    once = "--once" in sys.argv or bool(at)
    etag, last_t0, last_ok = None, None, time.time()
    pause_entity = (cfg.get("pause_entity") or "").strip()
    pausiert = False
    while True:
        if pause_entity and not once:               # z. B. nachts: nichts holen und rechnen, Sensor "nicht verfügbar"
            try:
                p_an = route.ha_get("/states/" + pause_entity)["state"] == "on"
            except Exception as e:
                log("Pause-Entität nicht lesbar:", repr(e))
                p_an = False
            if p_an != pausiert:
                pausiert = p_an
                log("Pause:", pause_entity, "an – Radar ruht" if p_an else "aus – Radar rechnet wieder")
                if p_an:
                    mq.offline()
                else:
                    etag, last_ok = None, time.time()
            if pausiert:
                mq.abruf.clear()                     # in der Pause gibt es kein Video auf Abruf
                time.sleep(POLL)
                continue
        if mq.abruf.is_set():
            mq.abruf.clear()
            try:
                video_auf_abruf(cfg, letzter, speicher, out_dir)
            except Exception as e:
                log("Video auf Abruf fehlgeschlagen:", repr(e))
        try:
            h = requests.head(latest, headers=UA, timeout=30)
            h.raise_for_status()
            new = h.headers.get("ETag") or h.headers.get("Last-Modified")
            if new != etag or once:
                m = tar_members(fetch_tar(latest))
                names = sorted(m)
                p = names[0].split("_")
                t0 = dt.datetime.strptime(p[2] + p[3], "%Y%m%d%H%M").replace(tzinfo=dt.timezone.utc)
                if t0 != last_t0:
                    started, cpu0 = time.time(), cpu_s()
                    store_past(cfg, t0, m[names[0]])
                    forecast = {int(n.split("_")[4][:3]): m[n] for n in names}
                    now_h5 = read_h5(forecast[0])
                    fields, quelle = None, "dwd"
                    if eigen:
                        try:
                            fields = eigen.felder(t0, now_h5[0], now_h5[2])
                        except Exception as e:
                            log("Vorhersage: eigene fehlgeschlagen, nehme DWD:", repr(e))
                        quelle = "eigen" if fields is not None else "dwd"
                    if fields is None:
                        fields = dwd_felder(forecast)
                    letzter = render(cfg, geo, t0, now_h5, fields, out_dir, panel_geo, quelle, speicher,
                                     bewegung=(eigen.bewegung, eigen.gebiet) if quelle == "eigen" else None,
                                     ruc_regen=(lambda *a, t0=t0: eigen.ruc_regen(t0, *a)) if eigen else None)
                    meta = letzter.meta
                    mq.publish(meta)
                    if arch:
                        arch.neuer_lauf(t0, forecast)
                    clean_past(cfg, t0)
                    last_t0 = t0
                    log(f"fertig in {time.time() - started:.1f} s (CPU {cpu_s() - cpu0:.1f} s mit ffmpeg): Lauf {meta['t0']}, Vorhersage {quelle}, "
                        f"Video {'ja' if meta['video'] else 'nein'}, Regen ab {meta['regen_ab']}, bis {meta['regen_bis']}")
                etag = new
                last_ok = time.time()
            else:
                last_ok = time.time()
        except Exception as e:
            log("Fehler:", repr(e))
            if time.time() - last_ok > STALE_AFTER:
                mq.offline()
        if once:
            if "--abruf" in sys.argv:                # Test: danach ▶ bei Trockenheit wie über button.wand_radar_video
                video_auf_abruf(cfg, letzter, speicher, out_dir)
            break
        mq.abruf.wait(POLL)                          # wacht früher auf, wenn ▶ ein Video anfordert


if __name__ == "__main__":
    main()
