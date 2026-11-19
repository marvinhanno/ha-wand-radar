# Wand-Radar

Prüft jede Minute, ob der DWD ein neues Radarbild (`composite_wn__LATEST.tar`) veröffentlicht hat. Bei neuem Lauf:

1. Vergangenheit (−`past_minutes`) aus den gespeicherten Analysebildern früherer Läufe, „jetzt“ = Analyse des neuen Laufs, Vorhersage +5 … +120 min
   (seit 0.19.0) aus der **eigenen Vorhersage** (Option `prognose: eigen`, s. „Eigene Vorhersage“) oder aus der DWD-Vorhersage im Lauf (`prognose: dwd`, bis 0.18.0 immer).
2. Umrechnung auf den Bildausschnitt (Web-Mercator, Zoom `zoom`, `width`×`height`, Mitte = Zone „Zuhause“ oder `latitude`/`longitude`).
3. Einfärben (feste dBZ-Stützpunkte), je 5-min-Schritt 4 Zwischenbilder, Grundkarte darunter, Ortsnamen darüber. Das Video entsteht seit 0.20.0
   nur bei Regen im Bildausschnitt, sonst auf Abruf (s. „Video nur bei Regen, auf Abruf“).
4. Ausgabe nach `output_dir` (Standard `/config/www/wand-radar`, im Browser unter `/local/wand-radar/`):
   `still.jpg`, `radar.mp4` (seit 0.20.0 nur bei Regen bzw. auf Abruf), `meta.json` (und `route.json`, s. u.; mit gesetzten `panel_width`/`panel_height` zusätzlich `still_panel.jpg`). Beim Start kommt außerdem die Dashboard-Karte `wand-radar-card.js` dazu
   (Dashboard-Ressource `/local/wand-radar/wand-radar-card.js`, Kartentyp `custom:wand-radar`). Ab Karte 1.4 zeichnet sie auch die Route
   (Esri-Kacheln + SVG) mit Umschalter „Route | Radar“, wenn `route.json` aktiv ist und zu den HA-Helfern passt.
   Ab Karte 1.7 (App 0.7.0) zeichnet sie außerdem ein Training: Ist `training_show` (Standard `binary_sensor.wand_training_zeigen`) an und hat
   `training_entity` (Standard `sensor.strava_latest_activity`, Attribute `summary_polyline`, `activity_type`, `distance_km`, `duration_minutes`, `pace`, `name`)
   eine Strecke, erscheint sie im Stil der Route (Leuchtlinie je Sportart, km-Marken, Start/Ziel) mit Umschalter „Training | Radar“.
   Vorrang: Route > Training > Radar. Die Karte liest nur `hass.states`, sie fragt weder Strava noch sonst etwas ab.
   Karte 1.8–1.18 (App 0.8.0–0.17.3) enthielt außerdem die Kartentypen `custom:wand-sport` und `custom:wand-training`. Ab Karte 1.19 (App 0.18.0) sind sie
   nicht mehr Teil dieser App; die Datei enthält nur noch `custom:wand-radar`.
   Ab Karte 1.15 (App 0.15.0): Scrollt ein `vertical-stack` der Ansicht (`overflow-y: auto` per card_mod, z. B. die linke Wand-Spalte), holt `custom:wand-radar`
   ihn nach `stapel_sekunden` (Standard 60, 0 = aus) ohne Berührung zurück nach oben.
   Ab Karte 1.18 (App 0.17.3) hat `custom:wand-radar` zwei Haken für andere Karten: Das Fensterereignis `wand-radar-abspielen`
   (`window.dispatchEvent(new CustomEvent("wand-radar-abspielen"))`) startet ▶ wie der eigene Knopf (nur die sichtbare Karte reagiert; zeigt sie gerade
   Route oder Training, schaltet sie erst aufs Radar). Und die Zeitleiste trägt eine Marke „Regen hh:mm“ (blauer Strich + Schild) an der Regenzeit aus
   `regen_entity` (Standard `sensor.wand_radar_regen_ab`), nur wenn der Regen in weniger als 2 h kommt und es noch nicht regnet; bei „unbekannt“/„nicht verfügbar“
   keine Marke. Sie ersetzt dann die bisherige Flagge „Regen ab“ an derselben Stelle.
5. MQTT-Sensor `sensor.wand_radar_regen_ab` (Zeitstempel des Regenbeginns am Zuhause-Punkt, sonst „unbekannt“) mit den
   Attributen `regnet_jetzt`, `regen_ab`, `regen_bis`, `regen_dauer_min`, `max_mm_h`, `summe_mm`, `t0`, `verlauf` (mm/h am Zuhause-Punkt, 24 × 5 min ab jetzt)
   und seit 0.19.0 `prognose` (`eigen` oder `dwd`: welche Vorhersage dieser Lauf tatsächlich genommen hat; steht auch in `meta.json`).
   Bleiben neue Daten länger als 30 min aus, wird der Sensor „nicht verfügbar“.
   Seit 0.20.0 außerdem der Knopf `button.wand_radar_video` („Video rechnen“, MQTT-Discovery am selben Gerät): rechnet das Video zum letzten Lauf, wenn keins vorliegt.
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
   - Bahn: ab 5 h vor der Abfahrt (seit 0.15.1, vorher 3 h) die Zugabschnitte aus dem Kalender der Option `route_calendar` (DB-Navigator-Format), Gleisverlauf von
     Transitous, dauerhaft in `/data/route` zwischengespeichert.
   - Sonst `{"aktiv": false}`. Fehler: alte Datei bleibt, Log `Route: …`, nach 5 min neuer Versuch.
7. **Pause** (seit 0.6.0): Ist `pause_entity` gesetzt und `on` (z. B. nachts), holt und rechnet die App kein Radar und meldet den
   Sensor „nicht verfügbar“. Danach rechnet sie sofort neu (fehlende Vergangenheitsbilder holt sie beim DWD nach, ca. 2 min).

## Video nur bei Regen, auf Abruf (seit 0.20.0)

Das Video ist der größte Rechenposten (181 Bilder je Lauf). Es entsteht deshalb nur, wenn es etwas zeigt:

- **Regen** = im Bildausschnitt (genau das Bild des Videos) mindestens 20 km² Echo ≥ `rain_threshold_dbz` jetzt oder in einem Vorhersagebild,
  oder ICON-D2-RUC zeigt dort in den nächsten 2 h so viel, oder am Zuhause-Punkt regnet es in den nächsten 2 h. Kleinere Flecken sind meist Störechos.
  Dann wie bisher bei jedem Lauf ein neues `radar.mp4`.
- **Trocken** = nichts davon: Es entstehen nur `still.jpg`, `still_panel.jpg`, `meta.json` (`"video": false`) und der Sensor; ein altes `radar.mp4` wird gelöscht.
  Die Karte (ab 1.20) drückt bei ▶ dann `button.wand_radar_video`; die App rechnet das Video aus den Bildern des letzten Laufs (nichts neu laden, wenige Sekunden),
  schreibt `meta.json` mit `"video": true` und neuer `version` (t0 + 1), die Karte spielt ab. Das Abruf-Video gilt bis zum nächsten Lauf.
- **Sparsamer gerechnet:** Einfärben über ein Index-Bild und Tabellen; bis 16 % Regenpixel nur diese, darüber das ganze Bild in OpenCV, mit einem Thread (seit 0.20.2; auf 2 Kernen bremsen OpenCV-Threads nur gegen ffmpeg). Auf einem Ryzen 5700G mit 2 Kernen je Bild 7–20 ms statt 8–65 ms bis 0.19.0, Abweichung ≤ 1/255;
  eingefärbte Bilder der Vergangenheit bleiben von Lauf zu Lauf im Speicher (zlib, bei starkem Regen ≈ 85 MB, trocken wenige MB), jeder Lauf rechnet nur das
  neue Paar; die Zwischenbilder der Vorhersage kommen direkt aus dem Bewegungsfeld der eigenen Vorhersage statt per Optical Flow. Log je Video:
  `Zeiten: Zwischenbilder … s, Einfärben … s, aus Speicher n Bilder (… MB), an ffmpeg … s, warten … s, ffmpeg-CPU … s`, je Lauf `Wand-Ausschnitt: …` und
  `fertig in … s (CPU … s mit ffmpeg)` (seit 0.20.1; die CPU-Zeit ist das Maß für den Strom, auf 2 Kernen teilen sich Einfärben und ffmpeg die Wandzeit).

Lokal: `WR_AT=… python wand-radar/wand_radar.py --abruf` rechnet einen Lauf und danach das Video wie über den Knopf.

## Eigene Vorhersage (seit 0.19.0)

Die DWD-Vorhersage (`composite_wn`) verschiebt das Radarbild nur starr. Die eigene Vorhersage **DA50** (`prognose.py`, `vorhersage.py`) rechnet je Lauf
in einem Gebiet von ≈ 500 × 500 km um die Kartenmitte:

- ein dichtes Bewegungsfeld aus den Analysen der letzten 20 min (Optical Flow DIS auf 2 km, geglättet, trockene Flächen aus der Umgebung gefüllt) und verschiebt
  das Bild von „jetzt“ damit rückwärts (gekrümmte Bahnen, Drehung bleibt),
- mischt die simulierte Reflektivität des Wettermodells ICON-D2-RUC (`DBZ_CMAX`, opendata.dwd.de) ein, vorher per Quantil-Abgleich an das Radar angeglichen;
  Gewicht linear von 0 auf 0,5 bei +120 min (so wachsen oder zerfallen Regengebiete, wie das Modell es erwartet).

ICON-D2-RUC kommt stündlich, ≈ 40 min nach Laufbeginn; die App holt davon nur Laufbeginn + 30 … 225 min (14 Felder, ≈ 11 MB je Stunde) – so weit, wie die +2-h-Vorhersage bei einem bis zu 100 min alten Lauf braucht. Die Zuordnung der Modellzellen
zum Radargitter wird einmal berechnet und liegt wie der letzte Modelllauf in `/data`. Auf einem Ryzen 5700G kostet die Vorhersage ≈ 0,3 s je Lauf.

- **Rückweg:** Bei einem Fehler, oder wenn nach einem Neustart weniger als zwei der drei 10-min-Bildpaare für das Bewegungsfeld vorliegen, nimmt der Lauf
  die DWD-Vorhersage und schreibt den Grund ins Log (`Vorhersage: …`). Fehlt nur das Modell, rechnet die App ohne Einmischen (nur das Bewegungsfeld).
- **Sparsam:** Zeigt weder das Radar im Gebiet ein Echo ≥ `rain_threshold_dbz` noch das Modell dort Regen, wird nichts gerechnet (alle Felder trocken).
- Log je Lauf: `Vorhersage: eigen DA50, RUC 06Z (60 min alt, 24/24 Schritte), Regenfläche 24.4 %, Rechnen 0.47 s, …`.

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
| `panel_width`, `panel_height` | 0 (aus) | Größe eines zweiten, kleinen Standbilds `still_panel.jpg` (nur „jetzt“, gleiche Farben und Karte wie `still.jpg`, Mitte = dieselbe Kartenmitte) für ein kleines Bedienpanel, z. B. 600×720. Wird nur zusammen mit dem Standbild der Wand und nur bei einem neuen Radarlauf gerechnet (ein Bild, < 2 s), nicht als Video. 0 = es entsteht keine Datei (eine vorhandene alte Datei wird dann gelöscht, ebenso nach einem Fehler beim Rechnen) |
| `panel_zoom` | 0 | Kartenzoom des Panel-Standbilds; 0 = wie `zoom`. Ein kleinerer Wert zeigt ein größeres Gebiet (Zoom 8 bei 600 px ≈ 230 km breit) |
| `prognose` | eigen | Quelle der Vorhersage +5 … +120 min: `eigen` (DA50, s. „Eigene Vorhersage“) oder `dwd` (DWD-Vorhersage aus dem Radarlauf, Verhalten bis 0.18.0) |
| `archiv_tage` | 0 (aus) | **Nur für eine Messphase** (eigene Regenvorhersage, seit 0.17.0): legt je Lauf das Analysebild (≈ 500 × 500 km um Zuhause, 1 km), alle 15 min die DWD-Vorhersage bei +30/+60/+120 min samt Reihe am Zuhause-Punkt und je Stunde einen ICON-D2-RUC-Lauf (`DBZ_CMAX` 0 … 240 min, 2 km) nach `/share/wand-radar-archiv/`; Tage älter als `archiv_tage` werden gelöscht. ≈ 50 MB je Regentag, ≈ 14 MB Download je Stunde für RUC. Eigener Thread mit Log-Präfix `Archiv:` – ein Fehler dort hält das Radar nicht auf |
| `prognose_test` | aus | **Nur für die Messphase:** rechnet alle 15 min die Vorhersage-Kandidaten aus `prognose.py` (seit 0.19.0 nur noch A und DA50; bis 0.18.0 A, A2, Bm, D) zusätzlich und schreibt nur die Rechenzeiten ins Log (`Prognose-Test: …`). Ändert keine Ausgabe. Holt dafür wie `archiv_tage` stündlich ICON-D2-RUC |

Route lokal testen: `HA_URL`/`HA_TOKEN` setzen, `WR_ROUTE_JETZT=<ISO-Zeit>` und `WR_ROUTE_REISE=<JSON wie wand_reise>` simulieren Zeit und Reise, `python wand-radar/wand_radar.py --route-once`.

Lokal testen: `pip install -r wand-radar/requirements.txt`, dann `WR_OUTPUT_DIR=out python wand-radar/wand_radar.py --once`.
Ein älterer Lauf: `WR_AT=<JJJJMMTT_HHMM>` (UTC, DWD hält das Radar 48 h, ICON-D2-RUC ≈ 24 h); `WR_PROGNOSE=dwd` zum Vergleich.
