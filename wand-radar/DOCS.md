# Wand-Radar

Prüft jede Minute, ob der DWD ein neues Radarbild (`composite_wn__LATEST.tar`) veröffentlicht hat. Bei neuem Lauf:

1. Vergangenheit (−`past_minutes`) aus den gespeicherten Analysebildern früherer Läufe, Vorhersage +120 min aus dem neuen Lauf.
2. Umrechnung auf den Bildausschnitt (Web-Mercator, Zoom `zoom`, `width`×`height`, Mitte = Zone „Zuhause“ oder `latitude`/`longitude`).
3. Einfärben (feste dBZ-Stützpunkte), je 5-min-Schritt 4 Zwischenbilder per Optical Flow, Grundkarte darunter, Ortsnamen darüber.
4. Ausgabe nach `output_dir` (Standard `/config/www/wand-radar`, im Browser unter `/local/wand-radar/`):
   `still.jpg`, `radar.mp4`, `meta.json` (und `route.json`, s. u.). Beim Start kommt außerdem die Dashboard-Karte `wand-radar-card.js` dazu
   (Dashboard-Ressource `/local/wand-radar/wand-radar-card.js`, Kartentyp `custom:wand-radar`). Ab Karte 1.4 zeichnet sie auch die Route
   (Esri-Kacheln + SVG) mit Umschalter „Route | Radar“, wenn `route.json` aktiv ist und zu den HA-Helfern passt.
5. MQTT-Sensor `sensor.wand_radar_regen_ab` (Zeitstempel des Regenbeginns am Zuhause-Punkt, sonst „unbekannt“) mit den
   Attributen `regnet_jetzt`, `regen_ab`, `regen_bis`, `regen_dauer_min`, `max_mm_h`, `summe_mm`, `t0`, `verlauf` (mm/h am Zuhause-Punkt, 24 × 5 min ab jetzt).
   Bleiben neue Daten länger als 30 min aus, wird der Sensor „nicht verfügbar“.
6. **Route** (eigener Thread, `route.py`, seit 0.3.0): schreibt jede Minute bei Bedarf `route.json` neben die Radardateien –
   die Strecke, die die Karte im Routenmodus als Hintergrund zeichnet. Gelesen werden die HA-Helfer `input_text.termin_koordinaten`,
   `input_datetime.termin_start`, `input_number.termin_fahrzeit`, `input_text.wand_reise` und `sensor.wand_aufbruch_quelle`
   (Namen aus der persönlichen HA-Einrichtung; ohne sie bleibt die Route aus).
   - Auto: bis 3 h vor dem Termin die schnellste Route von Waze (inkl. Stau-Abschnitte und eine Alternative), Rückfall OSRM.
   - Bahn: bis 3 h vor der Abfahrt die Zugabschnitte aus dem Kalender der Option `route_calendar` (DB-Navigator-Format), Gleisverlauf von
     Transitous, dauerhaft in `/data/route` zwischengespeichert.
   - Sonst `{"aktiv": false}`. Fehler: alte Datei bleibt, Log `Route: …`, nach 5 min neuer Versuch.

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

Route lokal testen: `HA_URL`/`HA_TOKEN` setzen, `WR_ROUTE_JETZT=<ISO-Zeit>` und `WR_ROUTE_REISE=<JSON wie wand_reise>` simulieren Zeit und Reise, `python wand-radar/wand_radar.py --route-once`.

Lokal testen: `pip install -r wand-radar/requirements.txt`, dann `WR_OUTPUT_DIR=out python wand-radar/wand_radar.py --once`.
