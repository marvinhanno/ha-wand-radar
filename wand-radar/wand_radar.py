#!/usr/bin/env python3
"""Wand-Radar: rechnet das DWD-Regenradar (WN-Komposit, 1 km, 5 min, +120 min Nowcast) zu fertigen Wand-Hintergründen.

Ausgabe in output_dir:
  still.jpg   Karte + Radar "jetzt"
  radar.mp4   H.264, -past_minutes … +120 min, je 5-min-Schritt 4 berechnete Zwischenbilder
  meta.json   Zeiten, Verlauf am Zuhause-Punkt, Regenbeginn
Dazu ein MQTT-Sensor "Wand-Radar Regen ab" (sensor.wand_radar_regen_ab).
"""
import datetime as dt
import io
import json
import math
import os
import subprocess
import sys
import tarfile
import time
from zoneinfo import ZoneInfo

import cv2
import h5py
import imageio_ffmpeg
import numpy as np
import requests
from PIL import Image
from pyproj import Transformer

import route

DWD = "https://opendata.dwd.de/weather/radar/composite/wn/"
ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/"
SUPERVISOR = "http://supervisor"
STEP = 5          # Minuten zwischen zwei DWD-Bildern
SUB = 5           # Unterteilung je Schritt (= 4 Zwischenbilder)
POLL = 60         # Sekunden zwischen zwei Prüfungen auf neue Daten
STALE_AFTER = 30 * 60   # ohne neue Daten: Sensor "nicht verfügbar"
UA = {"User-Agent": "ha-wand-radar/0.1 (Home Assistant add-on)"}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------- Konfiguration ----------
def load_config():
    """Add-on-Optionen aus /data/options.json, lokal aus Umgebungsvariablen (WR_*)."""
    cfg = dict(zoom=9, width=1366, height=1024, past_minutes=60, fps=18, rain_threshold_dbz=14,
               timezone="Europe/Berlin", preset="veryfast", output_dir="out", latitude=None, longitude=None)
    if os.path.exists("/data/options.json"):
        cfg.update({k: v for k, v in json.load(open("/data/options.json")).items() if v is not None})
    for k in cfg:
        env = os.environ.get("WR_" + k.upper())
        if env:
            cfg[k] = type(cfg[k])(env) if cfg[k] is not None else float(env)
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
def render(cfg, geo, t0, forecast, out_dir):
    """forecast: {Minuten: hdf5-Bytes} von +0 bis +120. Schreibt still.jpg, radar.mp4, meta.json; gibt meta zurück."""
    W, H = geo.w, geo.h
    tz = ZoneInfo(cfg["timezone"])
    n_past = cfg["past_minutes"] // STEP

    frames, times, cover = [], [], None
    where = None
    for k in range(n_past, 0, -1):                        # Vergangenheit
        t = t0 - dt.timedelta(minutes=k * STEP)
        b = past_blob(cfg, t)
        frames.append(read_h5(b)[0] if b else None)
        times.append(t)
    for m in sorted(forecast):                            # jetzt + Vorhersage
        dbz, cov, where = read_h5(forecast[m])
        if m == 0:
            cover = cov
        frames.append(dbz)
        times.append(t0 + dt.timedelta(minutes=m))
    now = n_past
    for k in range(len(frames)):                          # Lücken (fehlende DWD-Läufe) mit dem Nachbarbild füllen
        if frames[k] is None:
            src = next((frames[j] for j in list(range(k - 1, -1, -1)) + list(range(k + 1, len(frames))) if frames[j] is not None), None)
            frames[k] = src
    log(f"Bilder: {len(frames)}, {times[0]:%H:%M}Z … {times[-1]:%H:%M}Z")

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
    c0, c1 = int(col.min()) - 40, int(col.max()) + 40      # Ausschnitt, damit Optical Flow schnell bleibt
    r0, r1 = int(row.min()) - 40, int(row.max()) + 40
    mapx = (col - c0).astype(np.float32)
    mapy = (row - r0).astype(np.float32)
    crop = [f[r0:r1, c0:c1] for f in frames]

    base, ref = geo.maps()
    # Datenrand (z. B. IJsselmeer): Radar über ~10 km weich ausblenden, außerhalb die Karte leicht abdunkeln
    cov = cv2.remap(cover[r0:r1, c0:c1].astype(np.float32), mapx, mapy, cv2.INTER_LINEAR, borderValue=0)
    cov = cv2.GaussianBlur(cov, (0, 0), 18)
    fade = np.clip(cov * 2 - 1, 0, 1)[..., None]
    base = base * (0.75 + 0.25 * np.clip(cov * 2, 0, 1)[..., None])
    hx, hy = tr.transform(geo.lon, geo.lat)
    hc, hr = (hx - xul) / 1000 - 0.5 - c0, (yul - hy) / 1000 - 0.5 - r0

    la = ref[..., 3:4] * 0.4                                # Ortsnamen ÜBER dem Radar
    dry = (np.clip(base * (1 - la) + ref[..., :3] * la, 0, 1) * 255).astype(np.uint8)   # Karte ohne Regen
    lut_rgb, lut_a = LUT[:, :3], LUT[:, 3:4] * 0.9

    def compose(dbz_crop):
        """Nur Pixel mit Regen werden gerechnet, der Rest kommt fertig aus dry (spart auf schwachen Rechnern das meiste)."""
        d = cv2.remap(dbz_crop, mapx, mapy, cv2.INTER_LINEAR, borderValue=-10)
        ys, xs = np.nonzero(d > STOPS[0][0])
        img = dry.copy()
        if len(ys):
            idx = np.clip(np.round((d[ys, xs] + 10) * 4), 0, 320).astype(np.int32)
            a = lut_a[idx] * fade[ys, xs]
            out = (base[ys, xs] * (1 - a) + lut_rgb[idx] * a) * (1 - la[ys, xs]) + ref[ys, xs, :3] * la[ys, xs]
            img[ys, xs] = (np.clip(out, 0, 1) * 255).astype(np.uint8)
        return img

    gx, gy = np.meshgrid(np.arange(crop[0].shape[1], dtype=np.float32), np.arange(crop[0].shape[0], dtype=np.float32))

    def between(a, b, n):                                   # Zwischenbilder per Optical Flow (Farneback)
        flow = cv2.calcOpticalFlowFarneback(norm(a), norm(b), None, 0.5, 4, 21, 3, 7, 1.5, 0)
        fx, fy = flow[..., 0], flow[..., 1]
        out = []
        for s in range(1, n):
            f = s / n
            A = cv2.remap(a, gx - f * fx, gy - f * fy, cv2.INTER_LINEAR, borderValue=-10)
            B = cv2.remap(b, gx + (1 - f) * fx, gy + (1 - f) * fy, cv2.INTER_LINEAR, borderValue=-10)
            out.append((1 - f) * A + f * B)
        return out

    os.makedirs(out_dir, exist_ok=True)
    tmp = lambda name: os.path.join(out_dir, "." + name + ".tmp")
    Image.fromarray(compose(crop[now])).save(tmp("still.jpg"), format="JPEG", quality=88)

    fps = cfg["fps"]
    ff = subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error",
                           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
                           "-c:v", "libx264", "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
                           "-crf", "24", "-preset", cfg["preset"], "-tune", "animation", "-g", str(SUB + 1),
                           "-movflags", "+faststart", "-f", "mp4", tmp("radar.mp4")], stdin=subprocess.PIPE)
    t_flow = t_comp = t_write = 0.0

    def put(dbz):
        nonlocal t_comp, t_write
        t = time.time()
        raw = compose(dbz).tobytes()
        t_comp += time.time() - t
        t = time.time()
        ff.stdin.write(raw)
        t_write += time.time() - t

    for k in range(len(crop)):
        put(crop[k])
        if k < len(crop) - 1:
            t = time.time()
            mids = between(crop[k], crop[k + 1], SUB)
            t_flow += time.time() - t
            for m in mids:
                put(m)
    t = time.time()
    ff.stdin.close()
    if ff.wait() != 0:
        raise RuntimeError("ffmpeg fehlgeschlagen")
    log(f"Zeiten: Zwischenbilder {t_flow:.0f} s, Einfärben {t_comp:.0f} s, an ffmpeg {t_write:.0f} s, Rest {time.time() - t:.0f} s")

    # Kennzahlen am Zuhause-Punkt (größter Wert im 5×5-km-Feld)
    y, x = int(round(hr)), int(round(hc))
    series = [round(float(f[y - 2:y + 3, x - 2:x + 3].max()), 1) for f in crop]
    thr = cfg["rain_threshold_dbz"]
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
    }
    for name in ("still.jpg", "radar.mp4"):
        os.replace(tmp(name), os.path.join(out_dir, name))
    open(tmp("meta.json"), "w").write(json.dumps(meta, ensure_ascii=False))
    os.replace(tmp("meta.json"), os.path.join(out_dir, "meta.json"))    # zuletzt: Karte lädt erst danach neu
    return meta


# ---------- MQTT-Sensor ----------
class Mqtt:
    BASE = "wand_radar"

    def __init__(self):
        self.client = None

    def connect(self):
        import paho.mqtt.client as mqtt
        s = sup_get("/services/mqtt")["data"]
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="wand_radar")
        c.username_pw_set(s["username"], s["password"])
        if s.get("ssl"):
            c.tls_set()
        c.will_set(f"{self.BASE}/availability", "offline", retain=True)
        c.on_connect = lambda cl, u, f, rc, p=None: self.discover(cl)
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
        c.publish(f"{self.BASE}/availability", "online", retain=True)

    def publish(self, meta):
        if not self.client:
            return
        keys = ("regnet_jetzt", "regen_ab", "regen_bis", "regen_dauer_min", "max_mm_h", "summe_mm", "t0", "t0_epoch", "verlauf")
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
    log(f"Wand-Radar startet: Zuhause {lat:.4f}, {lon:.4f}, Zoom {cfg['zoom']}, {cfg['width']}×{cfg['height']}, Ausgabe {out_dir}")
    if "--route-once" in sys.argv:                   # Test: nur die Route einmal rechnen
        route.RouteWorker(cfg, (lat, lon)).tick()
        return
    if route.ha_available():
        route.start_thread(cfg, (lat, lon))          # eigener Thread, damit ein langer Radar-Durchlauf die Route nicht aufhält
    geo = Geo(cfg, lat, lon)
    publish_card(out_dir)
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
                time.sleep(POLL)
                continue
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
                    started = time.time()
                    store_past(cfg, t0, m[names[0]])
                    forecast = {int(n.split("_")[4][:3]): m[n] for n in names}
                    meta = render(cfg, geo, t0, forecast, out_dir)
                    mq.publish(meta)
                    clean_past(cfg, t0)
                    last_t0 = t0
                    log(f"fertig in {time.time() - started:.0f} s: Lauf {meta['t0']}, Regen ab {meta['regen_ab']}, bis {meta['regen_bis']}")
                etag = new
                last_ok = time.time()
            else:
                last_ok = time.time()
        except Exception as e:
            log("Fehler:", repr(e))
            if time.time() - last_ok > STALE_AFTER:
                mq.offline()
        if once:
            break
        time.sleep(POLL)


if __name__ == "__main__":
    main()
