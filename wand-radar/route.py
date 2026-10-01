"""Route-Hintergrund für die Wand-Karte: schreibt route.json (Auto über Waze, Bahn über Transitous).

Läuft als eigener Thread neben dem Radar (nie in dessen Hauptschleife). Liest jede Minute ein paar HA-Helfer, entscheidet ob
gerade eine Route gebraucht wird und schreibt dann route.json neben still.jpg/meta.json.
Auto: einmal je Ziel die Fahrzeit ohne Verkehr (OSRM), Verkehr (Waze) erst ab VORLAUF vor „los“ und nur, solange jemand zu
Hause ist; die Fahrzeit-Helfer in HA schreibt diese App (einzige Quelle, eine Abfrage für Fahrzeit, Stau und Karte).
Ergebnisse von Transitous (Bahnhöfe, Gleisverlauf) werden dauerhaft in data_dir/route zwischengespeichert.
"""
import datetime as dt
import json
import math
import os
import re
import threading
import time
import unicodedata
from collections import Counter
from zoneinfo import ZoneInfo

import requests

UA = {"User-Agent": "ha-wand-radar/0.3 (Home Assistant add-on)"}
WAZE = "https://routing-livemap-row.waze.com/RoutingManager/routingRequest"
OSRM = "https://router.project-osrm.org/route/v1/driving/"
MOTIS = "https://api.transitous.org/api/"
FENSTER = dt.timedelta(hours=3)        # Bahn: so früh vor der Abfahrt wird die Strecke schon geholt
VORAUS = dt.timedelta(hours=24)        # Auto: Termine so weit voraus bekommen die Fahrzeit ohne Verkehr (OSRM, kostenlos)
VORLAUF = dt.timedelta(minutes=60)     # Auto: Verkehr ab so lange vor „los“ (dann zeigt die Wand die Aufbruch-Karte)
T0_FAKTOR = 1.5                        # Auto: „los“ für den Fensterbeginn großzügig aus 1,5 × Fahrzeit ohne Verkehr schätzen
TAKT, TAKT_NAH, NAH = 10 * 60, 5 * 60, dt.timedelta(minutes=30)   # Verkehr alle 10 min, in den letzten 30 min vor „los“ alle 5 min
FEHLER_PAUSE = 5 * 60                  # nach einem Fehler erst nach 5 min wieder versuchen
STAU_FAKTOR, STAU_MIN_S = 1.4, 60      # Abschnitt zählt als Stau ab 1,4-facher Zeit (gegenüber freiem Fluss); Stau erst ab 60 s Verzögerung
ALT_MAX_MIN = 15                       # Alternative höchstens so viel länger als die schnellste
NICHT_BAHN = ("WALK", "BIKE", "CAR", "RENTAL", "FLEX", "ODM")


def log(*a):
    print(time.strftime("%H:%M:%S"), "Route:", *a, flush=True)


# ---------- HA-Zugriff (Supervisor in der App, lokal HA_URL/HA_TOKEN) ----------
def ha_available():
    return bool(os.environ.get("SUPERVISOR_TOKEN") or (os.environ.get("HA_URL") and os.environ.get("HA_TOKEN")))


def _ha_base():
    if os.environ.get("SUPERVISOR_TOKEN"):
        return "http://supervisor/core/api", os.environ["SUPERVISOR_TOKEN"]
    return os.environ["HA_URL"].rstrip("/") + "/api", os.environ["HA_TOKEN"]


def ha_get(path):
    """GET auf die HA-Core-API, path z. B. '/states/zone.home'."""
    base, tok = _ha_base()
    r = requests.get(base + path, headers={"Authorization": "Bearer " + tok}, timeout=15)
    r.raise_for_status()
    return r.json()


def ha_call(domain, service, data):
    """HA-Aktion aufrufen, z. B. ha_call('input_number', 'set_value', {...})."""
    base, tok = _ha_base()
    r = requests.post(f"{base}/services/{domain}/{service}", json=data, headers={"Authorization": "Bearer " + tok}, timeout=15)
    r.raise_for_status()


# ---------- Geometrie ----------
def simplify(pts, tol):
    """Douglas-Peucker (iterativ) über [lat, lon]-Punkte, Toleranz in Grad."""
    n = len(pts)
    if n < 3:
        return list(pts)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        dx, dy = pts[b][0] - ax, pts[b][1] - ay
        ll = dx * dx + dy * dy
        best, bi = 0.0, None
        for i in range(a + 1, b):
            px, py = pts[i][0] - ax, pts[i][1] - ay
            t = 0.0 if ll == 0 else max(0.0, min(1.0, (px * dx + py * dy) / ll))
            d = math.hypot(px - t * dx, py - t * dy)
            if d > best:
                best, bi = d, i
        if bi is not None and best > tol:
            keep[bi] = True
            stack.extend(((a, bi), (bi, b)))
    return [p for p, k in zip(pts, keep) if k]


def pack(pts, tol=0.0002):
    return [[round(p[0], 5), round(p[1], 5)] for p in simplify(pts, tol)]


def km_between(a, b):
    """Luftlinie in km zwischen zwei (lat, lon)."""
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def poly_decode(s, prec=6):
    i, lat, lon, out, f = 0, 0, 0, [], 10 ** prec
    while i < len(s):
        for k in (0, 1):
            shift = res = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                res |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            d = ~(res >> 1) if res & 1 else res >> 1
            if k == 0:
                lat += d
            else:
                lon += d
        out.append([lat / f, lon / f])
    return out


# ---------- Auto: Waze ----------
def stau_teile(res, coords):
    """Zusammenhängende Abschnitte mit deutlicher Verzögerung -> [{'pts': [...], 'min': n}].
    Jeder Abschnitt (results[i]) beginnt bei path = coords[idx_i] und reicht bis zum Beginn des nächsten."""
    idx, j = [], 0
    for r in res:
        p, k = r["path"], j
        while k < len(coords) and not (abs(coords[k]["x"] - p["x"]) < 1e-7 and abs(coords[k]["y"] - p["y"]) < 1e-7):
            k += 1
        if k == len(coords):
            k = j
        idx.append(k)
        j = k
    out, gruppe, verz = [], [], 0

    def abschluss():
        if gruppe and verz >= STAU_MIN_S:
            a, b = idx[gruppe[0]], (idx[gruppe[-1] + 1] if gruppe[-1] + 1 < len(res) else len(coords) - 1)
            pts = [[c["y"], c["x"]] for c in coords[a:b + 1]]
            if len(pts) >= 2:
                out.append({"pts": pack(pts, 0.0001), "min": max(1, round(verz / 60))})

    for i, r in enumerate(res):
        # Basis ist der freie Verkehrsfluss: crossTimeWithoutRealTime enthält die aktuelle Verkehrslage bereits (fast gleich crossTime)
        ct, ohne = r.get("crossTime", 0), r.get("crossTimeFreeFlow") or r.get("crossTimeWithoutRealTime", 0)
        if ohne > 0 and ct >= STAU_FAKTOR * ohne:
            gruppe.append(i)
            verz += ct - ohne
        else:
            abschluss()
            gruppe, verz = [], 0
    abschluss()
    return out


def waze_routen(start, ziel):
    p = {"from": f"x:{start[1]} y:{start[0]}", "to": f"x:{ziel[1]} y:{ziel[0]}", "at": 0, "returnJSON": "true",
         "returnGeometries": "true", "returnInstructions": "true", "timeout": 60000, "nPaths": 3,
         "options": "AVOID_TRAILS:t,AVOID_TOLL_ROADS:f,AVOID_FERRIES:f", "subscription": "*"}
    global _waze_chrome
    r = None
    if not _waze_chrome:
        r = requests.get(WAZE, params=p, headers={"User-Agent": "pywaze", "referer": "https://www.waze.com/"}, timeout=30)
        if r.status_code == 403:                     # seit 30.09.2026 sperrt Waze einfache Clients; wie pywaze 1.2.3: als Chrome fragen
            _waze_chrome, r = True, None
            log("Waze 403 – ab jetzt mit Chrome-Kennung (curl_cffi)")
    if r is None:
        from curl_cffi import requests as cr
        r = cr.get(WAZE, params=p, headers={"referer": "https://www.waze.com/"}, impersonate="chrome", timeout=30)
    r.raise_for_status()
    d = json.loads(r.content.decode("utf-8"))        # r.json() würde ohne Zeichensatz im Header Latin-1 annehmen (Umlaute kaputt)
    routen = []
    for a in d.get("alternatives") or [d]:
        resp = a.get("response") or {}
        res, coords = resp.get("results"), a.get("coords")
        if not res or not coords:
            continue
        routen.append({"name": (resp.get("routeName") or "Route").split(" - ")[0].split(",")[0].strip() or "Route",
                       "min": math.ceil(sum(x["crossTime"] for x in res) / 60), "km": round(sum(x["length"] for x in res) / 1000),
                       "frei": math.ceil(sum(x.get("crossTimeFreeFlow") or x.get("crossTimeWithoutRealTime", 0) for x in res) / 60),
                       "pts": pack([[c["y"], c["x"]] for c in coords]), "stau": stau_teile(res, coords)})
    if not routen:
        raise RuntimeError("Waze lieferte keine Route")
    return routen


_waze_chrome = False      # einmal 403 bekommen -> direkt mit Chrome-Kennung fragen (bis zum Neustart)


def osrm_routen(start, ziel):
    r = requests.get(f"{OSRM}{start[1]},{start[0]};{ziel[1]},{ziel[0]}", headers=UA, timeout=30,
                     params={"alternatives": 2, "overview": "full", "geometries": "geojson", "steps": "true"})
    r.raise_for_status()
    routen = []
    for x in r.json().get("routes", []):
        refs = Counter()
        for s in x["legs"][0]["steps"]:
            if s.get("ref"):
                refs[s["ref"].split(";")[0].replace(" ", "")] += s.get("distance", 0)
        routen.append({"name": refs.most_common(1)[0][0] if refs else "Route", "min": math.ceil(x["duration"] / 60),
                       "km": round(x["distance"] / 1000), "pts": pack([[c[1], c[0]] for c in x["geometry"]["coordinates"]]), "stau": []})
    if not routen:
        raise RuntimeError("OSRM lieferte keine Route")
    return routen


def auswahl(routen):
    """Schnellste Route (Waze sortiert nicht) + eine Alternative, wenn sie höchstens ALT_MAX_MIN länger ist."""
    routen = sorted(routen, key=lambda x: x["min"])
    alt = [dict(x, stau=[]) for x in routen[1:2] if x["min"] - routen[0]["min"] <= ALT_MAX_MIN]     # Stau nur an der Hauptroute zeigen
    return routen[:1] + alt


# ---------- Bahn: Kalender, Transitous ----------
def slug(name):
    n = unicodedata.normalize("NFKD", name.lower().replace("ß", "ss")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "_", n).strip("_")


def kurzname(name):
    """Klammerzusätze entfernen, z. B. 'Musterstadt(Main)Hbf' -> 'Musterstadt Hbf'"""
    return re.sub(r"\s+", " ", re.sub(r"\s*\([^)]*\)\s*", " ", name)).strip()


def reise_abschnitte(beschreibung, tag):
    """Zugabschnitte aus der DB-Navigator-Beschreibung (Blöcke 'RE5 (12345)' / 'Ab 15:19 Ort, Gleis 1' / 'An 15:59 Ort, Gleis 4').
    tag = Datum der Abfahrt; rollt über Mitternacht weiter."""
    out, letzte = [], None
    for block in re.split(r"\n\s*\n", (beschreibung or "").replace("\r", "")):
        z = [x.strip() for x in block.split("\n") if x.strip()]
        ab = next((re.match(r"^Ab (\d\d:\d\d) (.+?)(?:, Gleis (.+))?$", x) for x in z if x.startswith("Ab ")), None)
        an = next((re.match(r"^An (\d\d:\d\d) (.+?)(?:, Gleis (.+))?$", x) for x in z if x.startswith("An ")), None)
        if not (ab and an):
            continue
        m = re.match(r"^(.*?)(?: \((\d+)\))?$", z[0])
        zeiten = []
        for hm in (ab.group(1), an.group(1)):
            t = dt.datetime.combine(tag, dt.time(int(hm[:2]), int(hm[3:])))
            if letzte and t < letzte:
                t += dt.timedelta(days=1)
            letzte = t
            zeiten.append(t)
        tag = zeiten[1].date()
        out.append({"zug": m.group(1), "nr": m.group(2) or "", "ab": zeiten[0], "an": zeiten[1],
                    "von": ab.group(2).strip(), "vg": ab.group(3) or "", "nach": an.group(2).strip(), "ng": an.group(3) or ""})
    return out


class Bahnhoefe:
    """Bahnhöfe und Gleisverläufe von Transitous, dauerhaft zwischengespeichert (freier Dienst: sparsam fragen)."""

    def __init__(self, ordner):
        self.dir = ordner
        os.makedirs(ordner, exist_ok=True)

    def _load(self, name):
        p = os.path.join(self.dir, name)
        return json.load(open(p)) if os.path.exists(p) else None

    def _save(self, name, obj):
        p = os.path.join(self.dir, name)
        open(p + ".part", "w").write(json.dumps(obj, ensure_ascii=False))
        os.replace(p + ".part", p)

    def ort(self, name):
        cache = self._load("bahnhoefe.json") or {}
        if name not in cache:
            r = requests.get(MOTIS + "v1/geocode", params={"text": name, "language": "de"}, headers=UA, timeout=30)
            r.raise_for_status()
            treffer = r.json()
            t = next((x for x in treffer if x.get("type") == "STOP"), treffer[0] if treffer else None)
            if not t:
                raise RuntimeError(f"Bahnhof nicht gefunden: {name}")
            cache[name] = [round(t["lat"], 5), round(t["lon"], 5)]
            self._save("bahnhoefe.json", cache)
        return cache[name]

    def gleis(self, von, nach, ab_utc):
        """{'pts', 'von': [lat, lon], 'nach': [lat, lon]} für die Zugfahrt von -> nach (Gleise ändern sich nicht)."""
        datei = f"gleis_{slug(von)}_{slug(nach)}.json"
        c = self._load(datei)
        if c:
            return c
        a, b = self.ort(von), self.ort(nach)
        r = requests.get(MOTIS + "v5/plan", headers=UA, timeout=45, params={
            "fromPlace": f"{a[0]},{a[1]}", "toPlace": f"{b[0]},{b[1]}", "time": ab_utc.strftime("%Y-%m-%dT%H:%M:%SZ"), "numItineraries": 3})
        r.raise_for_status()
        for it in r.json().get("itineraries", []):
            for leg in it.get("legs", []):
                if leg.get("mode") in NICHT_BAHN or not leg.get("legGeometry"):
                    continue
                if km_between((leg["from"]["lat"], leg["from"]["lon"]), a) < 1.5 and km_between((leg["to"]["lat"], leg["to"]["lon"]), b) < 1.5:
                    g = leg["legGeometry"]
                    c = {"pts": pack(poly_decode(g["points"], g.get("precision", 6))),
                         "von": [round(leg["from"]["lat"], 5), round(leg["from"]["lon"], 5)],
                         "nach": [round(leg["to"]["lat"], 5), round(leg["to"]["lon"], 5)]}
                    self._save(datei, c)
                    return c
        raise RuntimeError(f"Kein Gleisverlauf {von} -> {nach}")


# ---------- der Hintergrund-Thread ----------
class RouteWorker:
    def __init__(self, cfg, home):
        self.out = cfg["output_dir"]
        self.tz = ZoneInfo(cfg["timezone"])
        self.home = (round(home[0], 5), round(home[1], 5))
        self.bahn = Bahnhoefe(os.path.join(cfg["data_dir"], "route"))
        self.key = self.geholt = self.quelle = None   # Schlüssel, Zeit (epoch) und Quelle der zuletzt geschriebenen aktiven Route
        self.retry = 0.0
        self.kalender = (cfg.get("route_calendar") or "").strip()     # Kalender-Entität mit den Bahnreisen; leer = keine Bahnroute
        self.praesenz = (cfg.get("route_presence") or "").strip()     # binary_sensor „jemand zu Hause“; leer = immer
        self.aus = None                     # True, wenn zuletzt {"aktiv": false} geschrieben wurde
        self.t0_koord = self.t0 = self.osrm = None    # Ziel, Fahrzeit ohne Verkehr (min) und OSRM-Routen dazu
        self.t0_retry = 0.0

    def jetzt(self):
        t = os.environ.get("WR_ROUTE_JETZT")          # Test: festes Datum, z. B. 2026-01-15T14:45 (Ortszeit)
        return dt.datetime.fromisoformat(t).replace(tzinfo=self.tz) if t else dt.datetime.now(self.tz)

    def zustand(self, entity):
        try:
            return ha_get("/states/" + entity)
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 404:
                return {"state": "", "last_updated": None}
            raise

    def num(self, entity):
        try:
            return float(self.zustand(entity)["state"])
        except (TypeError, ValueError):
            return 0.0

    def an(self, entity):
        return self.zustand(entity)["state"] == "on"

    def fahrzeit_setzen(self, minuten, km, stau, quelle, jetzt):
        """Fahrzeit-Helfer in HA (Aufbruch-Karte, „los“). quelle: 'frei' = ohne Verkehr (OSRM), 'verkehr' = Waze."""
        try:
            ha_call("input_text", "set_value", {"entity_id": "input_text.termin_fahrzeit_quelle", "value": quelle})
            ha_call("input_datetime", "set_datetime", {"entity_id": "input_datetime.termin_fahrzeit_stand",
                                                       "datetime": jetzt.strftime("%Y-%m-%d %H:%M:%S")})
            ha_call("input_number", "set_value", {"entity_id": "input_number.termin_km", "value": min(2000, km)})
            ha_call("input_number", "set_value", {"entity_id": "input_number.termin_stau", "value": min(300, max(0, stau))})
            ha_call("input_number", "set_value", {"entity_id": "input_number.termin_fahrzeit", "value": min(600, minuten)})
        except Exception as e:
            log("HA-Helfer nicht gesetzt:", repr(e))

    def frei_holen(self, koord, jetzt):
        """Einmal je Ziel die Fahrzeit ohne Verkehr (OSRM, kostenlos). Nach HA nur, solange dort kein Wert mit Verkehr steht."""
        if self.t0_koord == koord or time.time() < self.t0_retry:
            return
        try:
            routen = auswahl(osrm_routen(self.home, [float(x) for x in koord.split(",")]))
        except Exception as e:
            log("OSRM fehlgeschlagen:", repr(e))
            self.t0_retry = time.time() + FEHLER_PAUSE
            return
        self.t0_koord, self.t0, self.osrm = koord, routen[0]["min"], routen
        if self.zustand("input_text.termin_fahrzeit_quelle")["state"] != "verkehr" or self.num("input_number.termin_fahrzeit") <= 0:
            self.fahrzeit_setzen(routen[0]["min"], routen[0]["km"], 0, "frei", jetzt)
        log(f"Ohne Verkehr (OSRM): {routen[0]['name']} {routen[0]['min']} min {routen[0]['km']} km")

    def schreiben(self, obj):
        os.makedirs(self.out, exist_ok=True)
        tmp = os.path.join(self.out, ".route.json.tmp")
        open(tmp, "w").write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
        os.replace(tmp, os.path.join(self.out, "route.json"))

    def tick(self):
        jetzt = self.jetzt()
        # --- Kandidaten im Zeitfenster ---
        koord = self.zustand("input_text.termin_koordinaten")["state"].replace(" ", "")
        start_s = self.zustand("input_datetime.termin_start")["state"]
        auto = None
        if re.fullmatch(r"-?\d+(\.\d+)?,-?\d+(\.\d+)?", koord) and re.match(r"\d{4}-\d\d-\d\d \d\d:\d\d", start_s or ""):
            start = dt.datetime.fromisoformat(start_s).replace(tzinfo=self.tz)
            if jetzt < start <= jetzt + VORAUS:
                self.frei_holen(koord, jetzt)
                if self.t0_koord == koord:
                    # Verkehr ab VORLAUF vor „los“; „los“ dafür großzügig geschätzt (1,5 × ohne Verkehr), bzw. aktuelles „los“, falls früher
                    puffer = self.num("input_number.termin_puffer")
                    los = start - dt.timedelta(minutes=(self.num("input_number.termin_fahrzeit") or self.t0) + puffer)
                    beginn = min(start - dt.timedelta(minutes=T0_FAKTOR * self.t0 + puffer), los) - VORLAUF
                    if jetzt >= beginn:
                        auto = (start, koord, los)
        reise = os.environ.get("WR_ROUTE_REISE") or self.zustand("input_text.wand_reise")["state"]
        bahn = None
        try:
            if not self.kalender:
                raise ValueError("kein Kalender")
            r = json.loads(reise) if reise.strip().startswith("{") else None
            ab = dt.datetime.fromisoformat(r["ab"]).replace(tzinfo=self.tz) if r else None
            if ab and ab - FENSTER <= jetzt < ab:
                bahn = (ab, r)
        except (ValueError, KeyError):
            pass
        if auto and bahn:              # beide im Fenster: der Quelle folgen (früheres „los“), sonst der frühere Beginn
            q = self.zustand("sensor.wand_aufbruch_quelle")["state"]
            if q == "reise" or (q != "termin" and bahn[0] < auto[0]):
                auto = None
            else:
                bahn = None
        if auto:
            self.auto(*auto, jetzt)
        elif bahn:
            self.reise(bahn[0], bahn[1], jetzt)
        elif self.aus is not True:
            self.schreiben({"aktiv": False})
            self.key, self.geholt, self.aus = None, None, True
            log("keine Route nötig")

    def fertig(self, key, obj, quelle=None):
        self.schreiben(obj)
        self.key, self.geholt, self.quelle, self.aus, self.retry = key, time.time(), quelle, False, 0.0

    def auto(self, start, koord, los, jetzt):
        """Verkehr von Waze: alle TAKT, ab NAH vor „los“ alle TAKT_NAH – nur, solange jemand zu Hause ist und die Karte steht."""
        if (self.praesenz and not self.an(self.praesenz)) or self.an("input_boolean.wand_aufbruch_weg") \
                or self.an("input_boolean.dienstreise_modus"):
            return
        key = f"{koord}|{start:%Y-%m-%dT%H:%M}"
        takt = TAKT_NAH if jetzt >= los - NAH else TAKT
        if (key == self.key and self.quelle == "waze" and time.time() - self.geholt < takt) or time.time() < self.retry:
            return
        ziel = [float(x) for x in koord.split(",")]
        obj = {"aktiv": True, "typ": "auto", "t": jetzt.isoformat(timespec="seconds"), "schluessel": key,
               "start": list(self.home), "ziel": [round(ziel[0], 5), round(ziel[1], 5)]}
        try:
            routen = auswahl(waze_routen(self.home, ziel))
        except Exception as e:
            if key == self.key:
                log("Waze fehlgeschlagen:", repr(e), "- letzte Route bleibt")
            else:                      # noch keine Route für diesen Termin: Strecke ohne Verkehr zeigen, HA-Helfer bleiben
                log("Waze fehlgeschlagen:", repr(e), "- Strecke ohne Verkehr (OSRM)")
                self.fertig(key, dict(obj, quelle="osrm", routen=self.osrm), "osrm")
            self.retry = time.time() + FEHLER_PAUSE
            return
        self.fertig(key, dict(obj, quelle="waze", routen=routen), "waze")
        r = routen[0]
        self.fahrzeit_setzen(r["min"], r["km"], r["min"] - r["frei"], "verkehr", jetzt)
        log(f"Auto waze: {r['name']} {r['min']} min (frei {r['frei']}) {r['km']} km, Stau {[s['min'] for s in r['stau']]}, "
            f"{len(routen) - 1} Alternative, nächste in {takt // 60} min")

    def reise(self, ab, r, jetzt):
        key = r["ab"]
        if key == self.key or time.time() < self.retry:
            return
        try:
            ev = next((e for e in ha_get(f"/calendars/{self.kalender}?start={(ab - dt.timedelta(days=1)):%Y-%m-%dT%H:%M:%SZ}"
                                         f"&end={(ab + dt.timedelta(days=1)):%Y-%m-%dT%H:%M:%SZ}")
                       if "➞" in (e.get("summary") or "") and (e.get("start") or {}).get("dateTime", "")[:16] == key), None)
            if not ev:
                raise RuntimeError("Reise nicht im Kalender gefunden")
            teile = reise_abschnitte(ev.get("description"), ab.date())
            if not teile:
                raise RuntimeError("Keine Zugabschnitte in der Beschreibung")
            abschnitte = []
            for t in teile:
                g = self.bahn.gleis(t["von"], t["nach"], t["ab"].replace(tzinfo=self.tz).astimezone(dt.timezone.utc))
                abschnitte.append({"zug": t["zug"], "nr": t["nr"],
                                   "von": {"name": kurzname(t["von"]), "lat": g["von"][0], "lon": g["von"][1], "ab": f"{t['ab']:%H:%M}", "gleis": t["vg"]},
                                   "nach": {"name": kurzname(t["nach"]), "lat": g["nach"][0], "lon": g["nach"][1], "an": f"{t['an']:%H:%M}", "gleis": t["ng"]},
                                   "pts": g["pts"]})
        except Exception as e:
            log("Bahn fehlgeschlagen:", repr(e))
            self.retry = time.time() + FEHLER_PAUSE
            return
        self.fertig(key, {"aktiv": True, "typ": "bahn", "t": jetzt.isoformat(timespec="seconds"), "schluessel": key,
                          "start": list(self.home), "abschnitte": abschnitte})
        log(f"Bahn {key}: {' → '.join(a['zug'] for a in abschnitte)}, {sum(len(a['pts']) for a in abschnitte)} Punkte")

    def run(self):
        log("Thread gestartet")
        while True:
            try:
                self.tick()
            except Exception as e:
                log("Fehler:", repr(e))
            time.sleep(60)


def start_thread(cfg, home):
    w = RouteWorker(cfg, home)
    threading.Thread(target=w.run, name="route", daemon=True).start()
    return w
