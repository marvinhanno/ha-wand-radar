# ha-wand-radar

Home-Assistant-Add-on: Rechnet das DWD-Regenradar (WN-Komposit, 1 km, 5 min, +2 h Nowcast) auf dem HA-Rechner
zu einem fertigen Standbild und Video (Kartenausschnitt um die Zone „Zuhause“). Das Wandpanel zeigt nur noch die
fertigen Dateien, kein Leaflet, keine Kachel-Filter im Browser.

Installation: In HA unter Einstellungen → Apps → App-Store → ⋮ → Repositories diese URL eintragen:
`https://github.com/marvinhanno/ha-wand-radar`, danach „Wand-Radar“ installieren und starten.

Details siehe [wand-radar/DOCS.md](wand-radar/DOCS.md). Radardaten: © Deutscher Wetterdienst (opendata.dwd.de),
Grundkarte: Esri World Dark Gray.
