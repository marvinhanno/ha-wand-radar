# Wand-Radar

Prüft jede Minute, ob der DWD ein neues Radarbild (`composite_wn__LATEST.tar`) veröffentlicht hat. Bei neuem Lauf:

1. Vergangenheit (−`past_minutes`) aus den gespeicherten Analysebildern früherer Läufe, Vorhersage +120 min aus dem neuen Lauf.
2. Umrechnung auf den Bildausschnitt (Web-Mercator, Zoom `zoom`, `width`×`height`, Mitte = Zone „Zuhause“ oder `latitude`/`longitude`).
3. Einfärben (feste dBZ-Stützpunkte), je 5-min-Schritt 4 Zwischenbilder per Optical Flow, Grundkarte darunter, Ortsnamen darüber.
4. Ausgabe nach `output_dir` (Standard `/config/www/wand-radar`, im Browser unter `/local/wand-radar/`):
   `still.jpg`, `radar.mp4`, `meta.json` (und `route.json`, s. u.). Beim Start kommt außerdem die Dashboard-Karte `wand-radar-card.js` dazu
   (Dashboard-Ressource `/local/wand-radar/wand-radar-card.js`, Kartentyp `custom:wand-radar`). Ab Karte 1.4 zeichnet sie auch die Route
   (Esri-Kacheln + SVG) mit Umschalter „Route | Radar“, wenn `route.json` aktiv ist und zu den HA-Helfern passt.
   Ab Karte 1.7 (App 0.7.0) zeichnet sie außerdem ein Training: Ist `training_show` (Standard `binary_sensor.wand_training_zeigen`) an und hat
   `training_entity` (Standard `sensor.strava_latest_activity`, Attribute `summary_polyline`, `activity_type`, `distance_km`, `duration_minutes`, `pace`, `name`)
   eine Strecke, erscheint sie im Stil der Route (Leuchtlinie je Sportart, km-Marken, Start/Ziel) mit Umschalter „Training | Radar“.
   Vorrang: Route > Training > Radar. Die Karte liest nur `hass.states`, sie fragt weder Strava noch sonst etwas ab.
   Ab Karte 1.8 (App 0.8.0) liefert dieselbe Datei den zweiten Kartentyp `custom:wand-sport` (Option `art`: `woche`, `letzte`, `jahr`, `monate`, `kalender`, `bestwerte`)
   für eine Dashboard-Ansicht „Sport“: Statistik aus `sensor.strava_stats` bzw. `sensor.strava_latest_activity` (Fork `ha-workouts`), im HA-Kartenstil, ebenfalls nur `hass.states`.
5. MQTT-Sensor `sensor.wand_radar_regen_ab` (Zeitstempel des Regenbeginns am Zuhause-Punkt, sonst „unbekannt“) mit den
   Attributen `regnet_jetzt`, `regen_ab`, `regen_bis`, `regen_dauer_min`, `max_mm_h`, `summe_mm`, `t0`, `verlauf` (mm/h am Zuhause-Punkt, 24 × 5 min ab jetzt).
   Bleiben neue Daten länger als 30 min aus, wird der Sensor „nicht verfügbar“.
6. **Route** (eigener Thread, `route.py`, seit 0.3.0): schreibt jede Minute bei Bedarf `route.json` neben die Radardateien –
   die Strecke, die die Karte im Routenmodus als Hintergrund zeichnet. Gelesen werden die HA-Helfer `input_text.termin_koordinaten`,
   `input_datetime.termin_start`, `input_number.termin_fahrzeit`, `input_number.termin_puffer`, `input_text.wand_reise`,
   `input_boolean.wand_aufbruch_weg`, `input_boolean.dienstreise_modus` und `sensor.wand_aufbruch_quelle`
   (Namen aus der persönlichen HA-Einrichtung; ohne sie bleibt die Route aus).
   - Auto (seit 0.6.0 einzige Quelle der Fahrzeit): einmal je Ziel (Termine bis 24 h voraus) die Fahrzeit ohne Verkehr von OSRM
     (kostenlos) → HA-Helfer `termin_fahrzeit`/`termin_km`, `termin_stau` = 0, `input_text.termin_fahrzeit_quelle` = `frei`,
     `input_datetime.termin_fahrzeit_stand`. Verkehr von Waze erst ab 60 min vor „los“ (los geschätzt mit 1,5 × Fahrzeit ohne
     Verkehr + Puffer), alle 10 min, in den letzten 30 min vor „los“ alle 5 min, bis Terminbeginn – und nur, solange
     `route_presence` an ist, die Aufbruch-Karte nicht weggeklickt und kein Dienstreise-Modus. Jede Waze-Abfrage liefert Route,
     Alternative, Stau-Abschnitte und schreibt die HA-Helfer (`quelle` = `verkehr`, Stau = mit Verkehr − freier Fluss).
     Waze antwortet einfachen Clients seit 30.09.2026 mit 403; dann fragt die App wie pywaze 1.2.3 mit Chrome-Kennung (`curl_cffi`).
     Scheitert Waze, bleibt die letzte Route; gab es noch keine, zeigt die Karte die OSRM-Strecke („Strecke ohne Verkehr“), die
     HA-Helfer bleiben unverändert (Karte zeigt dann das Alter über `termin_fahrzeit_stand`).
   - Bahn: bis 3 h vor der Abfahrt die Zugabschnitte aus dem Kalender der Option `route_calendar` (DB-Navigator-Format), Gleisverlauf von
     Transitous, dauerhaft in `/data/route` zwischengespeichert.
   - Sonst `{"aktiv": false}`. Fehler: alte Datei bleibt, Log `Route: …`, nach 5 min neuer Versuch.
7. **Pause** (seit 0.6.0): Ist `pause_entity` gesetzt und `on` (z. B. nachts), holt und rechnet die App kein Radar und meldet den
   Sensor „nicht verfügbar“. Danach rechnet sie sofort neu (fehlende Vergangenheitsbilder holt sie beim DWD nach, ca. 2 min).

## Optionen

| Option | Standard | Bedeutung |
|---|---|---|
| `latitude`, `longitude` | leer | Kartenmitte; leer = Zone „Zuhause“ |
| `zoom` | 9 | Kartenzoom |
| `width`, `height` | 1366, 1024 | Bildgröße in Pixeln |
| `past_minutes` | 60 | Rückblick |
| `fps` | 18 | Bildrate des Videos |
| `rain_threshold_dbz` | 14 | ab wann es „regnet“ (14 dBZ ≈ 0,2 mm/h) |
| `timezone` | Europe/Berlin | für die Uhrzeiten in `meta.json` |
| `preset` | veryfast | x264-Voreinstellung: schneller = weniger Rechenzeit, größere Datei |
| `output_dir` | `/config/www/wand-radar` | Zielordner |
| `route_calendar` | leer | Kalender-Entität mit den Bahnreisen (`calendar.…`); leer = keine Bahnroute |
| `route_presence` | leer | `binary_sensor` „jemand zu Hause“; aus = keine Verkehrsabfragen. Leer = immer abfragen |
| `pause_entity` | leer | Entität, deren Zustand `on` das Radar pausieren lässt (z. B. nachts); leer = nie |

Route lokal testen: `HA_URL`/`HA_TOKEN` setzen, `WR_ROUTE_JETZT=<ISO-Zeit>` und `WR_ROUTE_REISE=<JSON wie wand_reise>` simulieren Zeit und Reise, `python wand-radar/wand_radar.py --route-once`.

Lokal testen: `pip install -r wand-radar/requirements.txt`, dann `WR_OUTPUT_DIR=out python wand-radar/wand_radar.py --once`.
