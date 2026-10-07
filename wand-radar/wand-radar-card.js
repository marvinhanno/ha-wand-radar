// wand-radar 1.12 (Routen- und Trainingsmodus, Elemente für die Ansichten „Sport“ und „Training“) – Radar-Hintergrund der Wand-Ansicht aus dem vorgerechneten DWD-Radar (HA-Add-on „Wand-Radar“).
// Ersetzt weather-radar-card + wand-radar-play. Kein Leaflet: Standbild (still.jpg) und Video (radar.mp4) aus /local/wand-radar/.
// Zustände: ruhe (Standbild „jetzt“, Karten sichtbar) · laeuft (Video) · angehalten (Video steht, Karten bleiben aus).
// - ▶ spielt ab (aus Ruhe von vorn, aus „angehalten“ ab dort). ⏸ oder Tippen/Ziehen auf der Zeitleiste hält an.
//   „Jetzt“ → Ruhe. 60 s nach der letzten Berührung → Ruhe.
// - Setzt --wand-seiten (1/0), --wand-seiten-x (0/1), --wand-seiten-pe (auto/none) auf <html>; die übrigen Karten
//   blenden damit beim Abspielen aus (vererbt sich durch Shadow-DOM, iOS 16 kann kein :host-context).
// - Aufwach-Erkennung wie in wand-radar-play 1.2 (War die Seite > 20 min eingefroren → neu laden, sobald HA erreichbar ist).
// - Routenmodus (seit 1.4): Steht links die Aufbruch-Karte (sensor.wand_aufbruch_quelle = termin/reise) und die App hat route.json
//   geschrieben, zeichnet die Karte statt des Radars die Route (Esri-Kacheln + SVG). Umschalter „Route | Radar“ unten rechts.
//   Setzt --wand-mitte (1/0) auf <html>, damit die Wetterkarte in der Mitte ausblendet.
// - Trainingsmodus (seit 1.7): Ist binary_sensor.wand_training_zeigen an und hat sensor.strava_latest_activity eine Strecke (summary_polyline),
//   zeichnet die Karte die Strecke im selben Stil wie die Route (Leuchtlinie in Sportartfarbe, km-Marken, Start/Ziel). Vorrang: Route > Training > Radar.
//   Umschalter dann „Training | Radar“. Keine Strava-Abfrage hier, nur hass.states.
// - Ansicht „Sport“ (seit 1.8): zweites Element custom:wand-sport (art: woche | letzte | jahr | monate | kalender | bestwerte) in derselben Datei.
//   Liest nur sensor.strava_stats bzw. sensor.strava_latest_activity (hass.states), keine Abfrage, im HA-Kartenstil (ha-card, Theme-Variablen).
// - Training (seit 1.10): drittes Element custom:wand-training (art: heute = Heute-Karte der Wand mit Strichfigur);
//   seit 1.11 mit Lauf-Aussehen (Laufwetter aus sensor.laufwetter: trocken bis, Stundenleiste, bestes Fenster, morgen); liest sensor.training_heute, die Übungen (einheiten) stehen in der Kartenkonfiguration der Ansicht „training“.
//   seit 1.12 Ansicht „Training“: art: naechste (Winter|Sommer, A/B/C, Start/Erledigt/Woche aussetzen, Korrektur) · einheit (Aufwärmen, Übungen mit Figur, Timer, Pausenleiste) · saison;
//   Figuren für alle Übungen von A/B/C und das Aufwärmen.
// Konfiguration: type: custom:wand-radar, base: /local/wand-radar, max_seconds: 60, stale_min: 20,
//   training_entity: sensor.strava_latest_activity, training_show: binary_sensor.wand_training_zeigen
const WAND_WAKE_GAP = 20 * 60 * 1000;
function wandSeiten(playing) {
  const s = document.documentElement.style;
  s.setProperty('--wand-seiten', playing ? '0' : '1');
  s.setProperty('--wand-seiten-x', playing ? '1' : '0');
  s.setProperty('--wand-seiten-pe', playing ? 'none' : 'auto');
}
function wandReload(btn) {
  if (window.__wandReloading) return;
  window.__wandReloading = true;
  if (btn) btn.classList.add('busy');
  let n = 0;
  const tryIt = () => {
    fetch('/manifest.json?t=' + Date.now(), { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); location.reload(); })
      .catch(() => {
        n += 1;
        if (n < 120) setTimeout(tryIt, 5000);
        else { window.__wandReloading = false; if (btn) btn.classList.remove('busy'); }
      });
  };
  tryIt();
}
if (!window.__wandWatchdog) {
  window.__wandWatchdog = true;
  window.__wandActive = 0;
  let last = Date.now();
  let hiddenAt = 0;
  const wake = () => { if (window.__wandActive > 0) wandReload(null); };
  setInterval(() => {
    const now = Date.now();
    if (now - last > WAND_WAKE_GAP) wake();
    last = now;
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > WAND_WAKE_GAP) wake();
    hiddenAt = 0;
  });
}

// Farbskala = dieselben dBZ-Stützpunkte wie im Add-on (wand_radar.py, STOPS)
const WR_STOPS = [[8, '#3a7bd5', 0], [14, '#3a7bd5', 0.55], [21, '#2ba8de', 0.8], [28, '#2ec4b6', 0.9], [34, '#8bd450', 0.95],
  [40, '#f6d743', 1], [46, '#ff9f1c', 1], [52, '#ff4d4d', 1], [58, '#e040c8', 1], [65, '#f3c6ff', 1]];
const wrHex = (h) => [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16));
function wrColor(dbz) {
  if (dbz <= WR_STOPS[0][0]) return null;
  for (let i = 1; i < WR_STOPS.length; i++) {
    if (dbz <= WR_STOPS[i][0]) {
      const [d0, c0, a0] = WR_STOPS[i - 1], [d1, c1, a1] = WR_STOPS[i], f = (dbz - d0) / (d1 - d0), A = wrHex(c0), B = wrHex(c1);
      return [A.map((v, k) => Math.round(v + (B[k] - v) * f)), a0 + (a1 - a0) * f];
    }
  }
  return [[243, 198, 255], 1];
}
const wrRgba = (c, a) => `rgba(${c.join(',')},${a === undefined ? 1 : a.toFixed(2)})`;
const pad = (n) => String(n).padStart(2, '0');

const WR_CSS = `
  :host { display: block; position: relative; height: 100vh; overflow: hidden; background: #0b0d10; color: #e8eaed;
    font-family: Roboto, system-ui, sans-serif; -webkit-user-select: none; user-select: none;
    pointer-events: none; }   /* nur Bedienelemente fangen Berührungen */
  .btn, .track, .jetzt { pointer-events: auto; }
  * { box-sizing: border-box; }
  #still, #vid { position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: cover; }
  #vid { opacity: 0; transition: opacity .25s linear; }
  .vshow #vid { opacity: 1; }
  .shade { position: absolute; inset: 0; pointer-events: none; transition: opacity .35s ease; }
  #shadeRest { background: linear-gradient(180deg, rgba(8,9,11,.9) 0%, rgba(8,9,11,.55) 18%, rgba(8,9,11,0) 36%, rgba(8,9,11,0) 66%, rgba(8,9,11,.75) 74%, rgba(8,9,11,.97) 80%, #0b0d10 100%); }
  #shadePlay { opacity: 0; background: linear-gradient(180deg, rgba(8,9,11,.85) 0%, rgba(8,9,11,.4) 16%, rgba(8,9,11,0) 30%, rgba(8,9,11,0) 82%, rgba(8,9,11,.8) 100%); }
  .playing #shadeRest { opacity: 0; } .playing #shadePlay { opacity: 1; }
  .home { position: absolute; left: 50%; top: 50%; width: 0; height: 0; pointer-events: none; }
  .home::before { content: ''; position: absolute; left: -9px; top: -9px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 3px rgba(0,0,0,.35); }
  .home::after { content: ''; position: absolute; left: -18px; top: -18px; width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,.35); opacity: 0; }
  .playing .home::after { animation: puls 2.4s ease-out infinite; }
  @keyframes puls { 0% { transform: scale(.45); opacity: .8; } 100% { transform: scale(1.5); opacity: 0; } }

  /* Radar-Leiste: Ruhe = über der unteren Reihe, Abspielen = ganz unten */
  .rl { position: absolute; left: 0; right: 0; bottom: 228px; height: 70px; z-index: 30; pointer-events: none;   /* z-index: Beim Abspielen liegt die Leiste über der ausgeblendeten unteren Reihe (deren Innenteile fangen sonst noch Berührungen) */
    transition: transform .35s cubic-bezier(.3,.7,.2,1); }
  .playing .rl { transform: translateY(214px); }
  button { -webkit-tap-highlight-color: transparent; outline: none; font-family: inherit; }
  .btn { position: absolute; left: 20px; top: 8px; width: 56px; height: 56px; border: 0; background: transparent; padding: 0; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .btn .k { width: 42px; height: 42px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(17,19,23,.8); border: 1px solid rgba(255,255,255,.1); color: #d4d7dc; }
  .playing .btn .k { color: #ff9f0a; border-color: rgba(255,159,10,.45); }
  .btn svg { width: 22px; height: 22px; fill: currentColor; }
  .lbl { position: absolute; left: 92px; top: 14px; display: flex; align-items: baseline; gap: 10px; font-size: 11px; font-weight: 600; letter-spacing: .08em; color: #8b9099; white-space: nowrap; }
  .lbl .t { color: #d4d7dc; font-size: 11px; letter-spacing: .04em; transition: font-size .3s; font-variant-numeric: tabular-nums; }
  .playing .lbl .t { font-size: 20px; letter-spacing: 0; color: #f5f5f7; }
  .lbl .rel { color: #d4d7dc; letter-spacing: .02em; font-size: 12px; font-weight: 500; }
  .lbl .fc { display: none; padding: 1px 6px; border-radius: 6px; background: rgba(255,255,255,.1); font-size: 10px; letter-spacing: .06em; color: #b4b8bf; }
  .lbl .fc.on { display: inline; }
  .stale .lbl .t, .stale .lbl .rel { color: #6b7079; }
  .track { position: absolute; left: 92px; right: 28px; top: 36px; height: 24px; cursor: pointer; touch-action: none; }
  .rail { position: absolute; left: 0; right: 0; top: 10px; height: 4px; border-radius: 2px; overflow: hidden; }
  .past { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(255,255,255,.28); }
  .fut { position: absolute; top: 0; bottom: 0; right: 0; background: repeating-linear-gradient(90deg, rgba(255,255,255,.2) 0 6px, transparent 6px 10px); }
  .stale .past, .stale .fut { opacity: .5; }
  .rainstrip { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
  .fill { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(255,255,255,.75); width: 0; opacity: 0; }
  .playing .fill { opacity: 1; }
  .ticks { position: absolute; left: 0; right: 0; top: 17px; height: 12px; font-size: 9px; color: #6b7079; font-variant-numeric: tabular-nums; }
  .ticks i { position: absolute; top: -4px; width: 1px; height: 4px; background: rgba(255,255,255,.25); }
  .ticks span { position: absolute; transform: translateX(-50%); top: 1px; }
  .now { position: absolute; top: 6.5px; width: 11px; height: 11px; margin-left: -5.5px; border-radius: 50%; background: #ff9f0a; box-shadow: 0 0 0 2px rgba(8,9,11,.9); }
  .head { position: absolute; top: 4px; width: 16px; height: 16px; margin-left: -8px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 3px rgba(8,9,11,.6); opacity: 0; transition: opacity .2s; }
  .playing .head { opacity: 1; }
  .hold .head { background: #ff9f0a; }
  .flag { position: absolute; bottom: 19px; transform: translateX(-2px); display: none; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: #5ac8fa; white-space: nowrap; }
  .flag::before { content: ''; width: 2px; height: 14px; background: #5ac8fa; border-radius: 1px; transform: translateY(5px); }
  .flag.on { display: flex; }
  .flag.right { transform: translateX(calc(-100% + 2px)); flex-direction: row-reverse; }
  .jetzt { position: absolute; left: 480px; top: 0; height: 40px; padding: 0 16px 0 12px; border-radius: 20px; border: 1px solid rgba(255,255,255,.12);
    background: rgba(17,19,23,.8); color: #d4d7dc; font: 600 13px Roboto, sans-serif; display: flex; align-items: center; gap: 6px; cursor: pointer;
    opacity: 0; pointer-events: none; transition: opacity .2s; }
  .jetzt svg { width: 18px; height: 18px; fill: currentColor; }
  .hold .jetzt { opacity: 1; pointer-events: auto; }
  .legend { position: absolute; right: 28px; top: 12px; display: flex; align-items: center; gap: 8px; font-size: 10px; color: #8b9099; opacity: 0; transition: opacity .3s; pointer-events: none; }
  .playing .legend { opacity: 1; }
  .legend .g { position: relative; width: 190px; height: 6px; border-radius: 3px; }
  .legend .g span { position: absolute; top: 9px; transform: translateX(-50%); font-size: 9px; color: #6b7079; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .msg { position: absolute; left: 0; right: 0; top: 40%; text-align: center; font-size: 15px; color: #6b7079; pointer-events: none; }
  /* Routenmodus */
  #route { position: absolute; inset: 0; overflow: hidden; background: #0b0d10; opacity: 0; transition: opacity .4s ease; pointer-events: none; }
  .rview #route { opacity: 1; }
  .rview .home { opacity: 0; }
  .rview #shadeRest { background: linear-gradient(180deg, rgba(8,9,11,.9) 0%, rgba(8,9,11,.5) 18%, rgba(8,9,11,0) 32%, rgba(8,9,11,0) 66%, rgba(8,9,11,.75) 74%, rgba(8,9,11,.97) 80%, #0b0d10 100%); }
  .rview .btn, .rview .lbl, .rview .track, .rview .jetzt, .rview .legend { visibility: hidden; }
  .rsum { position: absolute; left: 28px; right: 246px; top: 8px; height: 48px; display: flex; align-items: center; gap: 12px; white-space: nowrap;
    visibility: hidden; opacity: 0; transition: opacity .4s ease, visibility .4s; pointer-events: none; }
  .rview .rsum { visibility: visible; opacity: 1; }
  .rsum .k { font-size: 11px; font-weight: 600; letter-spacing: .08em; color: #8b9099; }
  .rsum .g { font-size: 17px; font-weight: 700; color: #f5f5f7; }
  .rsum .o { font-size: 13px; color: #ffb74d; }
  .rsum .r { margin-left: auto; font-size: 12px; font-weight: 500; color: #8b9099; }
  .sw { position: absolute; right: 28px; top: -20px; display: none; padding: 4px; border-radius: 22px; background: rgba(17,19,23,.8); border: 1px solid rgba(255,255,255,.1); pointer-events: auto; }
  .hasroute .sw { display: flex; }
  .rview .sw { top: 10px; }
  .sw button { display: inline-flex; align-items: center; gap: 7px; height: 36px; padding: 0 14px; border-radius: 18px; border: 0; background: transparent; color: #8b9099; font: 600 13px Roboto, sans-serif; cursor: pointer; }
  .sw button.on { background: rgba(255,255,255,.14); color: #f5f5f7; }
  .sw ha-icon { --mdc-icon-size: 18px; color: currentColor; }
  .hasroute .legend { right: 250px; }
  .rchip { position: absolute; left: 0; top: 0; white-space: nowrap; padding: 6px 11px; border-radius: 12px; background: rgba(17,19,23,.82); border: 1px solid rgba(255,255,255,.12);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); font: 600 13px Roboto, sans-serif; color: #e8eaed; display: flex; align-items: center; gap: 7px; }
  .rchip ha-icon { --mdc-icon-size: 15px; flex: none; }
  .rchip .d { color: #8b9099; font-weight: 500; }
  .rchip .o { color: #ffb74d; }
  .rchip .x { color: #ff6b6b; }
  .rdot { position: absolute; border-radius: 50%; box-sizing: border-box; }
`;

const WR_HTML = `<div id="root">
  <img id="still" alt="">
  <div id="route"></div>
  <video id="vid" muted playsinline preload="auto"></video>
  <div class="shade" id="shadeRest"></div><div class="shade" id="shadePlay"></div>
  <div class="home"></div>
  <div class="msg" id="msg"></div>
  <div class="rl">
    <button class="btn" id="play" aria-label="Radar abspielen"><span class="k"><svg viewBox="0 0 24 24" id="ico"><path d="M8 5.14v14l11-7-11-7z"/></svg></span></button>
    <div class="lbl"><span>RADAR · DWD</span><span class="t" id="tt"></span><span class="rel" id="rel"></span><span class="fc" id="fc">VORHERSAGE</span></div>
    <button class="jetzt" id="jetzt" aria-label="Zurück zu jetzt"><svg viewBox="0 0 24 24"><path d="M13.5 8H12v5l4.3 2.5.7-1.2-3.5-2.1V8zM13 3a9 9 0 0 0-9 9H1l3.9 3.9L8.8 12H6a7 7 0 1 1 2.1 5l-1.4 1.4A9 9 0 1 0 13 3z"/></svg>Jetzt</button>
    <div class="rsum" id="rsum"></div>
    <div class="sw" id="sw"><button id="swRoute"><ha-icon icon="mdi:map-marker-path"></ha-icon>Route</button><button id="swRadar"><ha-icon icon="mdi:weather-pouring"></ha-icon>Radar</button></div>
    <div class="legend"><span>leicht</span><div class="g" id="lg"></div><span>Unwetter</span></div>
    <div class="track" id="track">
      <div class="rail"><div class="past" id="past"></div><div class="fut" id="fut"></div><div class="fill" id="fill"></div><canvas class="rainstrip" id="strip"></canvas></div>
      <div class="ticks" id="ticks"></div>
      <div class="flag" id="flag"></div>
      <div class="now" id="now"></div>
      <div class="head" id="head"></div>
    </div>
  </div>
</div>`;

// ---------- Routenkarte (Web-Mercator wie Leaflet, stufenloser Zoom, Kacheln der nächsthöheren ganzen Stufe) ----------
const WR_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
const WR_ZOOM_MAX = 16;                      // höchste Kachelstufe der Esri-Grundkarte; kurze Strecken werden bis dahin herangezoomt
const WR_ROUTE_STATES = ['sensor.wand_aufbruch_quelle', 'input_text.termin_koordinaten', 'input_datetime.termin_start', 'input_text.termin_ort',
  'input_text.wand_reise', 'input_text.wand_reise_live'];
const wrEsc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const wrIcon = (i, c) => `<ha-icon icon="${i}"${c ? ` style="color:${c}"` : ''}></ha-icon>`;
function wrMerc(z, p) {                      // p = [lat, lon] -> Pixel bei Zoom z
  const w = 256 * Math.pow(2, z), s = Math.sin(p[0] * Math.PI / 180);
  return [(p[1] + 180) / 360 * w, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * w];
}
// Punkte stufenlos in die Bühne (x0,y0,x1,y1) einpassen
function wrFit(punkte, b) {
  const p0 = punkte.map((q) => wrMerc(0, q)), xs = p0.map((q) => q[0]), ys = p0.map((q) => q[1]);
  const mn = (a) => a.reduce((x, y) => Math.min(x, y)), mx = (a) => a.reduce((x, y) => Math.max(x, y));
  const bw = Math.max(mx(xs) - mn(xs), 1e-9), bh = Math.max(mx(ys) - mn(ys), 1e-9);
  const zf = Math.min(WR_ZOOM_MAX, Math.log2(Math.min((b.x1 - b.x0) / bw, (b.y1 - b.y0) / bh)));
  const zi = Math.max(0, Math.ceil(zf)), sc = Math.pow(2, zf - zi), f = Math.pow(2, zf);
  const ox = (mn(xs) + mx(xs)) / 2 * f - (b.x0 + b.x1) / 2, oy = (mn(ys) + mx(ys)) / 2 * f - (b.y0 + b.y1) / 2;
  return { zi, sc, ox, oy, P: (q) => { const m = wrMerc(0, q); return [m[0] * f - ox, m[1] * f - oy]; } };
}
function wrTiles(K, W, H) {
  let h = '';
  const T = 256 * K.sc;
  for (const [layer, stil] of [['World_Dark_Gray_Base', 'filter:brightness(.5)'], ['World_Dark_Gray_Reference', '']]) {
    for (let tx = Math.floor(K.ox / T); tx <= Math.floor((K.ox + W) / T); tx++) {
      for (let ty = Math.floor(K.oy / T); ty <= Math.floor((K.oy + H) / T); ty++) {
        if (tx < 0 || ty < 0 || tx >= Math.pow(2, K.zi) || ty >= Math.pow(2, K.zi)) continue;
        h += `<img alt="" src="${WR_TILES}${layer}/MapServer/tile/${K.zi}/${ty}/${tx}" style="position:absolute;left:${tx * T - K.ox}px;top:${ty * T - K.oy}px;width:${T + 0.5}px;height:${T + 0.5}px;${stil}">`;
      }
    }
  }
  return h;
}
const wrPath = (P, pts) => pts.map((q, i) => { const [x, y] = P(q); return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }).join('');
function wrPointAt(P, pts, f) {              // Punkt bei Anteil f der (Pixel-)Länge
  const p = pts.map(P), seg = []; let L = 0;
  for (let i = 1; i < p.length; i++) { const d = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); seg.push(d); L += d; }
  let z = L * f;
  for (let i = 1; i < p.length; i++) {
    if (z <= seg[i - 1]) { const t = seg[i - 1] ? z / seg[i - 1] : 0; return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t]; }
    z -= seg[i - 1];
  }
  return p[p.length - 1];
}
const wrMin = (hm) => parseInt(hm.slice(0, 2), 10) * 60 + parseInt(hm.slice(3, 5), 10);
const wrDauer = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${pad(m % 60)} min` : `${m} min`);
const wrFern = (zug) => /^(ICE|IC|EC|TGV|RJX?|NJ|EN)\b/.test(zug || '');

// ---------- Training (Strava) ----------
// Farben je Sportart: Hof, Linie, Symbol (wie die Kontextkarte „Training“ links)
const WR_SPORT = {
  running: ['#fc5200', '#ff8a50', 'mdi:run'], cycling: ['#4fc3f7', '#8fdcfb', 'mdi:bike'], walking: ['#81c995', '#a8dbb5', 'mdi:walk'],
  swimming: ['#b39ddb', '#cfc0ec', 'mdi:swim'], hiking: ['#c5a46d', '#dcc392', 'mdi:hiking'], strength_training: ['#ce93d8', '#e1b8e8', 'mdi:dumbbell'],
  yoga: ['#f48fb1', '#f8b5cb', 'mdi:yoga'], other: ['#9e9e9e', '#c4c4c4', 'mdi:dots-horizontal'],
};
function wrDecode(s) {                       // Google-Polyline, Präzision 5 -> [[lat, lon], …]
  const out = []; let i = 0, lat = 0, lon = 0;
  while (i < s.length) {
    for (let k = 0; k < 2; k++) {
      let sh = 0, res = 0, b;
      do { b = s.charCodeAt(i++) - 63; res |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    out.push([lat / 1e5, lon / 1e5]);
  }
  return out;
}
const wrMeter = (a, b) => {                  // Luftlinie in m (Haversine)
  const r = Math.PI / 180, dl = (b[0] - a[0]) * r, dn = (b[1] - a[1]) * r;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dn / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
};
const wrZahl = (v, n) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: n, maximumFractionDigits: n });
const wrHM = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function wrTempo(typ, km, min, pace) {       // Anzeige-Tempo je Sportart; leer, wenn keine Strecke
  if (!km || !min) return '';
  if (typ === 'cycling') return `${wrZahl(km / (min / 60), 1)} km/h`;
  if (typ === 'swimming') { const s = Math.round(min * 60 / (km * 10)); return `${Math.floor(s / 60)}:${pad(s % 60)} /100 m`; }
  if (typ === 'running' || typ === 'walking' || typ === 'hiking') return pace || '';
  return '';
}

class WandRadar extends HTMLElement {
  setConfig(c) {
    this._cfg = Object.assign({ base: '/local/wand-radar', max_seconds: 60, stale_min: 20,
      training_entity: 'sensor.strava_latest_activity', training_show: 'binary_sensor.wand_training_zeigen' }, c || {});
  }
  set hass(h) {
    this._hass = h;
    const sig = WR_ROUTE_STATES.map((e) => (h && h.states[e] ? h.states[e].state : '')).join('|');
    const t = h && h.states[this._cfg.training_entity], z = h && h.states[this._cfg.training_show];
    const a = t ? t.attributes || {} : {};
    const tsig = [z ? z.state : '', t ? t.state : '', a.source_id, a.name, a.distance_km, a.duration_minutes, (a.summary_polyline || '').length].join('|');
    if (sig !== this._rsig || tsig !== this._tsig) { this._rsig = sig; this._tsig = tsig; if (this._$) this._sync(); }
  }
  getCardSize() { return 1; }

  connectedCallback() {
    if (!this.shadowRoot) {
      const r = this.attachShadow({ mode: 'open' });
      r.innerHTML = `<style>${WR_CSS}</style>${WR_HTML}`;
      this._$ = (id) => r.getElementById(id);
      this._root = this._$('root');
      this._buildLegend();
      const play = this._$('play');
      play.addEventListener('click', (e) => { e.stopPropagation(); this._state === 'laeuft' ? this._hold() : this._play(); });
      this._$('jetzt').addEventListener('click', (e) => { e.stopPropagation(); this._stop(); });
      const vid = this._$('vid');
      vid.addEventListener('playing', () => { if (this._state !== 'ruhe') this._root.classList.add('vshow'); });
      vid.addEventListener('seeked', () => { if (this._state !== 'ruhe') this._root.classList.add('vshow'); });
      vid.addEventListener('pause', () => { if (this._state === 'laeuft' && !vid.ended && !this._scrub) this._hold(); });   // z. B. von iOS unterbrochen
      vid.addEventListener('ended', () => {
        if (this._state === 'laeuft' && !this._scrub) {
          this._holdT = setTimeout(() => { if (this._state === 'laeuft') { vid.currentTime = 0; vid.play(); } }, 1500);
        }
      });
      const tr = this._$('track');
      const seek = (e) => {
        const b = tr.getBoundingClientRect(), p = Math.max(0, Math.min(1, (e.clientX - b.left) / b.width));
        vid.currentTime = p * this._total();
        this._show(vid.currentTime, false);
      };
      tr.addEventListener('pointerdown', (e) => { e.stopPropagation(); this._scrub = true; this._hold(); try { tr.setPointerCapture(e.pointerId); } catch (_) { /* synthetische Ereignisse */ } seek(e); });
      tr.addEventListener('pointermove', (e) => { if (this._scrub) { seek(e); this._touch(); } });
      tr.addEventListener('pointerup', () => { if (!this._scrub) return; this._scrub = false; this._setState('angehalten'); });
      tr.addEventListener('pointercancel', () => { this._scrub = false; });
      this._$('swRoute').addEventListener('click', (e) => { e.stopPropagation(); this._selectView('karte'); });
      this._$('swRadar').addEventListener('click', (e) => { e.stopPropagation(); this._selectView('radar'); });
      if (window.ResizeObserver) {
        new ResizeObserver(() => this._drawStrip()).observe(tr);
        let rt = 0, rw = 0;
        new ResizeObserver(() => { const w = this._root.clientWidth; if (w === rw) return; rw = w; clearTimeout(rt); rt = setTimeout(() => { if (this._sv) this._drawSv(); }, 300); }).observe(this._root);
      }
      this._state = 'ruhe';
    }
    window.__wandActive = (window.__wandActive || 0) + 1;
    wandSeiten(false);
    this._loadMeta();
    this._loadRoute();
    this._sync();
    this._poll = setInterval(() => { this._loadMeta(); this._loadRoute(); }, 60000);
  }
  disconnectedCallback() {
    clearInterval(this._poll); clearTimeout(this._auto); clearTimeout(this._holdT); clearTimeout(this._rauto); wandSeiten(false);
    document.documentElement.style.setProperty('--wand-mitte', '1');
    window.__wandActive = Math.max(0, (window.__wandActive || 1) - 1);
  }

  _buildLegend() {
    const lo = 12, hi = 60, st = [], lg = this._$('lg');
    for (let d = lo; d <= hi; d += 2) { const [c] = wrColor(d) || [[0, 0, 0]]; st.push(`${wrRgba(c)} ${((d - lo) / (hi - lo) * 100).toFixed(1)}%`); }
    lg.style.background = `linear-gradient(90deg, ${st.join(',')})`;
    for (const [d, t] of [[14, '0,2'], [28, '2'], [40, '12'], [52, '60 mm/h']]) {
      const s = document.createElement('span'); s.style.left = ((d - lo) / (hi - lo) * 100) + '%'; s.textContent = t; lg.appendChild(s);
    }
  }

  // ---- Daten laden (meta.json alle 60 s; neue Bilder nur in Ruhe einsetzen) ----
  _loadMeta() {
    fetch(`${this._cfg.base}/meta.json?t=${Date.now()}`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((m) => { this._pending = m; this._apply(); })
      .catch(() => { if (!this._meta) this._$('msg').textContent = 'Radar nicht verfügbar – Add-on „Wand-Radar“ läuft?'; });
  }
  _apply() {
    const m = this._pending;
    if (!m || this._state !== 'ruhe' || (this._meta && this._meta.version === m.version)) { this._updateStale(); return; }
    this._meta = m; this._pending = null;
    this._$('msg').textContent = '';
    const v = `?v=${m.version}`;
    this._$('still').src = `${this._cfg.base}/still.jpg${v}`;
    const vid = this._$('vid');
    vid.src = `${this._cfg.base}/radar.mp4${v}`; vid.load();
    const span = m.times.length - 1, nowF = m.now_index / span, $ = this._$;
    $('past').style.width = (nowF * 100) + '%'; $('fut').style.left = (nowF * 100) + '%'; $('now').style.left = (nowF * 100) + '%';
    const tk = $('ticks'); tk.innerHTML = '';
    m.times.forEach((t, i) => { if (t.endsWith(':00')) { const x = i / span * 100; tk.insertAdjacentHTML('beforeend', `<i style="left:${x}%"></i><span style="left:${x}%">${t}</span>`); } });
    this._drawStrip();
    this._show(this._restTime(), true);
    this._updateStale();
  }
  _updateStale() {
    const m = this._meta; if (!m) return;
    const old = (Date.now() / 1000 - m.t0_epoch) / 60 > this._cfg.stale_min;
    this._root.classList.toggle('stale', old);
  }
  _total() { const m = this._meta; return m ? (m.times.length - 1) * m.sub / m.fps : 10; }
  _restTime() { const m = this._meta; return m.now_index * m.sub / m.fps; }

  // ---- Zeitleiste ----
  _drawStrip() {
    const m = this._meta, c = this._$('strip'); if (!m || !c) return;
    const w = Math.round(this._$('track').clientWidth) || 1200, s = m.home_dbz, span = s.length - 1, thr = m.thr_dbz || 14;
    c.width = w; c.height = 4; const g = c.getContext('2d'); g.clearRect(0, 0, w, 4);
    for (let i = 0; i < span; i++) {
      const d = (s[i] + s[i + 1]) / 2, k = d >= thr && wrColor(d); if (!k) continue;
      g.fillStyle = wrRgba(k[0]); g.fillRect(Math.floor(i / span * w), 0, Math.ceil(w / span) + 1, 4);
    }
    const f = this._$('flag');
    const ab = m.regnet_jetzt ? -1 : m.times.findIndex((t, i) => i > m.now_index && s[i] >= thr && s[i - 1] < thr);
    const bis = m.regnet_jetzt && m.regen_bis ? m.times.indexOf(m.regen_bis, m.now_index) : -1;
    f.classList.remove('on', 'right');
    if (ab >= 0) { f.classList.add('on'); f.style.left = (ab / span * 100) + '%'; f.textContent = `Regen ab ${m.times[ab]}`; }
    else if (bis >= 0) { f.classList.add('on'); f.style.left = (bis / span * 100) + '%'; f.textContent = `Regen bis ${m.times[bis]}`; }
  }
  _show(tSec, rest) {
    const m = this._meta; if (!m) return;
    const span = m.times.length - 1, p = Math.max(0, Math.min(1, tSec / this._total()));
    const idx = Math.round(p * span), mins = (idx - m.now_index) * m.step_min;
    const ep = m.epochs[0] * 1000 + p * span * m.step_min * 60000, d = new Date(ep);
    this._$('tt').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    this._$('rel').textContent = rest || mins === 0 ? 'jetzt' : (mins > 0 ? `in ${mins} min` : `vor ${-mins} min`);
    this._$('fc').classList.toggle('on', !rest && mins > 0);
    this._$('head').style.left = (p * 100) + '%'; this._$('fill').style.width = (p * 100) + '%';
  }

  // ---- Routenmodus ----
  _loadRoute() {
    fetch(`${this._cfg.base}/route.json?t=${Date.now()}`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((j) => { this._route = j; this._sync(); })
      .catch(() => { /* keine Route-Datei (ältere App): Radar wie bisher */ });
  }
  _st(e) { const h = this._hass; return h && h.states[e] ? h.states[e].state : ''; }
  _sync() {
    if (!this._$) return;
    const r = this._route, st = (e) => this._st(e);
    let ok = false;
    if (this._hass && r && r.aktiv) {
      const q = st('sensor.wand_aufbruch_quelle');
      if (r.typ === 'auto' && q === 'termin') {
        ok = r.schluessel === `${st('input_text.termin_koordinaten').replace(/\s/g, '')}|${st('input_datetime.termin_start').replace(' ', 'T').slice(0, 16)}`;
      } else if (r.typ === 'bahn' && q === 'reise') {
        try { ok = JSON.parse(st('input_text.wand_reise')).ab === r.schluessel; } catch (_) { ok = false; }
      }
    }
    const t = this._training();                                      // Vorrang: Route > Training > Radar
    const sv = ok ? 'route' : t ? 'training' : '';
    const key = sv === 'training' ? `training:${t.a.source_id}` : sv;
    this._routeOn = ok; this._trainOn = !!t;
    if (key !== this._svKey) { this._svKey = key; this._rsel = 'karte'; clearTimeout(this._rauto); }      // Karte neu da: „Route“/„Training“ vorgewählt
    this._sv = sv;
    const sig = sv === 'route' ? ['r', r.t, r.schluessel, this._rsig].join('#') : sv === 'training' ? ['t', this._tsig].join('#') : '';
    if (sv && sig !== this._drawSig) { this._drawSig = sig; this._drawSv(); }
    if (!sv) this._drawSig = '';
    this._applyView();
  }
  _training() {                          // laufendes Training mit Strecke: { st, a, pts } – sonst null (Indoor: nur die Kontextkarte)
    const h = this._hass; if (!h) return null;
    const z = h.states[this._cfg.training_show], t = h.states[this._cfg.training_entity];
    if (!z || z.state !== 'on' || !t || !t.attributes || !t.attributes.summary_polyline) return null;
    let pts = [];
    try { pts = wrDecode(t.attributes.summary_polyline); } catch (_) { pts = []; }
    return pts.length >= 2 && !isNaN(new Date(t.state)) ? { st: t.state, a: t.attributes, pts } : null;
  }
  _applyView() {
    const sv = this._sv, on = !!sv, view = on && this._rsel === 'karte', s = document.documentElement.style;
    this._root.classList.toggle('hasroute', on);
    this._root.classList.toggle('rview', view);
    s.setProperty('--wand-mitte', view ? '0' : '1');                // Wetterkarte in der Mitte blendet aus, solange die Karte zu sehen ist
    const b = this._$('swRoute');
    if (this._svKey !== this._swKey) {                                 // Knopf links: „Route“ bzw. „Training“ (Symbol der Sportart)
      this._swKey = this._svKey;
      if (sv === 'route') b.innerHTML = '<ha-icon icon="mdi:map-marker-path"></ha-icon>Route';
      else if (sv === 'training') {
        const t = this._training();
        b.innerHTML = `<ha-icon icon="${(WR_SPORT[t && t.a.activity_type] || WR_SPORT.other)[2]}"></ha-icon>Training`;
      }
    }
    b.classList.toggle('on', view);
    this._$('swRadar').classList.toggle('on', on && !view);
  }
  _selectView(v) {
    if (!this._sv || v === this._rsel) return;
    if (v === 'karte') { this._toKarte(); return; }
    this._rsel = 'radar'; this._applyView(); this._touch();
  }
  _toKarte() {
    this._rsel = 'karte';
    if (this._state !== 'ruhe') this._stop();
    this._applyView();
  }
  _drawSv() { if (this._sv === 'route') this._drawRoute(); else if (this._sv === 'training') this._drawTraining(); }
  _drawRoute() {
    const r = this._route, layer = this._$('route');
    if (!r || !r.aktiv) return;
    const rc = this._root.getBoundingClientRect(), W = rc.width || 1366, H = rc.height || 1024;
    const B = { x0: W * 390 / 1366, y0: H * 280 / 1024, x1: W * 1005 / 1366, y1: H * 712 / 1024 };    // freie Fläche zwischen Spalten, Uhr und Leiste
    // Die ganze Strecke wird stufenlos in die Bühne eingepasst (kurz = weit hinein, lang = weit heraus); ringsum bleibt Platz für die Schilder
    const F = { x0: B.x0 + W * 60 / 1366, x1: B.x1 - W * 60 / 1366, y0: B.y0 + H * 36 / 1024, y1: B.y1 - H * 36 / 1024 };
    const dot = (p, c, rad, ring) => `<div class="rdot" style="left:${p[0] - rad}px;top:${p[1] - rad}px;width:${2 * rad}px;height:${2 * rad}px;background:${c};box-shadow:0 0 0 3px rgba(0,0,0,.4)${ring ? `,0 0 0 ${rad + 5}px ${c}33` : ''}"></div>`;
    const glow = (P, pts, c, l) => `<path d="${wrPath(P, pts)}" fill="none" stroke="${c}" stroke-opacity=".45" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" filter="url(#gl)"/>` +
      `<path d="${wrPath(P, pts)}" fill="none" stroke="${l}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
    const chips = [], dots = [], pins = [];
    let pts = [r.start], lines = '', sum;
    let K, P;
    if (r.typ === 'auto') {
      const main = r.routen[0], alt = r.routen[1];
      pts = pts.concat(main.pts, alt ? alt.pts : [], [r.ziel]);
      K = wrFit(pts, F); P = K.P;
      if (alt) lines += `<path d="${wrPath(P, alt.pts)}" fill="none" stroke="#8cc8ff" stroke-opacity=".38" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1 7"/>`;
      lines += glow(P, main.pts, '#8cc8ff', '#b9ddff');
      for (const s of main.stau) lines += `<path d="${wrPath(P, s.pts)}" fill="none" stroke="#ff9f43" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
      const zeit = this._st('input_datetime.termin_start').slice(11, 16), ort = this._st('input_text.termin_ort') || 'Ziel';
      const ziel = P(r.ziel);
      dots.push(dot(P(r.start), '#ffffff', 9, true), dot(ziel, '#8cc8ff', 8, true));
      pins.push(P(r.start), ziel);
      chips.push({ p: ziel, pref: 'left', html: `${wrIcon('mdi:map-marker', '#8cc8ff')}${wrEsc(ort)}${zeit ? `<span class="d">${zeit}</span>` : ''}` });
      const gross = main.stau.slice().sort((a, b) => b.min - a.min)[0];
      if (gross) chips.push({ p: wrPointAt(P, gross.pts, 0.5), pref: 'left', bg: 'rgba(58,34,10,.9)', bd: 'rgba(255,159,67,.5)', html: `${wrIcon('mdi:car-brake-alert', '#ff9f43')}+${gross.min} min` });
      chips.push({ p: wrPointAt(P, main.pts, 0.3), pref: 'left', bg: 'rgba(20,40,60,.88)', bd: 'rgba(140,200,255,.45)', html: `${wrIcon('mdi:car', '#b9ddff')}${wrEsc(main.name)} · ${main.min} min` });
      if (alt) chips.push({ p: wrPointAt(P, alt.pts, 0.5), pref: 'right', bg: 'rgba(17,19,23,.7)', bd: 'rgba(255,255,255,.08)', html: `${wrEsc(alt.name)} · ${alt.min} min` });
      const staus = main.stau.reduce((a, s) => a + s.min, 0);
      const t = (r.t || '').slice(11, 16);
      sum = [`<span class="k">${r.quelle === 'osrm' ? 'ROUTE · STRECKE OHNE VERKEHR' : `ROUTE · WAZE ${t}`}</span>`, `<span class="g">${wrEsc(main.name)} · ${main.min} min · ${main.km} km</span>`,
        staus >= 2 ? `<span class="o">+${staus} min Stau</span>` : '', alt ? `<span class="r">Alternative ${wrEsc(alt.name)} · ${alt.min} min · ${alt.km} km</span>` : ''];
    } else {
      const ab = r.abschnitte;
      let live = {}; try { live = JSON.parse(this._st('input_text.wand_reise_live') || '{}') || {}; } catch (_) { live = {}; }
      ab.forEach((a) => { pts = pts.concat(a.pts, [[a.von.lat, a.von.lon], [a.nach.lat, a.nach.lon]]); });
      K = wrFit(pts, F); P = K.P;
      const h0 = P(r.start), s0 = P([ab[0].von.lat, ab[0].von.lon]);
      lines += `<path d="M${h0[0]},${h0[1]}L${s0[0]},${s0[1]}" fill="none" stroke="#c4c7cc" stroke-width="2.5" stroke-dasharray="2 5" stroke-linecap="round"/>`;
      ab.forEach((a) => {
        lines += wrFern(a.zug) ? glow(P, a.pts, '#ffb74d', '#ffcf8a')
          : `<path d="${wrPath(P, a.pts)}" fill="none" stroke="#ffcf8a" stroke-opacity=".85" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
      });
      dots.push(dot(h0, '#ffffff', 6, false), dot(s0, '#ffcf8a', 6, false));
      pins.push(h0, s0);
      const v = parseInt(live.v, 10) || 0, gleis = live.g || ab[0].von.gleis;
      chips.push({ p: s0, pref: 'right', html: `${wrIcon('mdi:bike', '#c4c7cc')}${wrEsc(ab[0].von.name)}` +
        (live.x ? '<span class="x">fällt aus</span>' : `<span class="o">${ab[0].von.ab}${v >= 3 ? ` +${v}` : ''}${gleis ? ` · Gl. ${wrEsc(gleis)}` : ''}</span>`) });
      ab.forEach((a, i) => {
        const p = P([a.nach.lat, a.nach.lon]);
        pins.push(p);
        if (i < ab.length - 1) {
          dots.push(`<div class="rdot" style="left:${p[0] - 7}px;top:${p[1] - 7}px;width:14px;height:14px;background:#0b0d10;border:3px solid #ffcf8a"></div>`);
          chips.push({ p, pref: 'left', html: `${wrEsc(a.nach.name)}<span class="d">an ${a.nach.an} · ab ${ab[i + 1].von.ab}</span>` });
        } else {
          dots.push(dot(p, '#ffb74d', 8, true));
          chips.push({ p, pref: 'left', html: `${wrIcon('mdi:map-marker', '#ffb74d')}${wrEsc(a.nach.name)}<span class="d">an ${a.nach.an}</span>` });
        }
      });
      const dauer = (wrMin(ab[ab.length - 1].nach.an) - wrMin(ab[0].von.ab) + 1440) % 1440, um = ab.length - 1;
      const d = r.schluessel.slice(0, 10).split('-');
      sum = [`<span class="k">BAHN · ${d[2]}.${d[1]}.</span>`, `<span class="g">${ab.map((a) => `${wrEsc(a.zug)} → ${wrEsc(a.nach.name.replace(/ Hbf$/, ''))}`).join(' · ')}</span>`,
        live.x ? '<span class="o" style="color:#ff6b6b">fällt aus</span>' : v >= 3 ? `<span class="o">+${v} min</span>` : '',
        `<span class="r">${wrDauer(dauer)} · ${um ? `${um} Umstieg${um > 1 ? 'e' : ''}` : 'direkt'}</span>`];
    }
    layer.innerHTML = wrTiles(K, W, H) + `<svg width="${W}" height="${H}" style="position:absolute;left:0;top:0"><defs><filter id="gl" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5"/></filter></defs>${lines}</svg>` + dots.join('');
    this._placeChips(layer, chips, B, pins);
    this._$('rsum').innerHTML = sum.join('');
  }
  _drawTraining() {
    const t = this._training(), layer = this._$('route');
    if (!t) return;
    const a = t.a, pts = t.pts, typ = a.activity_type, [halo, linie, icon] = WR_SPORT[typ] || WR_SPORT.other;
    const rc = this._root.getBoundingClientRect(), W = rc.width || 1366, H = rc.height || 1024;
    const B = { x0: W * 390 / 1366, y0: H * 280 / 1024, x1: W * 1005 / 1366, y1: H * 712 / 1024 };    // wie bei der Route
    const F = { x0: B.x0 + W * 60 / 1366, x1: B.x1 - W * 60 / 1366, y0: B.y0 + H * 36 / 1024, y1: B.y1 - H * 36 / 1024 };
    const K = wrFit(pts, F), P = K.P;
    const dot = (p, c, rad, ring) => `<div class="rdot" style="left:${p[0] - rad}px;top:${p[1] - rad}px;width:${2 * rad}px;height:${2 * rad}px;background:${c};box-shadow:0 0 0 3px rgba(0,0,0,.4)${ring ? `,0 0 0 ${rad + 5}px ${c}33` : ''}"></div>`;
    const von = new Date(t.st), bis = new Date(von.getTime() + (a.duration_minutes || 0) * 60000);
    const s0 = P(pts[0]), e0 = P(pts[pts.length - 1]);
    const schleife = wrMeter(pts[0], pts[pts.length - 1]) < 150;        // Start und Ende dicht beieinander: ein Schild
    const km = a.distance_km || 0, pins = [s0, e0], dots = [];
    // km-Marken: ≤ 15 km jeder km, darüber alle 5 km; entlang der Pixellänge (Anteil k / Gesamt-km); zu dichte Marken entfallen
    const marken = []; const stufe = km > 15 ? 5 : 1;
    for (let k = stufe; k < km - 0.3; k += stufe) {
      const p = wrPointAt(P, pts, k / km);
      if ([...pins, ...marken.map((m) => m[1])].some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 24)) continue;
      marken.push([k, p]);
    }
    const mk = marken.map(([k, p]) => `<div class="rdot" style="left:${p[0] - 10}px;top:${p[1] - 10}px;width:20px;height:20px;background:#0b0d10;border:2px solid ${linie};font:700 10px Roboto,sans-serif;color:#fff;display:flex;align-items:center;justify-content:center">${k}</div>`).join('');
    const chips = [];
    const h = this._hass && this._hass.states['zone.home'];
    const daheim = h && h.attributes && wrMeter(pts[0], [h.attributes.latitude, h.attributes.longitude]) < 150;
    if (schleife) {
      dots.push(dot(s0, '#ffffff', 8, true));
      chips.push({ p: s0, pref: 'left', html: `${wrIcon(daheim ? 'mdi:home' : 'mdi:flag-checkered')}Start · Ziel<span class="d">${wrHM(von)} – ${wrHM(bis)}</span>` });
    } else {
      dots.push(dot(s0, '#ffffff', 8, true), dot(e0, linie, 8, true));
      chips.push({ p: s0, pref: 'left', html: `${wrIcon(daheim ? 'mdi:home' : 'mdi:flag')}Start<span class="d">${wrHM(von)}</span>` });
      chips.push({ p: e0, pref: 'left', html: `${wrIcon('mdi:flag-checkered')}Ziel<span class="d">${wrHM(bis)}</span>` });
    }
    const d = `${wrPath(P, pts)}`;
    const linien = `<path d="${d}" fill="none" stroke="${halo}" stroke-opacity=".5" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" filter="url(#gl)"/>` +
      `<path d="${d}" fill="none" stroke="${linie}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
    layer.innerHTML = wrTiles(K, W, H) + `<svg width="${W}" height="${H}" style="position:absolute;left:0;top:0"><defs><filter id="gl" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6"/></filter></defs>${linien}</svg>` + mk + dots.join('');
    this._placeChips(layer, chips, B, pins.concat(marken.map((m) => m[1])));
    const tempo = wrTempo(typ, a.distance_km, a.duration_minutes, a.pace);
    this._$('rsum').innerHTML = [`<span class="k">TRAINING · STRAVA ${wrHM(bis)}</span>`,
      `<span class="g">${wrEsc(a.name || '')}${km ? ` · ${wrZahl(km, 2)} km` : ''}${tempo ? ` · ${wrEsc(tempo)}` : ''}</span>`,
      '<span class="r">bis Tagesende</span>'].join('');
  }
  _placeChips(layer, chips, B, pins) {      // Schilder neben ihren Punkt setzen: innerhalb der Bühne, ohne einander zu überdecken
    const placed = (pins || []).map((q) => ({ x: q[0] - 10, y: q[1] - 10, w: 20, h: 20 }));       // Start-/Ziel-/Bahnhofspunkte bleiben frei
    for (const c of chips) {
      const e = document.createElement('div');
      e.className = 'rchip'; e.innerHTML = c.html;
      if (c.bg) { e.style.background = c.bg; e.style.borderColor = c.bd; }
      layer.appendChild(e);
      const w = e.offsetWidth, h = e.offsetHeight;
      const cand = (c.pref === 'right' ? ['right', 'left'] : ['left', 'right']).map((s) => (s === 'left' ? c.p[0] + 20 : c.p[0] - 20 - w));
      let x = cand.find((v) => v >= B.x0 && v + w <= B.x1);
      if (x === undefined) x = cand[0];
      x = Math.max(B.x0, Math.min(x, B.x1 - w));
      let y = Math.max(B.y0, Math.min(c.p[1] - h / 2, B.y1 - h));
      const hit = (yy) => placed.some((q) => x < q.x + q.w + 4 && x + w + 4 > q.x && yy < q.y + q.h + 4 && yy + h + 4 > q.y);
      for (const dy of [0, h + 6, -(h + 6), 2 * (h + 6), -2 * (h + 6)]) {
        const yy = Math.max(B.y0, Math.min(c.p[1] - h / 2 + dy, B.y1 - h));
        if (!hit(yy)) { y = yy; break; }
      }
      e.style.left = x + 'px'; e.style.top = y + 'px';
      placed.push({ x, y, w, h });
    }
  }

  // ---- Zustände ----
  _setState(s) {
    this._state = s;
    const R = this._root, on = s !== 'ruhe';
    R.classList.toggle('playing', on); R.classList.toggle('hold', s === 'angehalten');
    if (!on) R.classList.remove('vshow');
    this._$('ico').innerHTML = s === 'laeuft' ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>' : '<path d="M8 5.14v14l11-7-11-7z"/>';
    this._$('play').setAttribute('aria-label', s === 'laeuft' ? 'Radar anhalten' : 'Radar abspielen');
    wandSeiten(on);
    this._touch();
  }
  _touch() {                                                   // 60 s nach der letzten Berührung zurück auf „jetzt“
    clearTimeout(this._auto);
    if (this._state !== 'ruhe') this._auto = setTimeout(() => this._stop(), (this._cfg.max_seconds || 60) * 1000);
    clearTimeout(this._rauto);                                  // Radar statt Route gewählt: 60 s nach der letzten Berührung zurück auf „Route“
    if (this._sv && this._rsel === 'radar') this._rauto = setTimeout(() => this._toKarte(), (this._cfg.max_seconds || 60) * 1000);
  }
  _tick() {
    if (this._state !== 'laeuft') return;
    this._show(this._$('vid').currentTime, false);
    requestAnimationFrame(() => this._tick());
  }
  _play() {
    const vid = this._$('vid');
    if (!this._meta) return;
    if (this._state === 'ruhe' || vid.ended || vid.currentTime >= this._total() - 0.05) vid.currentTime = 0;
    clearTimeout(this._holdT); this._setState('laeuft');
    const p = vid.play(); if (p && p.catch) p.catch(() => this._hold());
    requestAnimationFrame(() => this._tick());
  }
  _hold() {
    const vid = this._$('vid');
    vid.pause(); clearTimeout(this._holdT); this._setState('angehalten'); this._show(vid.currentTime, false);
  }
  _stop() {
    clearTimeout(this._holdT); this._setState('ruhe');
    this._$('vid').pause();
    if (this._meta) this._show(this._restTime(), true);
    if (this._pending) this._apply();                           // in der Zwischenzeit eingetroffene neue Bilder
  }
}
if (!customElements.get('wand-radar')) customElements.define('wand-radar', WandRadar);

// ---------- Ansicht „Sport“ (custom:wand-sport, seit 1.8) ----------
// art: woche · letzte (Strecke + Werte der letzten Aktivität) · jahr (Jahr gegen Vorjahr bis heute) · monate (12 Monate gestapelt) ·
//      kalender (26 Wochen) · bestwerte.  entity: sensor.strava_stats (letzte: sensor.strava_latest_activity).
// Datumsrechnung nur mit Kalendertagen (UTC-Tageszähler aus „JJJJ-MM-TT“), nie über toISOString – sonst verrutscht der Tag um die Zeitzone.
const WS_NAMEN = { running: 'Laufen', walking: 'Spazieren', cycling: 'Rad', hiking: 'Wandern', swimming: 'Schwimmen', strength_training: 'Kraft', yoga: 'Yoga', other: 'Sonstiges' };
const WS_ORDNUNG = Object.keys(WS_NAMEN);
const WS_WTAG = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WS_MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const wsTag = (s) => { const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };      // 'JJJJ-MM-TT' -> Tageszähler
const wsTeile = (n) => { const d = new Date(n * 86400000); return { j: d.getUTCFullYear(), m: d.getUTCMonth() + 1, t: d.getUTCDate(), w: d.getUTCDay() }; };
const wsHeute = () => { const n = new Date(); return Math.round(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / 86400000); };      // lokales Datum
const wsKurz = (n) => { const q = wsTeile(n); return `${q.t}.${q.m}.`; };
const wsDatum = (s) => { const [y, m, d] = s.split('-').map(Number); return `${d}.${m}.${String(y).slice(2)}`; };
const wsDauer = (min) => (min >= 60 ? `${Math.floor(min / 60)}:${pad(Math.round(min % 60))} h` : `${Math.round(min)} min`);
const wsKm = (km) => wrZahl(km, km > 0 && km < 10 ? 1 : 0);
const wsFarbe = (typ) => (WR_SPORT[typ] || WR_SPORT.other)[0];
const wsSymbol = (typ, c) => `<ha-icon icon="${(WR_SPORT[typ] || WR_SPORT.other)[2]}" style="color:${c || wsFarbe(typ)}"></ha-icon>`;
const wsPace = (v) => { const s = Math.round(v * 60); return `${Math.floor(s / 60)}:${pad(s % 60)} /km`; };
const WS_CSS = `
:host { display: block; }
.kopf { display: flex; align-items: center; gap: 8px; padding: 2px 8px 10px; color: var(--primary-text-color); }
.kopf ha-icon { --mdc-icon-size: 20px; color: var(--secondary-text-color); flex: none; }
.kopf .t { font-size: 16px; font-weight: 500; }
.kopf .r { margin-left: auto; font-size: 13px; color: var(--secondary-text-color); white-space: nowrap; }
ha-card { padding: 16px; color: var(--primary-text-color); box-sizing: border-box; }
.sek { color: var(--secondary-text-color); }
.leer { color: var(--secondary-text-color); font-size: 14px; padding: 4px 0; }
.gross { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
.gross b { font-size: 38px; line-height: 1.1; font-weight: 700; letter-spacing: -0.02em; }
.gross small { font-size: 16px; font-weight: 400; color: var(--secondary-text-color); margin-left: 3px; letter-spacing: 0; }
.gross .sek { font-size: 14px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px 6px 9px; border-radius: 12px; font-size: 14px; font-weight: 500; }
.chip ha-icon { --mdc-icon-size: 18px; }
.zeile { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 14px; color: var(--secondary-text-color); }
.zeile ha-icon { --mdc-icon-size: 16px; color: #ffa726; flex: none; }
.karte { position: relative; overflow: hidden; border-radius: 12px; background: #1b1d20; margin-bottom: 14px; }
.name { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 700; }
.name ha-icon { --mdc-icon-size: 24px; flex: none; }
.name span { min-width: 0; overflow-wrap: anywhere; }
.werte { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
.werte b { display: block; font-size: 20px; font-weight: 700; line-height: 1.2; }
.werte span { font-size: 12px; color: var(--secondary-text-color); }
.jz { display: grid; grid-template-columns: 24px 92px minmax(0, 1fr) auto; align-items: center; gap: 4px 10px; }
.jz .nm { font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.jz + .jz { margin-top: 12px; }
.jz ha-icon { --mdc-icon-size: 22px; }
.jz .bal { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.jz .bal i { display: block; height: 7px; border-radius: 4px; min-width: 3px; }
.jz .bal i.alt { height: 4px; opacity: .35; }
.jz .zahl { font-size: 14px; font-weight: 700; text-align: right; white-space: nowrap; }
.jz .zahl span { font-weight: 400; color: var(--secondary-text-color); }
.mon { display: flex; align-items: flex-end; gap: 6px; height: 130px; }
.mon .sp { flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; min-width: 0; }
.mon .sp div { border-radius: 0; }
.mon .sp div:first-child { border-radius: 3px 3px 0 0; }
.monl { display: flex; gap: 6px; margin-top: 8px; }
.monl span { flex: 1; text-align: center; font-size: 12px; color: var(--secondary-text-color); }
.monl span.jetzt { color: var(--primary-text-color); font-weight: 700; }
.kml { position: relative; height: 14px; display: grid; grid-template-columns: repeat(26, minmax(0, 1fr)); gap: 3px; margin-bottom: 4px; font-size: 11px; color: var(--secondary-text-color); }
.kml span { white-space: nowrap; overflow: visible; }
.kal { display: grid; grid-template-columns: repeat(26, minmax(0, 1fr)); grid-template-rows: repeat(7, auto); grid-auto-flow: column; gap: 3px; }
.kal i { display: block; aspect-ratio: 1; border-radius: 2px; background: rgba(127, 127, 127, .2); }
.kal i.fz { background: none; border: 1px dashed rgba(127, 127, 127, .45); box-sizing: border-box; }
.leg { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 12px; font-size: 12px; color: var(--secondary-text-color); }
.leg span { display: inline-flex; align-items: center; gap: 5px; }
.leg i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.bw { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.bw + .bw { margin-top: 14px; }
.bw ha-icon { --mdc-icon-size: 24px; }
.bw .a { font-size: 15px; font-weight: 600; }
.bw .b { font-size: 12px; color: var(--secondary-text-color); margin-top: 1px; }
.bw .v { font-size: 16px; font-weight: 700; white-space: nowrap; }
`;
class WandSport extends HTMLElement {
  setConfig(c) {
    if (!c || !c.art) throw new Error('art fehlt (woche, letzte, jahr, monate, kalender, bestwerte)');
    this._cfg = Object.assign({}, c);
    if (!this._cfg.entity) this._cfg.entity = c.art === 'letzte' ? 'sensor.strava_latest_activity' : 'sensor.strava_stats';
    this._sig = null;
  }
  getCardSize() { return 3; }
  getGridOptions() { return { columns: 12, min_columns: 6 }; }
  set hass(h) {
    this._hass = h;
    const e = h && h.states[this._cfg.entity];
    const sig = [e ? e.state : '', e ? e.last_updated : '', wsHeute()].join('|');
    if (sig === this._sig) return;
    this._sig = sig;
    this._render();
  }
  connectedCallback() {
    if (this._ro || typeof ResizeObserver === 'undefined') return;
    this._ro = new ResizeObserver(() => { const k = this.shadowRoot && this.shadowRoot.getElementById('karte'); if (k && k.clientWidth !== this._kw) this._zeichneKarte(); });
    this._ro.observe(this);
  }
  disconnectedCallback() { if (this._ro) { this._ro.disconnect(); this._ro = null; } }
  _render() {
    if (!this._cfg || !this._hass) return;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const e = this._hass.states[this._cfg.entity], a = e ? e.attributes || {} : {};
    let kopf = ['mdi:run', 'Sport', ''], inhalt = '';
    const art = this._cfg.art, ok = ['woche', 'letzte', 'jahr', 'monate', 'kalender', 'bestwerte'].includes(art);
    const b = ok ? this['_' + art](e, a) : this._ohne(kopf, `Unbekannte Art „${wrEsc(art)}“`);
    kopf = b.kopf; inhalt = b.inhalt;
    this.shadowRoot.innerHTML = `<style>${WS_CSS}</style><div class="kopf"><ha-icon icon="${kopf[0]}"></ha-icon><span class="t">${wrEsc(kopf[1])}</span><span class="r">${wrEsc(kopf[2])}</span></div><ha-card>${inhalt}</ha-card>`;
    this._kw = 0;
    if (this._cfg.art === 'letzte') requestAnimationFrame(() => this._zeichneKarte());
  }
  _ohne(kopf, text) { return { kopf, inhalt: `<div class="leer">${text}</div>` }; }
  _stats(e, a, kopf) { return e && e.state !== 'unavailable' && e.state !== 'unknown' && a.woche ? null : this._ohne(kopf, 'Noch keine Strava-Daten'); }

  _woche(e, a) {
    const k = ['mdi:calendar-week', 'Diese Woche', ''];
    const x = this._stats(e, a, k); if (x) return x;
    const w0 = wsTag(a.woche_start); k[2] = `Mo ${wsKurz(w0)} – heute`;
    const w = a.woche || {}, g = w.gesamt || { n: 0, km: 0, min: 0 }, v = (a.vorwoche || {}).gesamt;
    const typen = WS_ORDNUNG.filter((t) => w[t] && w[t].n > 0);
    const vor = v && v.n ? `Vorwoche ${wrZahl(v.km, 1)} km · ${v.n} ${v.n === 1 ? 'Training' : 'Trainings'}` : '';
    let h;
    if (!g.n) h = `<div class="leer" style="font-size:16px;padding-top:0">Noch kein Training diese Woche</div>` + (vor ? `<div class="zeile">${vor}</div>` : '');
    else {
      h = `<div class="gross"><span><b>${wrZahl(g.km, 1)}</b><small>km</small></span><span class="sek">${wsDauer(g.min)} · ${g.n} ${g.n === 1 ? 'Training' : 'Trainings'}</span></div>`;
      h += `<div class="chips">${typen.map((t) => {
        const q = w[t], c = wsFarbe(t);
        return `<span class="chip" style="background:${wrRgba(wrHex(c), 0.18)}">${wsSymbol(t)}${q.n}× · ${q.km > 0 ? `${wrZahl(q.km, 1)} km` : wsDauer(q.min)}</span>`;
      }).join('')}</div>`;
      if (vor) h += `<div class="zeile" style="margin-top:12px">${vor}</div>`;
    }
    const sw = a.serie_wochen || 0, sl = a.serie_laufwochen || 0, teile = [];
    if (sw >= 2) teile.push(`${sw} Wochen in Folge aktiv`);
    if (sl >= 2) teile.push(`Laufen ${sl} Wochen`);
    if (teile.length) h += `<div class="zeile"><ha-icon icon="mdi:fire"></ha-icon>${teile.join(' · ')}</div>`;
    return { kopf: k, inhalt: h };
  }

  _letzte(e, a) {
    const k = ['mdi:map-marker-path', 'Letzte Aktivität', ''];
    if (!e || e.state === 'unavailable' || e.state === 'unknown' || !a.activity_type) return this._ohne(k, 'Noch keine Aktivität');
    const d = new Date(e.state), typ = a.activity_type, c = wsFarbe(typ);
    if (!isNaN(d)) k[2] = `${WS_WTAG[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}. · ${wrHM(d)}`;
    this._a = a;
    const km = a.distance_km || 0, min = a.duration_minutes || 0, w = [];
    if (km > 0) w.push([wrZahl(km, 2), 'km']);
    if (min > 0) w.push(min >= 120 ? [`${Math.floor(min / 60)}:${pad(Math.round(min % 60))}`, 'h'] : [String(Math.round(min)), 'min']);
    const t = wrTempo(typ, km, min, a.pace);
    if (t) { const i = t.indexOf(' '); w.push([t.slice(0, i), t.slice(i + 1)]); }
    if (a.avg_heart_rate) w.push([String(Math.round(a.avg_heart_rate)), 'Puls Ø']);
    else if (a.elevation_gain_m >= 20 && w.length < 4) w.push([String(Math.round(a.elevation_gain_m)), 'Höhenmeter']);
    const karte = (a.summary_polyline || '').length > 4 ? '<div class="karte" id="karte" style="height:210px"></div>' : '';
    return { kopf: k, inhalt: karte +
      `<div class="name">${wsSymbol(typ, c)}<span>${wrEsc(a.name || WS_NAMEN[typ] || 'Aktivität')}</span></div>` +
      `<div class="werte">${w.map(([z, l]) => `<div><b>${z}</b><span>${l}</span></div>`).join('')}</div>` };
  }
  _zeichneKarte() {                                    // Strecke im selben Stil wie die Wand (Esri-Kacheln + Leuchtlinie), passt sich der Breite an
    const box = this.shadowRoot && this.shadowRoot.getElementById('karte'), a = this._a;
    if (!box || !a) return;
    const W = box.clientWidth, H = box.clientHeight;
    if (!W || !H) return;
    this._kw = W;
    const pts = wrDecode(a.summary_polyline);
    if (pts.length < 2) { box.style.display = 'none'; return; }
    const [halo, linie] = WR_SPORT[a.activity_type] || WR_SPORT.other, r = 26;
    const K = wrFit(pts, { x0: r, y0: r, x1: W - r, y1: H - r }), P = K.P;
    const dot = (p, c, rad) => `<div style="position:absolute;border-radius:50%;left:${p[0] - rad}px;top:${p[1] - rad}px;width:${2 * rad}px;height:${2 * rad}px;background:${c};box-shadow:0 0 0 3px rgba(0,0,0,.45)"></div>`;
    const s0 = P(pts[0]), e0 = P(pts[pts.length - 1]), schleife = wrMeter(pts[0], pts[pts.length - 1]) < 150;
    const d = wrPath(P, pts);
    box.innerHTML = wrTiles(K, W, H) + `<svg width="${W}" height="${H}" style="position:absolute;left:0;top:0"><defs><filter id="gl" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5"/></filter></defs>` +
      `<path d="${d}" fill="none" stroke="${halo}" stroke-opacity=".5" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" filter="url(#gl)"/>` +
      `<path d="${d}" fill="none" stroke="${linie}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
      (schleife ? '' : dot(e0, linie, 6)) + dot(s0, '#ffffff', 7);
  }

  _jahr(e, a) {
    const heute = wsTeile(wsHeute()), k = ['mdi:chart-bar', `${heute.j} bis heute`, `km · Vorjahr bis ${heute.t}.${heute.m}.`];
    const x = this._stats(e, a, k); if (x) return x;
    const j = a.jahr || {}, v = a.vorjahr_bis_heute || {};
    const typen = WS_ORDNUNG.filter((t) => ((j[t] && j[t].km) || 0) > 0 || ((v[t] && v[t].km) || 0) > 0);
    if (!typen.length) return this._ohne(k, 'Noch keine Strecken');
    const h = typen.map((t) => {
      const kj = (j[t] && j[t].km) || 0, kv = (v[t] && v[t].km) || 0, m = Math.max(kj, kv), c = wsFarbe(t);
      const br = (z, cls) => `<i${cls ? ` class="${cls}"` : ''} style="width:${z > 0 ? Math.max(1, z / m * 100) : 0}%;background:${c}"></i>`;
      return `<div class="jz">${wsSymbol(t)}<span class="nm">${WS_NAMEN[t]}</span><div class="bal">${br(kj)}${br(kv, 'alt')}</div><div class="zahl">${wsKm(kj)} <span>/ ${wsKm(kv)}</span></div></div>`;
    }).join('');
    return { kopf: k, inhalt: h };
  }

  _monate(e, a) {
    const k = ['mdi:chart-line', '12 Monate', ''];
    const x = this._stats(e, a, k); if (x) return x;
    const mo = a.monate || [];
    const sum = (m) => Object.values(m.km || {}).reduce((s, v) => s + v, 0);
    const max = Math.max(1, ...mo.map(sum));
    k[2] = `max. ${Math.round(Math.max(...mo.map(sum), 0))} km`;
    const jetzt = mo.length - 1;
    const spalten = mo.map((m) => {
      const segs = WS_ORDNUNG.filter((t) => (m.km || {})[t] > 0).map((t) => `<div style="height:${m.km[t] / max * 100}%;background:${wsFarbe(t)}"></div>`).reverse();
      return `<div class="sp" title="${WS_MON[parseInt(m.monat.slice(5), 10) - 1]} ${m.monat.slice(0, 4)}: ${wrZahl(sum(m), 1)} km">${segs.join('')}</div>`;
    }).join('');
    const lab = mo.map((m, i) => `<span${i === jetzt ? ' class="jetzt"' : ''}>${WS_MON[parseInt(m.monat.slice(5), 10) - 1][0]}</span>`).join('');
    return { kopf: k, inhalt: `<div class="mon">${spalten}</div><div class="monl">${lab}</div>` };
  }

  _kalender(e, a) {
    const k = ['mdi:calendar-month', 'Aktivitätskalender', '26 Wochen'];
    const x = this._stats(e, a, k); if (x) return x;
    const start = wsTag(a.woche_start) - 25 * 7, heute = wsHeute(), akt = {}, typen = new Set();
    for (const [dt, typ] of a.tage || []) { akt[wsTag(dt)] = typ; typen.add(typ); }
    let zellen = '';
    for (let c = 0; c < 26; c++) for (let r = 0; r < 7; r++) {
      const n = start + c * 7 + r, typ = akt[n];
      zellen += n > heute ? '<i class="fz"></i>' : typ ? `<i style="background:${wsFarbe(typ)}" title="${wsKurz(n)} ${WS_NAMEN[typ] || ''}"></i>` : '<i></i>';
    }
    // Monatsbeschriftung: erste Spalte = Monat ihres Montags, danach die Spalte, in der ein Monat beginnt (der 1.); der letzte Monat
    // steht rechtsbündig, wenn die Spalte zu nah am Rand liegt. Zu enge Folgen (< 3 Spalten) fallen weg.
    const mm = [[0, wsTeile(start).m]];
    for (let c = 1; c < 26; c++) for (let r = 0; r < 7; r++) { const q = wsTeile(start + c * 7 + r); if (q.t === 1) mm.push([c, q.m]); }
    if (mm.length > 1 && mm[1][0] < 3) mm.shift();
    const lab = mm.map(([c, m]) => (c > 22 ? `<span style="grid-row:1;grid-column:${c - 1} / 27;text-align:right">${WS_MON[m - 1]}</span>` : `<span style="grid-row:1;grid-column:${c + 1} / span 3">${WS_MON[m - 1]}</span>`)).join('');
    const leg = WS_ORDNUNG.filter((t) => typen.has(t)).map((t) => `<span><i style="background:${wsFarbe(t)}"></i>${WS_NAMEN[t]}</span>`).join('');
    return { kopf: k, inhalt: `<div class="kml">${lab}</div><div class="kal">${zellen}</div><div class="leg">${leg}</div>` };
  }

  _bestwerte(e, a) {
    const k = ['mdi:trophy-outline', 'Bestwerte', ''];
    const x = this._stats(e, a, k); if (x) return x;
    const b = a.bestwerte || {}, z = [];
    const run = wsFarbe('running'), rad = wsFarbe('cycling');
    if (b.schnellster_lauf_5km) z.push(['mdi:run-fast', run, 'Schnellster Lauf ab 5 km', `${wrZahl(b.schnellster_lauf_5km.km, 2)} km · ${wsDatum(b.schnellster_lauf_5km.datum)}`, wsPace(b.schnellster_lauf_5km.pace)]);
    if (b.laengster_lauf) z.push(['mdi:map-marker-distance', run, 'Längster Lauf', wsDatum(b.laengster_lauf.datum), `${wrZahl(b.laengster_lauf.km, 1)} km`]);
    if (b.meiste_hoehenmeter) { const q = b.meiste_hoehenmeter; z.push(['mdi:image-filter-hdr', wsFarbe(q.typ), `Meiste Höhenmeter (${WS_NAMEN[q.typ] || 'Sonstiges'})`, `${wrZahl(q.km, 1)} km · ${wsDatum(q.datum)}`, `${Math.round(q.hm).toLocaleString('de-DE')} m`]); }
    if (b.weiteste_radtour) z.push(['mdi:bike', rad, 'Weiteste Radtour', wsDatum(b.weiteste_radtour.datum), `${wrZahl(b.weiteste_radtour.km, 1)} km`]);
    if (!z.length) return this._ohne(k, 'Noch keine Bestwerte');
    return { kopf: k, inhalt: z.map(([i, c, t, s, v]) => `<div class="bw"><ha-icon icon="${i}" style="color:${c}"></ha-icon><div><div class="a">${wrEsc(t)}</div><div class="b">${s}</div></div><div class="v">${v}</div></div>`).join('') };
  }
}
if (!customElements.get('wand-sport')) customElements.define('wand-sport', WandSport);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === 'wand-sport')) window.customCards.push({ type: 'wand-sport', name: 'Wand-Sport (Strava-Statistik)', description: 'Karten der Ansicht Sport' });

// ---------- Training (custom:wand-training, seit 1.10) ----------
// art: heute (Wand, linker Stapel: „Heute dran: A · Beine“ mit Mini-Figur bzw. Lauf-Aussehen „Laufwetter heute“ mit Stundenleiste) ·
// naechste (Unteransicht „Training“: Winter|Sommer, Kacheln A/B/C, Wochen-Soll, Start/Erledigt/Woche aussetzen) · einheit (Aufwärmen mit Timer,
// Übungskarten mit Figur, Pausenleiste) · saison (Soll/Ist je ISO-Woche). Daten: sensor.training_heute (Vorschlag-Motor in HA),
// sensor.training_stand (Einträge, Wochen), sensor.strava_stats.liste (Läufe). Die Übungen stehen nur an EINER Stelle: in der Kartenkonfiguration
// (`einheiten`) der Karte art: einheit in der Ansicht „training“; Wand-Karte und art: naechste lesen sie per Websocket (lovelace/config) von dort.
// Strichfiguren: Seitenansicht, Blick nach rechts, Boden y = 100; je Übung zwei oder mehr Posen (a = Start, b = Umkehrpunkt, optional `folge` für
// mehr Stationen), Animation per SVG-SMIL. Posen über Gelenkpunkte (Hüfte, Rumpfrichtung, Fuß, Hand), Knie/Ellbogen rechnet wtIk()
// (aus plaene/training/figuren.mjs übernommen). Zusätze: front (Vorderansicht, beide Seiten gleich hell), spiegel, bogen (Rücken rund/hohl),
// kw (Kopfneigung), band ('haende' | 'fuesse' | [x, y] Anker → Hand).
const WT_KRAFT = '#ce93d8', WT_LAUF = '#fc5200', WT_BAND = '#81c995';
const WT_L = { ober: 23, unter: 23, rumpf: 30, kopf: 39, oa: 14, ua: 13, fuss: 7 };
const wtAdd = (p, v, f = 1) => [p[0] + v[0] * f, p[1] + v[1] * f];
const wtUnit = (v) => { const d = Math.hypot(v[0], v[1]) || 1; return [v[0] / d, v[1] / d]; };
const wtGrad = (w) => (w * Math.PI) / 180;
const wtDreh = (v, w) => { const c = Math.cos(wtGrad(w)), s = Math.sin(wtGrad(w)); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c]; };
function wtIk(A, C, l1, l2, knick) {          // Zwei-Gelenk-Kette A → C; knick -1 = Knie nach vorn, +1 = Ellbogen nach hinten
  const dx = C[0] - A[0], dy = C[1] - A[1];
  const d = Math.min(Math.hypot(dx, dy), l1 + l2 - 0.01);
  const a = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
  const b = Math.atan2(dy, dx) + knick * a;
  return [A[0] + l1 * Math.cos(b), A[1] + l1 * Math.sin(b)];
}
function wtGelenke(p) {
  const hip = p.hip;
  const dir = p.sh ? wtUnit([p.sh[0] - hip[0], p.sh[1] - hip[1]]) : [Math.sin(wtGrad(p.t || 0)), -Math.cos(wtGrad(p.t || 0))];
  const sh = wtAdd(hip, dir, WT_L.rumpf);
  const mitte = wtAdd(wtAdd(hip, dir, WT_L.rumpf / 2), [dir[1], -dir[0]], p.bogen || 0);      // bogen > 0: Rücken nach oben/hinten gewölbt
  const kopf = wtAdd(sh, p.kw ? wtDreh(dir, p.kw) : dir, WT_L.kopf - WT_L.rumpf);
  const beine = p.beine.map((b) => {
    const knie = wtIk(hip, b.fuss, WT_L.ober, WT_L.unter, b.knick ?? -1);
    const zeh = b.zeh || wtAdd(b.fuss, [Math.cos(wtGrad(b.zw || 0)), Math.sin(wtGrad(b.zw || 0))], WT_L.fuss);
    return [hip, knie, b.fuss, zeh];
  });
  const arme = p.arme.map((a) => [sh, wtIk(sh, a.hand, WT_L.oa, WT_L.ua, a.knick ?? 1), a.hand]);
  return { kopf, beine, arme, rumpf: [hip, mitte, sh], hanteln: p.arme.filter((a) => a.hantel).map((a) => a.hand), hantelHuefte: p.hantelHuefte ? hip : null };
}
const wtD = (pts) => pts.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join(' ');
// Werte einer Folge von Posen (zurück zur ersten); jede Strecke dauert dur/2 Sekunden
const wtAnim = (attr, werte, dur) => {
  if (werte.every((w) => w === werte[0])) return '';
  const v = [...werte, werte[0]], n = v.length - 1;
  return `<animate attributeName="${attr}" values="${v.join(';')}" dur="${(dur * n) / 2}s" repeatCount="indefinite" calcMode="spline" ` +
    `keyTimes="${v.map((_, i) => +(i / n).toFixed(4)).join(';')}" keySplines="${Array(n).fill('0.45 0 0.55 1').join(';')}"/>`;
};
const WT_STUFE_FARBE = 'fill="#2a2d33" stroke="#5f6368" stroke-width="1.2"';
const WT_COUCH = (x0, x1, y) => `<rect x="${x0}" y="${y - 20}" width="8" height="${120 - y}" rx="3" ${WT_STUFE_FARBE}/><rect x="${x0}" y="${y}" width="${x1 - x0}" height="${100 - y - 4}" rx="3" fill="#30333a" stroke="#5f6368" stroke-width="1.2"/><line x1="${x0 + 3}" y1="96" x2="${x0 + 3}" y2="100" stroke="#5f6368" stroke-width="2"/><line x1="${x1 - 3}" y1="96" x2="${x1 - 3}" y2="100" stroke="#5f6368" stroke-width="2"/>`;
const WT_COUCH_R = (x0, x1, y) => `<rect x="${x1 - 8}" y="${y - 20}" width="8" height="${120 - y}" rx="3" ${WT_STUFE_FARBE}/><rect x="${x0}" y="${y}" width="${x1 - x0}" height="${100 - y - 4}" rx="3" fill="#30333a" stroke="#5f6368" stroke-width="1.2"/><line x1="${x0 + 3}" y1="96" x2="${x0 + 3}" y2="100" stroke="#5f6368" stroke-width="2"/><line x1="${x1 - 3}" y1="96" x2="${x1 - 3}" y2="100" stroke="#5f6368" stroke-width="2"/>`;
const WT_TREPPE = (stufen, richtung = 'links') => `<path d="${richtung === 'links'
  ? `M${stufen[0][1]} 100 ` + stufen.map(([y, , x0]) => `V${y} H${x0}`).join(' ') + ' V100 Z'
  : `M${stufen[0][1]} 100 ` + stufen.map(([y, , x1]) => `V${y} H${x1}`).join(' ') + ' V100 Z'}" ${WT_STUFE_FARBE} stroke-linejoin="round"/>`;
const WT_GELAENDER = (x0, y0, x1, y1) => `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="#9aa0a6" stroke-width="2.2" stroke-linecap="round"/>`;
const WT_WAND = (x) => `<rect x="${x - 6}" y="-12" width="6" height="112.5" fill="#24272c"/><line x1="${x}" y1="-12" x2="${x}" y2="100.5" stroke="#5f6368" stroke-width="1.5"/>`;
const WT_PFOSTEN = (x, y) => `<line x1="${x}" y1="4" x2="${x}" y2="100" stroke="#5f6368" stroke-width="3" stroke-linecap="round"/><circle cx="${x}" cy="${y}" r="2.4" fill="#9aa0a6"/>`;
// Gemeinsame Posen
const WT_STEHEN = { hip: [50, 51], t: 0, beine: [{ fuss: [52, 96.5] }, { fuss: [48, 96.5] }] };
const wtVier = (o = {}) => Object.assign({ hip: [42, 73], sh: [72, 73], beine: [{ fuss: [19, 96.5], zw: 180 }, { fuss: [17, 96.5], zw: 180 }], arme: [{ hand: [73, 99] }, { hand: [71, 99] }] }, o);   // Vierfüßlerstand
const wtSeit = (o = {}) => Object.assign({ hip: [45, 89.5], sh: [75, 84.5], beine: [{ fuss: [1, 96], zw: -75 }, { fuss: [-1, 98], zw: -75 }], arme: [{ hand: [74, 58] }, { hand: [88, 98.5] }] }, o);   // Seitstütz
// Posen je Übungs-ID (A, B, C und Aufwärmen; Figurenblatt: werkzeuge/training/figurenblatt.mjs im HA-Repo)
const WT_POSEN = {
  // ----- A · Beine -----
  bss: {
    props: WT_COUCH(-6, 28, 76),
    a: { hip: [52, 56], t: 8, beine: [{ fuss: [62, 96.5] }, { fuss: [24, 72.5], zw: 172 }], arme: [{ hand: [57, 52], hantel: 1 }, { hand: [55, 52], hantel: 1 }] },
    b: { hip: [45, 72], t: 14, beine: [{ fuss: [62, 96.5] }, { fuss: [24, 72.5], zw: 172 }], arme: [{ hand: [53, 69], hantel: 1 }, { hand: [51, 69], hantel: 1 }] },
  },
  rdl: {
    dur: 3.4,
    a: { hip: [49, 55], t: 0, beine: [{ fuss: [50, 96.5] }, { fuss: [44, 93], zw: 10 }], arme: [{ hand: [52, 52], hantel: 1 }, { hand: [50, 52], hantel: 1 }] },
    b: { hip: [44, 58], t: 80, beine: [{ fuss: [50, 96.5] }, { fuss: [2, 66], zw: 95 }], arme: [{ hand: [74, 78], hantel: 1 }, { hand: [72, 78], hantel: 1 }] },
  },
  peterson: {
    props: WT_TREPPE([[84, 62, 22], [68, 22, -6]]),
    a: { hip: [47, 38], t: 3, beine: [{ fuss: [48, 81] }, { fuss: [66, 78], zw: -10 }], arme: [{ hand: [74, 14] }, { hand: [72, 14] }] },
    b: { hip: [52, 54], t: 12, beine: [{ fuss: [48, 81] }, { fuss: [76, 96], zw: -35 }], arme: [{ hand: [80, 30] }, { hand: [78, 30] }] },
  },
  bruecke: {
    a: { hip: [52, 79], sh: [24, 92], beine: [{ fuss: [74, 96.5], zw: 0 }, { fuss: [91, 58], zw: -60, knick: -1 }], arme: [{ hand: [46, 98], knick: -1 }, { hand: [44, 98], knick: -1 }], hantelHuefte: 0 },
    b: { hip: [48, 92], sh: [18, 93], beine: [{ fuss: [74, 96.5], zw: 0 }, { fuss: [88, 74], zw: -45, knick: -1 }], arme: [{ hand: [42, 98], knick: -1 }, { hand: [40, 98], knick: -1 }], hantelHuefte: 0 },
  },
  waden: {
    dur: 2.6,
    props: WT_TREPPE([[86, 55, 76], [72, 76, 106]], 'rechts') + WT_GELAENDER(64, 38, 106, 16),
    a: { hip: [52, 43], t: 0, beine: [{ fuss: [51, 88.5], zeh: [58, 86] }, { fuss: [38, 68], knick: -1 }], arme: [{ hand: [84, 27] }, { hand: [55, 69], hantel: 1 }] },
    b: { hip: [53, 33], t: 0, beine: [{ fuss: [53, 78], zeh: [58, 86] }, { fuss: [39, 58], knick: -1 }], arme: [{ hand: [84, 27] }, { hand: [56, 59], hantel: 1 }] },
  },
  // ----- Aufwärmen -----
  hampelmann: {
    dur: 1.4, front: 1,
    a: { hip: [50, 51], t: 0, beine: [{ fuss: [55, 96.5], zw: 15 }, { fuss: [45, 96.5], zw: 165, knick: 1 }], arme: [{ hand: [55, 47.5], knick: -1 }, { hand: [45, 47.5] }] },
    b: { hip: [50, 53], t: 0, beine: [{ fuss: [64, 96.5], zw: 15 }, { fuss: [36, 96.5], zw: 165, knick: 1 }], arme: [{ hand: [63, 0] }, { hand: [37, 0], knick: -1 }] },
  },
  beinschwingen: {
    dur: 1.8,
    props: WT_GELAENDER(58, 41, 106, 17),
    a: { hip: [44, 51], t: -4, beine: [{ fuss: [78, 76], zw: -50 }, { fuss: [44, 96.5] }], arme: [{ hand: [64, 38] }, { hand: [42, 47] }] },
    b: { hip: [44, 51], t: 6, beine: [{ fuss: [14, 84], zw: 110 }, { fuss: [44, 96.5] }], arme: [{ hand: [64, 38] }, { hand: [44, 47] }] },
  },
  beinschwingen_seitlich: {
    dur: 1.8, front: 1,
    props: WT_WAND(14),
    a: { hip: [42, 51], t: 0, beine: [{ fuss: [68, 82], zw: 30 }, { fuss: [38, 96.5], zw: 165, knick: 1 }], arme: [{ hand: [50, 46], knick: -1 }, { hand: [17, 28], knick: -1 }] },
    b: { hip: [42, 51], t: 0, beine: [{ fuss: [28, 90], zw: 170, knick: 1 }, { fuss: [38, 96.5], zw: 165, knick: 1 }], arme: [{ hand: [50, 46], knick: -1 }, { hand: [17, 28], knick: -1 }] },
  },
  kniebeuge: {
    dur: 2.6,
    a: { hip: [48, 51], t: 0, beine: [{ fuss: [52, 96.5] }, { fuss: [49, 96.5] }], arme: [{ hand: [51, 47] }, { hand: [49, 47] }] },
    b: { hip: [34, 74], t: 32, beine: [{ fuss: [52, 96.5] }, { fuss: [49, 96.5] }], arme: [{ hand: [76, 47] }, { hand: [74, 47] }] },
  },
  ausfallschritt_drehung: {
    dur: 3,
    a: { hip: [46, 51], t: 0, beine: [{ fuss: [50, 96.5] }, { fuss: [46, 96.5] }], arme: [{ hand: [58, 36] }, { hand: [56, 36] }] },
    b: { hip: [42, 72], t: 4, beine: [{ fuss: [60, 96.5] }, { fuss: [20, 94], zw: 45 }], arme: [{ hand: [66, 44] }, { hand: [22, 46], knick: -1 }] },
  },
  armkreisen: {
    dur: 1.4, folge: ['a', 'm', 'b', 'n'],
    a: { ...WT_STEHEN, arme: [{ hand: [52, -5] }, { hand: [50, -5] }] },
    m: { ...WT_STEHEN, arme: [{ hand: [76, 22] }, { hand: [74, 22] }] },
    b: { ...WT_STEHEN, arme: [{ hand: [52, 47] }, { hand: [50, 47] }] },
    n: { ...WT_STEHEN, arme: [{ hand: [24, 20], knick: -1 }, { hand: [26, 20], knick: -1 }] },
  },
  dislocates: {
    dur: 2.4, folge: ['a', 'm', 'b', 'm'],
    a: { ...WT_STEHEN, arme: [{ hand: [76, 26], knick: -1 }, { hand: [74, 26], knick: -1 }] },
    m: { ...WT_STEHEN, arme: [{ hand: [53, -5] }, { hand: [51, -5] }] },
    b: { ...WT_STEHEN, arme: [{ hand: [26, 30], knick: -1 }, { hand: [28, 30], knick: -1 }] },
  },
  katze_kuh: {
    dur: 3.6,
    a: wtVier({ hip: [42, 72], sh: [72, 74], bogen: 7, kw: 50 }),
    b: wtVier({ hip: [42, 74], sh: [72, 72], bogen: -6, kw: -30 }),
  },
  liegestuetz_couch: {
    dur: 2.4,
    props: WT_COUCH_R(56, 104, 78),
    a: { hip: [44.2, 67.4], sh: [68, 51.5], beine: [{ fuss: [6, 93], zeh: [12, 99] }, { fuss: [4, 93], zeh: [10, 99] }], arme: [{ hand: [70, 78] }, { hand: [68, 78] }] },
    b: { hip: [48, 74.2], sh: [75.4, 62], beine: [{ fuss: [6, 93], zeh: [12, 99] }, { fuss: [4, 93], zeh: [10, 99] }], arme: [{ hand: [70, 78] }, { hand: [68, 78] }] },
  },
  // ----- B · Oberkörper + Rumpf -----
  liegestuetz: {
    dur: 2.4,
    a: { hip: [48, 80.6], sh: [76, 72], beine: [{ fuss: [4, 94], zeh: [10, 99.5] }, { fuss: [2, 94], zeh: [8, 99.5] }], arme: [{ hand: [76, 98.5] }, { hand: [74, 98.5] }] },
    b: { hip: [49.7, 89.2], sh: [79.6, 86], beine: [{ fuss: [4, 94], zeh: [10, 99.5] }, { fuss: [2, 94], zeh: [8, 99.5] }], arme: [{ hand: [76, 98.5] }, { hand: [74, 98.5] }] },
  },
  rudern: {
    dur: 2.6,
    props: WT_COUCH(-4, 84, 76),
    a: { hip: [38, 53], sh: [68, 53], beine: [{ fuss: [15, 76], zw: 180 }, { fuss: [30, 96.5] }], arme: [{ hand: [66, 79], hantel: 1 }, { hand: [69, 76] }] },
    b: { hip: [38, 53], sh: [68, 52], beine: [{ fuss: [15, 76], zw: 180 }, { fuss: [30, 96.5] }], arme: [{ hand: [54, 58], hantel: 1 }, { hand: [69, 76] }] },
  },
  schulterdruecken: {
    dur: 2.4,
    a: { ...WT_STEHEN, arme: [{ hand: [58, 20], hantel: 1 }, { hand: [56, 20], hantel: 1 }] },
    b: { ...WT_STEHEN, arme: [{ hand: [53, -5], hantel: 1 }, { hand: [51, -5], hantel: 1 }] },
  },
  pull_apart: {
    dur: 2.4, front: 1, band: 'haende',
    a: { hip: [50, 51], t: 0, beine: [{ fuss: [55, 96.5], zw: 15 }, { fuss: [45, 96.5], zw: 165, knick: 1 }], arme: [{ hand: [54, 38], knick: -1 }, { hand: [46, 38] }] },
    b: { hip: [50, 51], t: 0, beine: [{ fuss: [55, 96.5], zw: 15 }, { fuss: [45, 96.5], zw: 165, knick: 1 }], arme: [{ hand: [76, 22], knick: -1 }, { hand: [24, 22] }] },
  },
  dead_bug: {
    dur: 3,
    a: { hip: [58, 92], sh: [28, 92], beine: [{ fuss: [81, 69], zw: -80 }, { fuss: [79, 70], zw: -80 }], arme: [{ hand: [28, 66] }, { hand: [30, 66] }] },
    b: { hip: [58, 92], sh: [28, 92], beine: [{ fuss: [81, 69], zw: -80 }, { fuss: [101, 87], zw: -80 }], arme: [{ hand: [2, 86] }, { hand: [30, 66] }] },
  },
  pallof: {
    dur: 3, band: [0, 32],
    props: WT_PFOSTEN(0, 32),
    a: { hip: [46, 51], t: 0, beine: [{ fuss: [50, 96.5] }, { fuss: [44, 96.5] }], arme: [{ hand: [56, 33] }, { hand: [54, 33] }] },
    b: { hip: [46, 51], t: 0, beine: [{ fuss: [50, 96.5] }, { fuss: [44, 96.5] }], arme: [{ hand: [71, 29] }, { hand: [69, 29] }] },
  },
  // ----- C · Stabi -----
  unterarmstuetz: {
    dur: 3,
    a: { hip: [46, 88], sh: [75, 84], beine: [{ fuss: [1, 94], zeh: [6, 99.5] }, { fuss: [-1, 94], zeh: [4, 99.5] }], arme: [{ hand: [89, 98] }, { hand: [87, 98] }] },
    b: { hip: [46, 86.5], sh: [75, 84], beine: [{ fuss: [1, 94], zeh: [6, 99.5] }, { fuss: [-1, 94], zeh: [4, 99.5] }], arme: [{ hand: [89, 98] }, { hand: [87, 98] }] },
  },
  seitstuetz_l: { dur: 3, a: wtSeit(), b: wtSeit({ hip: [45, 87.5] }) },
  seitstuetz_r: { dur: 3, spiegel: 1, a: wtSeit(), b: wtSeit({ hip: [45, 87.5] }) },
  bird_dog: {
    dur: 3.2,
    a: wtVier(),
    b: wtVier({ beine: [{ fuss: [19, 96.5], zw: 180 }, { fuss: [-2, 70], zw: 180 }], arme: [{ hand: [98, 69] }, { hand: [71, 99] }] }),
  },
  wallsit: {
    dur: 2.4,
    props: WT_WAND(18),
    a: { hip: [26, 70], t: -2, beine: [{ fuss: [50, 92], zeh: [56, 98] }, { fuss: [48, 92], zeh: [54, 98] }], arme: [{ hand: [42, 67] }, { hand: [40, 67] }] },
    b: { hip: [26, 70], t: -2, beine: [{ fuss: [50, 90], zeh: [56, 98] }, { fuss: [48, 90], zeh: [54, 98] }], arme: [{ hand: [42, 67] }, { hand: [40, 67] }] },
  },
  monster_walk: {
    dur: 2, front: 1, band: 'fuesse',
    a: { hip: [50, 58], t: 0, beine: [{ fuss: [61, 96.5], zw: 15 }, { fuss: [39, 96.5], zw: 165, knick: 1 }], arme: [{ hand: [58, 48], knick: -1 }, { hand: [42, 48] }] },
    b: { hip: [46, 58], t: 0, beine: [{ fuss: [61, 96.5], zw: 15 }, { fuss: [30, 96.5], zw: 165, knick: 1 }], arme: [{ hand: [54, 48], knick: -1 }, { hand: [38, 48] }] },
  },
  hollow: {
    dur: 3,
    a: { hip: [50, 95], sh: [22, 88], beine: [{ fuss: [94, 86], zw: -80 }, { fuss: [93, 87.5], zw: -80 }], arme: [{ hand: [-3, 81] }, { hand: [-1, 82] }] },
    b: { hip: [50, 95], sh: [22, 86], beine: [{ fuss: [94, 83], zw: -80 }, { fuss: [93, 84.5], zw: -80 }], arme: [{ hand: [-3, 78] }, { hand: [-1, 79] }] },
  },
  copenhagen: {
    dur: 3,
    props: WT_COUCH(-6, 26, 74),
    a: { hip: [45.4, 79.6], sh: [75, 84.5], beine: [{ fuss: [0, 72], zw: -75 }, { fuss: [36, 98], zw: 0 }], arme: [{ hand: [52, 72] }, { hand: [88, 98.5] }] },
    b: { hip: [45.4, 76], sh: [75, 84.5], beine: [{ fuss: [0, 72], zw: -75 }, { fuss: [30, 84], zw: 0 }], arme: [{ hand: [52, 70] }, { hand: [88, 98.5] }] },
  },
};
// Figur als SVG-Text: wtFigur(id, { groesse, farbe, still: 'a'|'b' }); leer, wenn es für die Übung keine Posen gibt
function wtFigur(id, o = {}) {
  const u = WT_POSEN[id]; if (!u) return '';
  const farbe = o.farbe || WT_KRAFT, fern = u.front ? farbe : (o.fern || '#7d5f86'), dur = u.dur || 3;
  const G = (o.still ? [u[o.still] ? o.still : 'a'] : (u.folge || ['a', 'b'])).map((k) => wtGelenke(u[k]));
  const an = (attr, werte) => (o.still ? '' : wtAnim(attr, werte, dur));
  const z = (n) => n.toFixed(1);
  const linie = (f, c, w) => { const v = G.map((g) => wtD(f(g))); return `<path d="${v[0]}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${an('d', v)}</path>`; };
  const kreis = (f, r, attrs) => { const v = G.map(f); return `<circle cx="${z(v[0][0])}" cy="${z(v[0][1])}" r="${r}" ${attrs}>${an('cx', v.map((p) => z(p[0])))}${an('cy', v.map((p) => z(p[1])))}</circle>`; };
  const hantel = (f) => kreis(f, 3.4, 'fill="#3a3d44" stroke="#9aa0a6" stroke-width="1.4"');
  const band = !u.band ? '' : linie((g) => (u.band === 'haende' ? [g.arme[0][2], g.arme[1][2]] : u.band === 'fuesse' ? [g.beine[0][2], g.beine[1][2]] : [u.band, g.arme[0][2]]), WT_BAND, 1.8);
  const X = G[0];
  const figur = [
    linie((g) => g.beine[1], fern, 4.2), linie((g) => g.arme[1], fern, 3.6),
    linie((g) => g.rumpf, farbe, 5), kreis((g) => g.kopf, 6.2, `fill="${farbe}"`),
    linie((g) => g.beine[0], farbe, 4.6), linie((g) => g.arme[0], farbe, 4), band,
    ...X.hanteln.map((_, k) => hantel((g) => g.hanteln[k])),
    X.hantelHuefte ? hantel((g) => wtAdd(g.hantelHuefte, [0, -5])) : '',
  ].join('');
  const s = o.groesse || 96;
  return `<svg viewBox="-6 -14 112 118" width="${s}" height="${(s * 118 / 112).toFixed(1)}" style="display:block;overflow:visible">` +
    `<line x1="-4" y1="100.5" x2="104" y2="100.5" stroke="#3c4043" stroke-width="1.5"/>${u.spiegel ? `<g transform="translate(100 0) scale(-1 1)">${u.props || ''}${figur}</g>` : `${u.props || ''}${figur}`}</svg>`;
}
window.wandTrainingFiguren = { posen: WT_POSEN, figur: wtFigur };      // für das Figurenblatt (Werkzeug im HA-Repo)
// Einheiten aus der Konfiguration der Ansicht „training“ (eine Quelle; Storage-Dashboards kennen keine YAML-Anker). Je Seite einmal geladen,
// nach 1 h neu (Änderungen am Dashboard laden die Seite ohnehin neu).
const wtQuelle = {};
function wtEinheitenLaden(hass, dashboard, ansicht) {
  const key = `${dashboard}/${ansicht}`, q = wtQuelle[key];
  if (q && Date.now() - q.t < 3600000) return q.p;
  const finde = (o) => {
    if (!o || typeof o !== 'object') return null;
    if (o.type === 'custom:wand-training' && o.einheiten) return o.einheiten;
    for (const v of Object.values(o)) { const r = finde(v); if (r) return r; }
    return null;
  };
  const p = hass.callWS({ type: 'lovelace/config', url_path: dashboard }).then((c) => {
    const v = (c.views || []).find((x) => x.path === ansicht);
    return v ? finde(v) : null;
  }).catch(() => null);
  wtQuelle[key] = { p, t: Date.now() };
  p.then((r) => { if (!r) wtQuelle[key].t = Date.now() - 3540000; });      // ohne Ergebnis in 1 min noch einmal versuchen
  return p;
}
const wtNavigieren = (pfad) => { history.pushState(null, '', pfad); window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } })); };
const wtKurz = (u) => u.kurz || u.n;
const wtNamen = (e) => [...new Set((e.uebungen || []).map(wtKurz))];
const WT_CSS = `
:host { display: block; }
.k { position: relative; box-sizing: border-box; background: rgba(17,19,23,0.62); -webkit-backdrop-filter: blur(14px) saturate(1.15); backdrop-filter: blur(14px) saturate(1.15);
  border: 1px solid rgba(255,255,255,0.08); border-radius: 20px; padding: 12px 14px 14px; color: #e8eaed; font-family: var(--ha-font-family-body, Roboto, sans-serif);
  cursor: pointer; -webkit-tap-highlight-color: transparent; }
.kopf { display: flex; align-items: center; gap: 12px; padding-right: 26px; }
.sym { width: 38px; height: 38px; border-radius: 50%; background: rgba(206,147,216,0.2); display: inline-flex; align-items: center; justify-content: center; flex: none; }
.sym ha-icon { --mdc-icon-size: 22px; color: ${WT_KRAFT}; }
.tt { min-width: 0; flex: 1; }
.tt b { display: block; font-size: 16px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tt span { display: block; font-size: 12.5px; color: #a7acb4; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.weg { position: absolute; right: 6px; top: 8px; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; color: #8b9099; font-size: 18px; }
.grund { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13px; color: #ffc58a; }
.grund ha-icon { --mdc-icon-size: 17px; color: #ffb340; flex: none; }
.ueb { display: flex; gap: 10px; align-items: center; margin-top: 10px; }
.fig { flex: none; width: 44px; display: flex; justify-content: center; }
.fig ha-icon { --mdc-icon-size: 30px; color: ${WT_KRAFT}; opacity: .9; }
.namen { flex: 1; font-size: 12.5px; line-height: 1.5; color: #c4c7cc; }
.kompakt .namen { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-left: 50px; }
.rot { display: flex; gap: 5px; margin-top: 12px; }
.rot span { flex: 1; min-width: 0; display: flex; align-items: center; gap: 5px; padding: 6px 7px; border-radius: 10px; font-size: 12px; color: #a7acb4;
  background: rgba(255,255,255,.05); border: 1px solid transparent; }
.rot span.an { background: rgba(206,147,216,.18); border-color: rgba(206,147,216,.4); color: #f3e5f5; }
.rot span b { font-size: 13px; }
.rot span i { flex: 1; font-style: normal; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rot ha-icon { --mdc-icon-size: 15px; color: #81c995; flex: none; }
.soll { display: flex; gap: 6px; align-items: center; margin-top: 12px; font-size: 12.5px; color: #a7acb4; }
.pl { width: 22px; height: 22px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; box-sizing: border-box;
  background: rgba(255,255,255,.08); color: #7a7f87; }
.zeile { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 13px; }
.zeile ha-icon { --mdc-icon-size: 18px; color: #a7acb4; flex: none; }
.zeile small { color: #8b9099; font-size: 13px; }
.sym.lauf { background: rgba(252,82,0,0.2); }
.sym.lauf ha-icon { color: ${WT_LAUF}; }
.u { display: flex !important; align-items: center; gap: 3px; }
.tt .u .pl { display: inline-flex; flex: none; width: 18px; height: 18px; margin: 0; font-size: 10px; color: #7a7f87; border-radius: 6px; overflow: visible; }
.u i { font-style: normal; margin: 0 2px; }
.gross { display: flex; align-items: baseline; gap: 14px; margin-top: 8px; }
.k.lauf .zeile { margin-top: 7px; }
.gross b { font-size: 26px; font-weight: 700; letter-spacing: -0.5px; white-space: nowrap; }
.gross b small { font-size: 13px; font-weight: 500; color: #a7acb4; margin-left: 4px; letter-spacing: 0; }
.leiste { display: flex; gap: 3px; margin-top: 8px; }
.sd { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 3px; font-size: 10.5px; color: #8b9099; }
.sd .t.g { color: #ffd0b8; }
.bar { width: 100%; height: 28px; display: flex; align-items: flex-end; border-radius: 4px; background: rgba(255,255,255,0.04); overflow: hidden; }
.bar.g { background: rgba(252,82,0,0.22); box-shadow: inset 0 0 0 1px rgba(252,82,0,0.55); }
.bar div { width: 100%; background: #4fc3f7; border-radius: 3px; }
`;
// Pille für das Wochen-Soll (Status ok | faellig | offen), Farbe Lauf orange, sonst Kraft-Lila
const wtPille = (t, st) => {
  const f = t === 'L' ? WT_LAUF : WT_KRAFT;
  const s = st === 'ok' ? `background:${f};color:#111` : st === 'faellig' ? `border:1.5px solid ${f};color:${f};background:none` : '';
  return `<span class="pl" style="${s}">${wrEsc(t)}</span>`;
};
const wtHeute = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; };
// Kraft-Aussehen bei „heute kein trockenes Fenster“: wann es morgen trocken ist (nicht am Sonntag – dann beginnt eine neue Woche)
const wtLaufMorgen = (lw) => {
  const m = lw.morgen, wd = new Date().getDay();
  if (!m || !m.n || m.nass >= m.n || wd === 0) return '';
  const wann = !m.nass ? `trocken ab ${m.ab} Uhr` : m.regen_ab != null ? `trocken bis ${m.regen_ab} Uhr` : `trocken ab ${m.trocken_ab} Uhr`;
  return `<div class="zeile"><ha-icon icon="mdi:run" style="color:${WT_LAUF}"></ha-icon><span>Lauf lieber ${wd === 6 ? 'Sonntag' : 'morgen'}<small> · ${wann}</small></span></div>`;
};
// ----- Ansicht „Training“ (seit 1.12): gemeinsame Auswahl, Datum/ISO-Woche, Timer, Ton, Wake-Lock, Rückfragen -----
const WT_ARTEN = ['heute', 'naechste', 'einheit', 'saison'];
const wtWahl = { e: '' };                     // in der Ansicht angetippte Einheit (leer = Vorschlag des Motors); gilt für naechste + einheit
const wtWaehlen = (e) => { wtWahl.e = e; window.dispatchEvent(new CustomEvent('wand-training-wahl')); };
const wtVorschlag = (z, d) => (['A', 'B', 'C'].includes(z) ? z : d.kraft || (d.rotation || [])[0] || 'A');
const wtTagText = (iso) => { const q = wsTeile(wsTag(String(iso).slice(0, 10))); return `${WS_WTAG[q.w]} ${q.t}.${q.m}.`; };
const wtMontag = (n) => n - ((wsTeile(n).w + 6) % 7);
const wtKw = (n) => {                         // Tageszähler → 'JJJJ-WW' (ISO-Woche, Jahr des Donnerstags)
  const don = wtMontag(n) + 3, j = wsTeile(don).j, erst = wtMontag(wsTag(`${j}-01-04`)) + 3;
  return `${j}-${pad(1 + Math.round((don - erst) / 7))}`;
};
const WT_QUELLE = { watch: 'Watch', start: 'Watch nach Start-Knopf', manuell: 'ohne Watch eingetragen', dauer: 'Watch (nach Dauer)', vorschlag: 'Watch (Vorschlag)', rotation: 'Watch (Rotation)' };
const wtMs = (s) => { const x = Math.max(0, Math.ceil(s - 0.001)); return `${Math.floor(x / 60)}:${pad(x % 60)}`; };
const wtToast = (el, message) => el.dispatchEvent(new CustomEvent('hass-notification', { detail: { message }, bubbles: true, composed: true }));
// Soll/Ist einer Woche aus erledigten Einheiten (A/B/C) und Läufen – wie der Motor (Sommer: K = A oder B)
function wtSollIst(m, es, l) {
  const n = { A: 0, B: 0, C: 0 }; es.forEach((e) => { if (n[e] !== undefined) n[e]++; });
  let rest = l;
  const platz = (s) => {
    if (s === 'L') { if (rest > 0) { rest--; return { s, e: 'L', st: 'ok' }; } return { s, e: 'L', st: 'offen' }; }
    if (s === 'K') { const e = n.A ? 'A' : n.B ? 'B' : ''; if (e) { n[e]--; return { s, e, st: 'ok' }; } return { s, e: '', st: 'offen' }; }
    if (n[s]) { n[s]--; return { s, e: s, st: 'ok' }; }
    return { s, e: s, st: 'offen' };
  };
  const woche = (m === 'sommer' ? ['L', 'L', 'K', 'C'] : ['A', 'B', 'C', 'L']).map(platz);
  return { woche, extra: { L: rest, K: n.A + n.B + n.C } };
}
// Rückfrage als eigene Ebene in document.body (Theme-Variablen von HA liegen auf <html>). knoepfe: [{ t, f, haupt, warn }]
function wtFrage(titel, text, knoepfe) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px;font-family:var(--ha-font-family-body, Roboto, -apple-system, sans-serif)';
  const k = knoepfe.map((b, i) => `<button data-i="${i}" style="min-height:44px;padding:0 18px;border-radius:22px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer;${b.haupt
    ? 'background:#ce93d8;color:#2a0f33;border:none' : b.warn ? 'background:none;color:var(--error-color,#ef5350);border:1px solid var(--divider-color,rgba(127,127,127,.3))'
    : 'background:none;color:var(--primary-text-color);border:1px solid var(--divider-color,rgba(127,127,127,.3))'}">${wrEsc(b.t)}</button>`).join('');
  ov.innerHTML = `<div style="background:var(--card-background-color,#1c1c1c);color:var(--primary-text-color,#e1e1e1);border-radius:20px;width:100%;max-width:360px;padding:20px;box-shadow:0 12px 40px rgba(0,0,0,.45)">
    <div style="font-size:18px;font-weight:700">${wrEsc(titel)}</div>${text ? `<div style="font-size:14px;line-height:1.45;color:var(--secondary-text-color,#9b9b9b);margin-top:8px">${wrEsc(text)}</div>` : ''}
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:18px">${k}</div></div>`;
  const zu = () => ov.remove();
  ov.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (b) { zu(); const f = knoepfe[+b.dataset.i].f; if (f) f(); } else if (ev.target === ov) zu();
  });
  document.body.appendChild(ov);
}
// Timer: Schritte [{ s, seite, u }] nacheinander; Zeit über Zielzeitpunkt (ziel, ms), angehalten über rest (s) – iOS drosselt Hintergrund-Tabs.
// art 'auf' (Aufwärmen, läuft durch), 'ueb' (ein Satz, danach satz + 1 bis saetze), 'pause' (Pausenleiste). Nichts wird gespeichert.
const WT_UHR = { t: {}, karten: new Set(), iv: 0, lock: null };
const WT_TON = { ctx: null };
const wtIos = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function wtTonAn() {                          // nur aus einem Tipp heraus: WebAudio freischalten
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    if (!WT_TON.ctx) WT_TON.ctx = new AC();
    if (WT_TON.ctx.state !== 'running') WT_TON.ctx.resume();
    const s = WT_TON.ctx.createBufferSource(); s.buffer = WT_TON.ctx.createBuffer(1, 1, 22050); s.connect(WT_TON.ctx.destination); s.start(0);
  } catch (x) { /* kein Ton */ }
}
function wtPiep(lang) {
  const c = WT_TON.ctx; if (!c || c.state !== 'running') return;
  try {
    const o = c.createOscillator(), g = c.createGain(), t = c.currentTime, d = lang ? 0.5 : 0.13;
    o.type = 'sine'; o.frequency.value = lang ? 1175 : 880;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.6, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + d + 0.03);
  } catch (x) { /* egal */ }
}
const wtTonOk = () => !!(WT_TON.ctx && WT_TON.ctx.state === 'running');
async function wtWach(an) {                   // Bildschirm wach halten, solange ein Timer läuft
  try {
    if (an && !WT_UHR.lock && navigator.wakeLock) {
      const l = await navigator.wakeLock.request('screen'); WT_UHR.lock = l;
      l.addEventListener('release', () => { if (WT_UHR.lock === l) WT_UHR.lock = null; });
    } else if (!an && WT_UHR.lock) { const l = WT_UHR.lock; WT_UHR.lock = null; await l.release(); }
  } catch (x) { WT_UHR.lock = null; }
}
const wtUhrLaeuft = () => Object.values(WT_UHR.t).some((t) => t.ziel);
function wtUhrNeu(key, def) {
  WT_UHR.t[key] = Object.assign({ i: 0, satz: 0, saetze: 1, ziel: 0, fertig: false, piep: null }, def);
  WT_UHR.t[key].rest = WT_UHR.t[key].schritte[WT_UHR.t[key].i].s;
  return WT_UHR.t[key];
}
function wtUhrStartStop(key) {
  const t = WT_UHR.t[key]; if (!t) return;
  if (t.ziel) { t.rest = Math.max(0, (t.ziel - Date.now()) / 1000); t.ziel = 0; }
  else {
    if (t.fertig) { t.fertig = false; t.satz = 0; t.i = 0; t.rest = t.schritte[0].s; }
    t.ziel = Date.now() + t.rest * 1000; t.piep = null;
  }
  wtUhrTick();
}
function wtUhrSpringen(key, i) {
  const t = WT_UHR.t[key]; if (!t || !t.schritte[i]) return;
  t.i = i; t.rest = t.schritte[i].s; t.fertig = false; t.piep = null;
  if (t.ziel) t.ziel = Date.now() + t.rest * 1000;
  wtUhrTick();
}
function wtUhrTick() {
  const jetzt = Date.now();
  for (const [key, t] of Object.entries(WT_UHR.t)) {
    if (!t.ziel) continue;
    const rest = (t.ziel - jetzt) / 1000, sek = Math.ceil(rest);
    if (rest > 0) {
      if (sek <= 3 && sek !== t.piep && sek - rest < 0.6) wtPiep(false);    // 3 · 2 · 1 (nicht nachholen, wenn die Seite im Hintergrund war)
      t.piep = sek;
      continue;
    }
    // Schritt zu Ende (bei verpasster Zeit im Hintergrund mehrere Schritte nachholen, nur ein Ton)
    if (rest > -1.5) wtPiep(true);
    let ziel = t.ziel;
    while (ziel <= jetzt) {
      if (t.i + 1 < t.schritte.length) { t.i++; ziel += t.schritte[t.i].s * 1000; continue; }
      if (t.art === 'ueb') { t.satz++; t.i = 0; t.rest = t.schritte[0].s; t.fertig = t.satz >= t.saetze; }
      else if (t.art === 'pause') { delete WT_UHR.t[key]; WT_UHR.pauseEnde = jetzt; }
      else { t.fertig = true; t.rest = 0; }
      ziel = 0; break;
    }
    t.ziel = ziel; t.piep = null;
  }
  const laeuft = wtUhrLaeuft();
  if (laeuft && !WT_UHR.iv) WT_UHR.iv = setInterval(wtUhrTick, 200);
  if (!laeuft && WT_UHR.iv) { clearInterval(WT_UHR.iv); WT_UHR.iv = 0; }
  if (laeuft !== !!WT_UHR.wach) { WT_UHR.wach = laeuft; wtWach(laeuft); }
  WT_UHR.karten.forEach((k) => k._uhrZeigen());
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && wtUhrLaeuft()) { WT_UHR.wach = false; wtUhrTick(); } });
const wtSeiten = (u) => u.seiten ?? /je Seite/.test(u.dosis || '');
const wtSchritte = (u) => { const s = +u.timer || 30; return wtSeiten(u) ? [{ s: s / 2, seite: 'links' }, { s: s / 2, seite: 'rechts' }] : [{ s }]; };
const WT_RING_U = 2 * Math.PI * 19;
const wtUhrHtml = (key, gross) => `<div class="uhr" data-uhr="${key}"><svg width="46" height="46" viewBox="0 0 46 46"><circle class="rb" cx="23" cy="23" r="19" fill="none" stroke-width="5"/>` +
  `<circle class="rv" cx="23" cy="23" r="19" fill="none" stroke-width="5" stroke-linecap="round" stroke-dasharray="${WT_RING_U.toFixed(1)}" transform="rotate(-90 23 23)"/></svg>` +
  `<div class="uz"><b class="zeit">${gross}</b><span class="info"></span><span class="ton"></span></div>` +
  `<span class="ub neu" role="button" aria-label="Zurücksetzen"><ha-icon icon="mdi:restore"></ha-icon></span><span class="ub play" role="button" aria-label="Start/Pause"><ha-icon icon="mdi:play-circle"></ha-icon></span></div>`;
const WT_ANS_CSS = `
:host { --wt-lila: color-mix(in srgb, ${WT_KRAFT} 72%, var(--primary-text-color)); --wt-blau: color-mix(in srgb, #90caf9 70%, var(--primary-text-color));
  --wt-sonne: color-mix(in srgb, #ffb74d 80%, var(--primary-text-color)); --wt-flaeche: rgba(127,127,127,.1); --wt-rand: var(--divider-color, rgba(127,127,127,.25)); }
.kopf .mod { margin-left: auto; display: inline-flex; padding: 3px; border-radius: 16px; background: var(--wt-flaeche); border: 1px solid var(--wt-rand); }
.mod span { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 13px; font-size: 12px; font-weight: 600; color: var(--secondary-text-color); cursor: pointer; }
.mod span.an { background: var(--card-background-color, #2a2a2a); color: var(--primary-text-color); box-shadow: 0 1px 3px rgba(0,0,0,.25); }
.kopf .mod ha-icon { --mdc-icon-size: 14px; color: inherit; }
.mod span.an ha-icon.w { color: var(--wt-blau); } .mod span.an ha-icon.s { color: var(--wt-sonne); }
.mhinw { font-size: 12px; color: var(--secondary-text-color); margin: -4px 0 10px; display: flex; align-items: center; gap: 6px; }
.mhinw ha-icon { --mdc-icon-size: 14px; }
.status { display: flex; align-items: flex-start; gap: 8px; font-size: 13.5px; margin-bottom: 12px; line-height: 1.4; }
.status ha-icon { --mdc-icon-size: 18px; flex: none; }
.status small { color: var(--secondary-text-color); font-size: 13px; }
.kach { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.ka { padding: 10px; border-radius: 12px; background: var(--wt-flaeche); border: 1px solid transparent; cursor: pointer; min-width: 0;
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
.ka.wahl { background: rgba(206,147,216,.16); border-color: rgba(206,147,216,.65); }
.ka .kb { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ka .kb b { font-size: 18px; }
.badge { font-size: 10px; font-weight: 700; letter-spacing: .03em; color: #2a0f33; background: ${WT_KRAFT}; border-radius: 6px; padding: 1px 6px; }
.badge.ok { background: #81c995; color: #0d2a14; }
.ka .kn { font-size: 13px; margin-top: 3px; line-height: 1.3; }
.ka .kz { font-size: 11.5px; color: var(--secondary-text-color); margin-top: 3px; line-height: 1.35; }
.woche { display: flex; align-items: center; gap: 6px; margin-top: 12px; font-size: 13px; }
.woche .wt { flex: 1; min-width: 0; }
.woche .wt span, .sek { color: var(--secondary-text-color); }
.pl { width: 24px; height: 24px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; box-sizing: border-box;
  background: rgba(127,127,127,.15); color: var(--secondary-text-color); flex: none; }
.xl { font-size: 12px; font-weight: 700; }
.knoepfe { display: flex; gap: 8px; margin-top: 14px; }
.btn { flex: 1; min-height: 46px; border-radius: 23px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; font-weight: 600; font-size: 15px; border: none;
  cursor: pointer; font-family: inherit; background: ${WT_KRAFT}; color: #2a0f33; -webkit-tap-highlight-color: transparent; }
.btn ha-icon { --mdc-icon-size: 20px; }
.btn.zwei { background: none; color: var(--primary-text-color); border: 1px solid var(--wt-rand); }
.watch { display: flex; gap: 8px; margin-top: 12px; font-size: 12.5px; color: var(--secondary-text-color); align-items: flex-start; line-height: 1.4; }
.watch ha-icon { --mdc-icon-size: 16px; flex: none; margin-top: 1px; }
.watch b { font-weight: 500; color: var(--primary-text-color); }
.links { display: flex; flex-wrap: wrap; gap: 2px 18px; margin-top: 8px; font-size: 13px; }
.links span { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; color: var(--secondary-text-color); padding: 6px 0; }
.links span.l { color: var(--wt-lila); }
.links ha-icon { --mdc-icon-size: 16px; }
.aus { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 10px 12px; border-radius: 10px; background: var(--wt-flaeche); font-size: 13.5px; }
.aus span { flex: 1; } .aus a { color: var(--wt-lila); cursor: pointer; font-weight: 600; }
.hinweis { font-size: 13px; color: var(--secondary-text-color); margin: -2px 4px 12px; line-height: 1.45; }
.sp > * { display: inline-block; width: 100%; box-sizing: border-box; margin-bottom: 12px; break-inside: avoid; -webkit-column-break-inside: avoid; vertical-align: top; }
.sp.zwei { column-count: 2; column-gap: 16px; }
ha-card.ueb, ha-card.auf { padding: 12px; }
.ug { display: flex; gap: 12px; }
.fb { flex: none; width: 100px; background: #151517; border-radius: 10px; display: flex; align-items: center; justify-content: center; padding: 6px 0; align-self: flex-start; }
.fb.leer { height: 84px; font-size: 22px; font-weight: 700; color: ${WT_KRAFT}; }
.ut { flex: 1; min-width: 0; }
.un { display: flex; align-items: baseline; gap: 6px; } .un .nr { color: var(--secondary-text-color); font-size: 12px; } .un b { font-size: 15.5px; line-height: 1.3; }
.ud { font-size: 13px; margin-top: 4px; line-height: 1.4; }
ul.tp { margin: 6px 0 0; padding-left: 16px; font-size: 12.5px; color: var(--secondary-text-color); line-height: 1.45; }
.st { margin-top: 8px; font-size: 12px; color: var(--secondary-text-color); display: flex; gap: 6px; align-items: flex-start; line-height: 1.4; }
.st ha-icon { --mdc-icon-size: 14px; flex: none; margin-top: 1px; }
.paar { border-left: 3px solid rgba(206,147,216,.55); padding-left: 10px; }
.paar ha-card + ha-card { margin-top: 10px; }
.pk { font-size: 12px; color: var(--wt-lila); margin: 0 0 8px; display: flex; align-items: center; gap: 6px; }
.pk ha-icon { --mdc-icon-size: 15px; }
.uhr { display: flex; align-items: center; gap: 12px; margin-top: 12px; padding: 10px 8px 10px 12px; border-radius: 10px; background: var(--wt-flaeche); cursor: pointer;
  user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
.uhr svg { flex: none; } .uhr .rb { stroke: rgba(127,127,127,.25); } .uhr .rv { stroke: ${WT_KRAFT}; }
.uhr .uz { flex: 1; min-width: 0; } .uhr .zeit { font-size: 22px; font-weight: 700; letter-spacing: -.5px; font-variant-numeric: tabular-nums; }
.uhr .info { color: var(--secondary-text-color); font-size: 13px; }
.uhr .ton { display: block; font-size: 11.5px; color: var(--secondary-text-color); margin-top: 2px; }
.uhr .ton:empty { display: none; }
.ub { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; color: var(--secondary-text-color); flex: none; }
.ub.neu ha-icon { --mdc-icon-size: 20px; } .ub.play { color: ${WT_KRAFT}; } .ub.play ha-icon { --mdc-icon-size: 36px; }
.uhr.still .ub.neu { visibility: hidden; }
.blink .rv, .blink .zeit, .pausen.blink b { animation: wtBlink .5s steps(2, start) infinite; }
@keyframes wtBlink { to { opacity: .15; } }
.ak { display: flex; align-items: center; gap: 8px; cursor: pointer; } .ak b { flex: 1; font-size: 14.5px; } .ak span { font-size: 12px; color: var(--secondary-text-color); }
.ak ha-icon { --mdc-icon-size: 20px; color: var(--secondary-text-color); }
.al { margin-top: 8px; font-size: 13px; line-height: 1.8; }
.ar { display: flex; gap: 8px; cursor: pointer; } .ar span:first-child { flex: 1; min-width: 0; } .ar span:last-child { white-space: nowrap; }
.ar.done { opacity: .5; text-decoration: line-through; } .ar.jetzt { color: var(--wt-lila); font-weight: 600; }
.zu .al, .zu .uhr { display: none; }
.and { display: flex; align-items: center; gap: 10px; padding: 6px 0; cursor: pointer; } .and + .and { border-top: 1px solid var(--wt-rand); }
.and b { width: 18px; font-size: 16px; } .and div { flex: 1; min-width: 0; } .and small { display: block; font-size: 12px; color: var(--secondary-text-color); line-height: 1.4; }
.and ha-icon { --mdc-icon-size: 20px; color: var(--secondary-text-color); }
.pausen { position: sticky; bottom: 16px; z-index: 3; display: flex; align-items: center; gap: 8px; height: 58px; padding: 0 8px 0 16px; box-sizing: border-box; border-radius: 29px;
  background: color-mix(in srgb, var(--card-background-color, #1c1c1c) 90%, transparent); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
  border: 1px solid var(--wt-rand); box-shadow: 0 6px 20px rgba(0,0,0,.3); }
@media (max-width: 767px) { .pausen { bottom: calc(env(safe-area-inset-bottom, 0px) + 86px); } }
.pausen .pt { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--secondary-text-color); white-space: nowrap; }
.pausen .pt ha-icon { --mdc-icon-size: 20px; }
.pausen .pt b { font-size: 20px; color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
.pausen .pw { height: 40px; padding: 0 13px; border-radius: 20px; display: inline-flex; align-items: center; font-weight: 600; font-size: 13px; background: rgba(127,127,127,.16);
  cursor: pointer; color: var(--primary-text-color); -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none; }
.pausen .pw.an { background: ${WT_KRAFT}; color: #2a0f33; }
.sz { display: flex; align-items: center; gap: 9px; margin: 7px 0; }
.sz .kw { width: 44px; font-size: 12.5px; color: var(--secondary-text-color); white-space: nowrap; flex: none; }
.sz.jetzt .kw { color: var(--primary-text-color); font-weight: 600; }
.sz > ha-icon { --mdc-icon-size: 15px; flex: none; }
.sz .pls { display: flex; gap: 5px; align-items: center; }
.sz .x { flex: 1; text-align: right; white-space: nowrap; }
.sz .n { width: 28px; text-align: right; font-size: 12px; color: var(--secondary-text-color); flex: none; }
.pause { font-size: 11.5px; padding: 4px 8px; border-radius: 7px; background: rgba(127,127,127,.15); color: var(--secondary-text-color); }
.trenn { display: flex; align-items: center; gap: 8px; margin: 12px 0 6px; font-size: 11.5px; }
.trenn ha-icon { --mdc-icon-size: 14px; } .trenn i { flex: 1; height: 1px; background: currentColor; opacity: .3; }
.regeln { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--wt-rand); font-size: 11.5px; color: var(--secondary-text-color); line-height: 1.7; }
.regeln ha-icon { --mdc-icon-size: 13px; margin-right: 3px; }
`;
// Pille im HA-Stil (Theme-Farben): ok gefüllt, fällig umrandet, offen grau
const wtPilleT = (t, st) => {
  const f = t === 'L' ? WT_LAUF : WT_KRAFT;
  const s = st === 'ok' ? `background:${f};color:#111` : st === 'faellig' ? `border:1.5px solid ${f};color:${t === 'L' ? WT_LAUF : 'var(--wt-lila)'};background:none` : '';
  return `<span class="pl" style="${s}">${wrEsc(t)}</span>`;
};
const wtExtra = (x) => [x.L > 0 ? `<span class="xl" style="color:${WT_LAUF}">+${x.L} L</span>` : '', x.K > 0 ? `<span class="xl" style="color:var(--wt-lila)">+${x.K} K</span>` : ''].filter(Boolean).join(' ');
class WandTraining extends HTMLElement {
  setConfig(c) {
    if (!c || !WT_ARTEN.includes(c.art)) throw new Error(`art fehlt oder unbekannt (${WT_ARTEN.join(', ')})`);
    this._cfg = Object.assign({ entity: 'sensor.training_heute', wetter: 'sensor.laufwetter', test: 'input_boolean.wand_training_heute_test', ansicht: 'training', ziel: '', weg: 'script.training_heute_nicht', animation: 60,
      stand: 'sensor.training_stand', strava: 'sensor.strava_stats', modus: 'input_select.training_modus', laeuft: 'input_text.training_laeuft', wochen: 8 }, c);
    this._sig = null;
    this._vollH = {};
    if (c.einheiten) this._einh = c.einheiten;
  }
  getCardSize() { return { einheit: 12, naechste: 5, saison: 6 }[this._cfg && this._cfg.art] || 3; }
  getGridOptions() { return { columns: this._cfg && this._cfg.art !== 'heute' ? 'full' : 12, min_columns: 6 }; }      // full: einheit füllt auch einen Abschnitt mit column_span 2
  set hass(h) {
    this._hass = h;
    const c = this._cfg, e = h && h.states[c.entity], t = h && h.states[c.test], w = h && h.states[c.wetter];
    if ((c.art === 'heute' || c.art === 'naechste') && !this._einh && !this._laedt) {
      this._laedt = true;
      const dash = c.dashboard || location.pathname.split('/')[1] || 'home-new';
      if (!c.ziel) c.ziel = `/${dash}/${c.ansicht}`;
      const laden = () => wtEinheitenLaden(this._hass, dash, c.ansicht).then((r) => {
        if (r) { this._einh = r; this._sig = null; this._render(); } else this._nochmal = setTimeout(laden, 65000);   // ohne Einheiten: Karte zeigt nur Kopf
      });
      laden();
    }
    const lu = (id) => { const x = h && h.states[id]; return x ? `${x.state}@${x.last_updated}` : ''; };
    let sig;
    if (c.art === 'heute') sig = [e ? e.state : '', e ? e.last_updated : '', t ? t.state : '', w ? w.last_updated : '', !!this._einh, this._kompakt].join('|');
    else if (c.art === 'naechste') sig = [lu(c.entity), lu(c.stand), lu(c.modus), lu(c.laeuft), wtWahl.e, !!this._einh, wsHeute()].join('|');
    else if (c.art === 'einheit') sig = [e ? e.state : '', e && e.attributes.daten ? e.attributes.daten.kraft : '', wtWahl.e].join('|');
    else sig = [lu(c.entity), lu(c.stand), h && h.states[c.strava] ? h.states[c.strava].last_updated : '', wsHeute()].join('|');
    if (sig === this._sig) return;
    this._sig = sig;
    this._render();
  }
  connectedCallback() {
    const art = this._cfg && this._cfg.art;
    if (art === 'heute') requestAnimationFrame(() => this._stapelBeobachten());
    if (art === 'naechste' || art === 'einheit') {
      this._wahlHoerer = () => { this._sig = null; if (this._hass) this.hass = this._hass; };
      window.addEventListener('wand-training-wahl', this._wahlHoerer);
    }
    if (art === 'einheit') {
      WT_UHR.karten.add(this);
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(() => { const sp = this.shadowRoot && this.shadowRoot.getElementById('sp'); if (sp) sp.classList.toggle('zwei', this.clientWidth >= 640); });
        this._ro.observe(this);
      }
    }
  }
  disconnectedCallback() {
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this._mo) { this._mo.disconnect(); this._mo = null; }
    if (this._wahlHoerer) { window.removeEventListener('wand-training-wahl', this._wahlHoerer); this._wahlHoerer = null; }
    WT_UHR.karten.delete(this);
    clearTimeout(this._still); clearTimeout(this._nochmal);
    if (!this._einh) this._laedt = false;
  }
  _render() {
    if (!this._cfg || !this._hass) return;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const art = this._cfg.art;
    if (art === 'heute') this._heute();
    else if (art === 'naechste') this._naechste();
    else if (art === 'einheit') this._einheit();
    else this._saison();
  }

  // ----- art: heute (Wand) -----
  _heute() {
    const h = this._hass, c = this._cfg, e = h.states[c.entity], d = (e && e.attributes.daten) || {};
    const test = h.states[c.test] && h.states[c.test].state === 'on';
    const z = e ? e.state : '';
    const wz = h.states[c.wetter], lw = (wz && wz.attributes.daten) || {};
    const lwHeute = lw.datum === wtHeute();
    if (z === 'L' || (test && d.aussehen === 'lauf')) { this._aussehen = 'lauf'; this._lauf(d, lwHeute ? lw : {}); this._nachRender(); return; }
    this._aussehen = 'kraft';
    const einheit = ['A', 'B', 'C'].includes(z) ? z : (test ? (d.kraft || (d.rotation || [])[0] || 'A') : '');
    if (!einheit) { this.shadowRoot.innerHTML = ''; return; }
    const E = (this._einh || {})[einheit] || {}, name = E.name || '';
    const namen = wtNamen(E), anzahl = (E.uebungen || []).length;
    const sonst = d.danach && d.danach.wann === 'heute' && d.danach.e ? d.danach.e : '';
    const unter = [E.dauer ? `≈ ${E.dauer} min` : '', anzahl ? `${anzahl} Übungen` : '', sonst ? `sonst ${sonst}` : ''].filter(Boolean).join(' · ');
    const kopf = `<div class="kopf"><span class="sym"><ha-icon icon="mdi:dumbbell"></ha-icon></span><div class="tt"><b>Heute dran: ${einheit}${name ? ` · ${wrEsc(name)}` : ''}</b><span>${unter}</span></div></div>`;
    const weg = `<div class="weg" id="weg" role="button" aria-label="Heute nicht">✕</div>`;
    let inhalt;
    if (this._kompakt) inhalt = namen.length ? `<div class="namen" style="margin-top:6px">${namen.map(wrEsc).join(' · ')}</div>` : '';
    else {
      const figId = (E.figur && WT_POSEN[E.figur]) ? E.figur : ((E.uebungen || []).map((u) => u.id).find((i) => WT_POSEN[i]) || '');
      const fig = figId ? wtFigur(figId, { groesse: 44 }) : `<ha-icon icon="${E.icon || 'mdi:dumbbell'}"></ha-icon>`;
      inhalt = (d.grund ? `<div class="grund"><ha-icon icon="mdi:information-outline"></ha-icon><span>${wrEsc(d.grund)}</span></div>` : '') +
        (d.grund === 'heute kein trockenes Fenster' && lwHeute ? wtLaufMorgen(lw) : '') +
        (namen.length ? `<div class="ueb"><div class="fig">${fig}</div><div class="namen">${namen.map(wrEsc).join(' · ')}</div></div>` : '');
      if (d.modus === 'sommer') {
        inhalt += `<div class="soll">Woche ${(d.woche || []).map((w) => wtPille(w.st === 'ok' ? w.e || w.s : w.s, w.st)).join('')}</div>`;
      } else {
        const ok = new Set((d.woche || []).filter((w) => w.st === 'ok').map((w) => w.e));
        inhalt += `<div class="rot">${['A', 'B', 'C'].map((x) => {
          const nm = ((this._einh || {})[x] || {}).name || '';
          return `<span class="${x === einheit ? 'an' : ''}"><b>${x}</b><i>${wrEsc(nm.replace(/ \+ .*$/, ''))}</i>${ok.has(x) ? '<ha-icon icon="mdi:check-circle"></ha-icon>' : ''}</span>`;
        }).join('')}</div>`;
      }
      inhalt += `<div class="zeile"><ha-icon icon="mdi:watch"></ha-icon><span>Watch: Funktionales Krafttraining<small> · zählt von selbst</small></span></div>`;
    }
    this.shadowRoot.innerHTML = `<style>${WT_CSS}</style><div class="k${this._kompakt ? ' kompakt' : ''}" id="k">${kopf}${weg}${inhalt}</div>`;
    this._nachRender();
  }
  // Tippen/✕, Figur nach einer Weile anhalten, Höhe für die Kompakt-Regel merken (für Kraft- und Lauf-Aussehen gleich)
  _nachRender() {
    const h = this._hass, c = this._cfg;
    const k = this.shadowRoot.getElementById('k');
    if (!k) return;
    k.addEventListener('click', () => wtNavigieren(c.ziel || '/home-new/training'));
    this.shadowRoot.getElementById('weg').addEventListener('click', (ev) => {
      ev.stopPropagation();
      const [dom, srv] = c.weg.split('.');
      h.callService(dom, srv, {});
    });
    // Animation nur eine Weile laufen lassen (Wand-iPad schonen), danach steht die Figur
    clearTimeout(this._still);
    const svg = this.shadowRoot.querySelector('.fig svg');
    if (svg && c.animation > 0) this._still = setTimeout(() => { try { svg.pauseAnimations(); } catch (x) { /* egal */ } }, c.animation * 1000);
    const aus = this._aussehen;
    if (!this._kompakt) requestAnimationFrame(() => { const hh = this.offsetHeight; if (hh > 60) this._vollH[aus] = hh; this._stapelPruefen(); });
    else requestAnimationFrame(() => this._stapelPruefen());
  }
  // ----- Lauf-Aussehen (Phase 3): Titel nach Modus, Wochen-Soll im Untertitel, „bis 13 Uhr trocken“, Stundenleiste bis Sonnenuntergang
  // (Regen-Balken, bestes Fenster orange), Zeilen Bestes Fenster / Morgen: Einheit / Wetter morgen. lw = Daten von sensor.laufwetter (leer, wenn nicht von heute).
  _lauf(d, lw) {
    const c = this._cfg, wd = new Date().getDay(), winter = d.modus !== 'sommer';
    const pillen = (d.woche || []).map((w) => wtPille(w.st === 'ok' ? w.e || w.s : w.s, w.st)).join('');
    const unter = winter ? `${wd === 0 || wd === 6 ? 'Wochenende noch ohne Lauf<i>·</i>' : ''}Woche ${pillen}` : `Woche ${pillen}<i>·</i>${(d.laeufe || 0) + 1}. Lauf`;
    const kopf = `<div class="kopf"><span class="sym lauf"><ha-icon icon="mdi:run"></ha-icon></span><div class="tt"><b>${winter ? 'Laufwetter heute' : 'Heute dran: Laufen'}</b><span class="u">${unter}</span></div></div>`;
    const weg = `<div class="weg" id="weg" role="button" aria-label="Heute nicht">✕</div>`;
    const st = lw.stunden || [], fen = lw.fenster;
    let gross = '', klein = '';
    if (lw.jetzt_trocken) { if (lw.trocken_bis != null) { gross = `bis ${lw.trocken_bis}`; klein = 'Uhr trocken'; } else { gross = `bis ${lw.sonne}`; klein = 'trocken und hell'; } }
    else if (lw.trocken_ab != null) { gross = `ab ${lw.trocken_ab}`; klein = lw.trocken_bis != null ? `bis ${lw.trocken_bis} Uhr trocken` : 'Uhr trocken'; }
    const temp = fen ? fen.t : (st[0] ? st[0][2] : null);
    let inhalt;
    if (this._kompakt) {
      inhalt = `<div class="namen" style="margin-top:6px">${[gross ? `${gross} ${klein}` : '', temp != null ? `${temp}°` : '', fen ? `Fenster ${fen.von}–${fen.bis} Uhr` : ''].filter(Boolean).map(wrEsc).join(' · ')}</div>`;
    } else {
      inhalt = gross ? `<div class="gross"><b>${wrEsc(gross)}<small>${wrEsc(klein)}</small></b>${temp != null ? `<b>${temp}<small>°</small></b>` : ''}</div>` : '';
      if (st.length) inhalt += `<div class="leiste">${st.map(([hh, mm, t, , nass]) => {
        const gut = fen && hh >= fen.von && hh < fen.bis;
        const hoehe = nass ? Math.max(14, Math.min(100, (mm / 1.6) * 100)) : 0;
        return `<div class="sd"><span class="t${gut ? ' g' : ''}">${t}°</span><div class="bar${gut ? ' g' : ''}"><div style="height:${hoehe}%"></div></div><span>${hh}</span></div>`;
      }).join('')}</div>`;
      if (fen) inhalt += `<div class="zeile"><ha-icon icon="mdi:star-four-points-outline" style="color:${WT_LAUF}"></ha-icon><span>Am besten ${fen.von}–${fen.bis} Uhr<small> · ${fen.t}° · Wind ${fen.wind} km/h</small></span></div>`;
      if (!lw.datum) inhalt += `<div class="zeile"><ha-icon icon="mdi:weather-cloudy-clock"></ha-icon><span>Laufwetter folgt</span></div>`;
      const da = d.danach || {};
      if (da.e) {
        const E = (this._einh || {})[da.e] || {};
        const mehr = E.dauer ? `${E.dauer} min` : '';
        inhalt += `<div class="zeile"><ha-icon icon="mdi:dumbbell" style="color:${WT_KRAFT}"></ha-icon><span>${da.wann === 'heute' ? 'Sonst' : 'Morgen'}: ${da.e}${E.name ? ` · ${wrEsc(E.name)}` : ''}${mehr ? `<small> · ${wrEsc(mehr)}</small>` : ''}</span></div>`;
      }
      const m = lw.morgen;
      if (m && m.n && wd !== 0) {
        const tag = wd === 6 ? 'Sonntag' : 'Morgen', besser = lw.heute_ok ? '<small> · heute besser</small>' : '';
        let t, icon = 'mdi:weather-rainy', farbe = '#4fc3f7';
        if (!m.nass) { t = `${tag} trocken`; icon = 'mdi:weather-partly-cloudy'; farbe = '#a7acb4'; }
        else if (m.regen_ab != null) t = `${tag} Regen ab ${m.regen_ab} Uhr${besser}`;
        else if (m.trocken_ab != null) t = `${tag} erst ab ${m.trocken_ab} Uhr trocken${besser}`;
        else t = `${tag} Regen${besser}`;
        inhalt += `<div class="zeile"><ha-icon icon="${icon}" style="color:${farbe}"></ha-icon><span>${t}</span></div>`;
      }
    }
    this.shadowRoot.innerHTML = `<style>${WT_CSS}</style><div class="k lauf${this._kompakt ? ' kompakt' : ''}" id="k">${kopf}${weg}${inhalt}</div>`;
  }
  // Platz im linken Wand-Stapel (vertical-stack mit max-height): reicht er nicht für die volle Karte, kompakt zeigen (nur Kopf + Übungszeile).
  // Gezählt werden alle anderen sichtbaren Karten des Stapels außer der letzten (Einkauf – die darf verschwinden).
  _stapelFinden() {
    let n = this;
    for (let i = 0; i < 60 && n; i++) {
      const p = n.parentNode;
      if (!p) return null;
      if (p instanceof ShadowRoot) { n = p.host; continue; }
      if (p.id === 'root') { const host = p.getRootNode() && p.getRootNode().host; if (host && host.localName === 'hui-vertical-stack-card') return { root: p, ich: n }; }
      n = p;
    }
    return null;
  }
  _stapelBeobachten() {
    const s = this._stapelFinden(); if (!s || typeof ResizeObserver === 'undefined') return;
    this._stapel = s;
    const neu = () => { if (this._ro) this._ro.disconnect(); this._ro = new ResizeObserver(() => this._stapelPruefen()); [...s.root.children].forEach((x) => this._ro.observe(x)); };
    neu();
    this._mo = new MutationObserver(neu); this._mo.observe(s.root, { childList: true });
    this._stapelPruefen();
  }
  _stapelPruefen() {
    const s = this._stapel; if (!s) return;
    const st = getComputedStyle(s.root), max = parseFloat(st.maxHeight);
    if (!(max > 0)) return;
    const gap = parseFloat(st.rowGap) || 10, kinder = [...s.root.children];
    let summe = 0;
    kinder.slice(0, -1).forEach((x) => { if (x !== s.ich && !s.ich.contains(x)) { const hh = x.offsetHeight; if (hh > 0) summe += hh + gap; } });
    const kompakt = summe + (this._vollH[this._aussehen] || (this._aussehen === 'lauf' ? 300 : 235)) > max;
    if (kompakt !== !!this._kompakt) { this._kompakt = kompakt; this._sig = null; this._render(); }
  }

  // ----- gemeinsame Daten der Ansicht -----
  _daten() {
    const h = this._hass, c = this._cfg, e = h.states[c.entity], st = h.states[c.stand];
    const d = (e && e.attributes.daten) || {}, s = (st && st.attributes.daten) || {};
    return { z: e ? e.state : '', d, s, einh: this._einh || {} };
  }
  _skript(name, daten, meldung) {
    const [dom, srv] = name.includes('.') ? name.split('.') : ['script', name];
    return this._hass.callService(dom, srv, daten || {}).then(() => { if (meldung) wtToast(this, meldung); }, (x) => wtToast(this, `Fehler: ${x && x.message ? x.message : x}`));
  }
  _kopfHtml(icon, titel, rechts) { return `<div class="kopf"><ha-icon icon="${icon}"></ha-icon><span class="t">${wrEsc(titel)}</span>${rechts || ''}</div>`; }

  // ----- art: naechste – Umschalter Winter|Sommer, Kacheln A/B/C, Wochen-Soll, Start, Erledigt, Woche aussetzen, Korrektur (lange drücken) -----
  _naechste() {
    const h = this._hass, c = this._cfg, { z, d, s, einh } = this._daten();
    const hm = h.states[c.modus] ? h.states[c.modus].state : 'winter', wm = d.modus || hm;
    const vor = wtVorschlag(z, d), sel = wtWahl.e || vor, E = einh[sel] || {};
    const okWoche = new Set((d.woche || []).filter((w) => w.st === 'ok').map((w) => w.e));
    const heuteErl = d.kraft_heute || [];
    // Start-Knopf: läuft eine Einheit (≤ 4 h)?
    let laeuft = null;
    try { const j = JSON.parse((h.states[c.laeuft] || {}).state || ''); if (j && j.e && Date.now() - new Date(j.t).getTime() < 4 * 3600000) laeuft = j; } catch (x) { /* leer */ }
    const modus = `<span class="mod">${[['winter', 'mdi:snowflake', 'Winter', 'w'], ['sommer', 'mdi:white-balance-sunny', 'Sommer', 's']].map(([m, ic, t, k]) =>
      `<span class="${m === wm ? 'an' : ''}" data-modus="${m}"><ha-icon class="${k}" icon="${ic}"></ha-icon>${t}</span>`).join('')}</span>`;
    let h_ = '';
    if (hm !== wm) h_ += `<div class="mhinw"><ha-icon icon="${hm === 'winter' ? 'mdi:snowflake' : 'mdi:white-balance-sunny'}" style="color:var(${hm === 'winter' ? '--wt-blau' : '--wt-sonne'})"></ha-icon>Diese Woche noch ${wm === 'sommer' ? 'Sommer' : 'Winter'} · ab Montag ${hm === 'sommer' ? 'Sommer' : 'Winter'}</div>`;
    // Status des Tages aus dem Motor
    const nm = (x) => (einh[x] && einh[x].name ? ` · ${wrEsc(einh[x].name)}` : '');
    const da = d.danach || {};
    if (heuteErl.length) h_ += `<div class="status"><ha-icon icon="mdi:check-circle" style="color:#81c995"></ha-icon><span>Heute erledigt: ${heuteErl.map((x) => wrEsc(x) + nm(x)).join(', ')}</span></div>`;
    else if (z === 'L') h_ += `<div class="status"><ha-icon icon="mdi:run" style="color:${WT_LAUF}"></ha-icon><span>Heute dran: Laufen${da.e ? `<small> · Kraft ${da.wann === 'heute' ? 'sonst' : 'morgen'}: ${wrEsc(da.e)}${nm(da.e)}</small>` : ''}</span></div>`;
    else if (z === 'fertig') h_ += `<div class="status"><ha-icon icon="mdi:party-popper" style="color:#81c995"></ha-icon><span>Woche geschafft<small> · alles Weitere zählt als Extra</small></span></div>`;
    else if (z === 'nichts' && !d.pause) h_ += `<div class="status"><ha-icon icon="mdi:sofa-outline" class="sek"></ha-icon><span>Heute kein Vorschlag${d.grund ? `<small> · ${wrEsc(d.grund)}</small>` : ''}${da.e ? `<small> · morgen: ${wrEsc(da.e)}${nm(da.e)}</small>` : ''}</span></div>`;
    else if (d.grund && ['A', 'B', 'C'].includes(z)) h_ += `<div class="status"><ha-icon icon="mdi:information-outline" style="color:#ffb340"></ha-icon><span style="color:var(--warning-color,#ffa726)">${wrEsc(d.grund)}</span></div>`;
    // Kacheln
    const zul = d.zuletzt || {};
    h_ += `<div class="kach">${['A', 'B', 'C'].map((x) => {
      const X = einh[x] || {}, badge = heuteErl.includes(x) || okWoche.has(x) ? '<span class="badge ok">✓</span>' : x === z ? '<span class="badge">HEUTE</span>' : x === vor && z !== 'fertig' ? '<span class="badge">FÄLLIG</span>' : '';
      const zt = zul[x] ? `zuletzt ${wtTagText(zul[x])}` : 'noch nie';
      return `<div class="ka${x === sel ? ' wahl' : ''}" data-e="${x}"><div class="kb"><b>${x}</b>${badge}</div><div class="kn">${wrEsc(X.name || '')}</div><div class="kz">${X.dauer ? `${X.dauer} min · ` : ''}${zt}</div></div>`;
    }).join('')}</div>`;
    // Wochen-Soll
    const ok = (d.woche || []).filter((w) => w.st === 'ok').length, n = (d.woche || []).length || 4;
    const pillen = (d.woche || []).map((w) => wtPilleT(w.st === 'ok' ? w.e || w.s : w.s, w.st)).join('');
    h_ += d.pause
      ? `<div class="aus"><ha-icon icon="mdi:pause-circle-outline"></ha-icon><span>Woche ausgesetzt</span><a id="weiter">wieder aufnehmen</a></div>`
      : `<div class="woche"><span class="wt">Diese Woche <span>· ${ok} von ${n}</span></span>${wtExtra(d.extra || {})}${pillen}</div>`;
    // Knöpfe
    const lz = laeuft && laeuft.e === sel ? new Date(laeuft.t) : null;
    h_ += `<div class="knoepfe">${lz
      ? `<button class="btn zwei" id="start"><ha-icon icon="mdi:timer-play-outline"></ha-icon>${sel} läuft seit ${wrHM(lz)}</button>`
      : `<button class="btn" id="start"><ha-icon icon="mdi:play"></ha-icon>${sel} starten</button>`}</div>`;
    h_ += `<div class="watch"><ha-icon icon="mdi:watch"></ha-icon><span>Watch: <b>Funktionales Krafttraining</b> – zählt als ${sel}${sel === vor ? '' : ' (nach dem Start)'}. Andere Einheit? Oben antippen.` +
      `${(s.eintraege || []).length ? ' Falsch gezählt? Kachel lange drücken.' : ''}</span></div>`;
    h_ += `<div class="links"><span class="l" id="erledigt"><ha-icon icon="mdi:check-circle-outline"></ha-icon>Ohne Watch erledigt</span>${d.pause ? '' : '<span id="aussetzen"><ha-icon icon="mdi:pause-circle-outline"></ha-icon>Woche aussetzen</span>'}</div>`;
    this.shadowRoot.innerHTML = `<style>${WS_CSS}${WT_ANS_CSS}</style>${this._kopfHtml('mdi:dumbbell', 'Nächste Einheit', modus)}<ha-card>${h_}</ha-card>`;

    // Bedienung
    const $ = (id) => this.shadowRoot.getElementById(id);
    this.shadowRoot.querySelectorAll('[data-modus]').forEach((el) => el.addEventListener('click', () => {
      const m = el.dataset.modus;
      if (m === wm && m === hm) return;
      const soll = m === 'sommer' ? '2 Läufe · 1 Kraft (A/B im Wechsel) · 1 Stabi' : 'A · B · C · 1 Lauf am Wochenende';
      wtFrage(`${m === 'sommer' ? 'Sommermodus' : 'Wintermodus'} ab sofort?`, `Die laufende Woche zählt dann mit dem ${m === 'sommer' ? 'Sommer' : 'Winter'}-Soll: ${soll}.`,
        [{ t: 'Umschalten', haupt: 1, f: () => this._skript('training_modus', { modus: m }, `${m === 'sommer' ? 'Sommer' : 'Winter'}modus an`) }, { t: 'Abbrechen' }]);
    }));
    this.shadowRoot.querySelectorAll('.ka').forEach((el) => {
      const x = el.dataset.e;
      let tm = 0, lang = false;
      const ab = () => { clearTimeout(tm); tm = 0; };
      el.addEventListener('pointerdown', () => { lang = false; ab(); tm = setTimeout(() => { lang = true; tm = 0; this._korrektur(x); }, 650); });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => el.addEventListener(ev, ab));
      el.addEventListener('contextmenu', (ev) => ev.preventDefault());
      el.addEventListener('click', () => { if (lang) { lang = false; return; } wtWaehlen(x === vor ? '' : x); });
    });
    $('start').addEventListener('click', () => this._skript('training_starten', { einheit: sel }, lz ? `${sel}: Start erneuert` : `${sel} gestartet – das Watch-Training zählt als ${sel}`));
    $('erledigt').addEventListener('click', () => wtFrage(`${sel} als erledigt eintragen?`,
      'Für heute, ohne Watch-Aktivität. Kommt sie später doch noch, wird sie an diesen Eintrag gehängt statt doppelt gezählt.',
      [{ t: `${sel} eintragen`, haupt: 1, f: () => this._skript('training_erledigt', { einheit: sel }, `${sel} eingetragen`) }, { t: 'Abbrechen' }]));
    if ($('aussetzen')) $('aussetzen').addEventListener('click', () => wtFrage('Woche aussetzen?',
      'Krank oder Urlaub: diese Woche kein Soll, keine Erinnerung, kein Vorschlag auf der Wand. Was du trotzdem machst, zählt. Rückgängig mit „wieder aufnehmen“.',
      [{ t: 'Woche aussetzen', haupt: 1, f: () => this._skript('training_woche_aussetzen', { aus: true }, 'Woche ausgesetzt') }, { t: 'Abbrechen' }]));
    if ($('weiter')) $('weiter').addEventListener('click', () => wtFrage('Woche wieder aufnehmen?', 'Das Soll der Woche gilt wieder, die Wand schlägt wieder vor.',
      [{ t: 'Wieder aufnehmen', haupt: 1, f: () => this._skript('training_woche_aussetzen', { aus: false }, 'Woche wieder aufgenommen') }, { t: 'Abbrechen' }]));
  }
  // Lange drücken auf eine Kachel: den letzten Eintrag dieser Einheit korrigieren (mit sid gezielt; ohne sid nur, wenn er der letzte überhaupt ist)
  _korrektur(x) {
    const { s, einh } = this._daten(), ein = s.eintraege || [];
    let i = -1;
    ein.forEach((q, k) => { if (q.e === x && (i < 0 || q.d >= ein[i].d)) i = k; });
    if (i < 0) { wtToast(this, `${x} ist noch nicht eingetragen`); return; }
    const q = ein[i], letzter = i === ein.length - 1;
    if (!q.sid && !letzter) { wtToast(this, 'Ohne Watch-Aktivität lässt sich nur der letzte Eintrag ändern'); return; }
    const k = (e) => ({ t: e === 'keine' ? 'Zählt nicht' : `War eigentlich ${e}${einh[e] && einh[e].name ? ` · ${einh[e].name}` : ''}`, warn: e === 'keine',
      f: () => this._skript('training_korrigieren', Object.assign({ einheit: e }, q.sid ? { sid: String(q.sid) } : {}), e === 'keine' ? `${x} vom ${wtTagText(q.d)} zählt nicht` : `${wtTagText(q.d)}: ${x} → ${e}`) });
    wtFrage(`${x} vom ${wtTagText(q.d)} korrigieren`, [WT_QUELLE[q.q] || q.q, q.min ? `${Math.round(q.min)} min` : ''].filter(Boolean).join(', '),
      [...['A', 'B', 'C'].filter((e) => e !== x).map(k), k('keine'), { t: 'Abbrechen' }]);
  }

  // ----- art: einheit – Aufwärmen mit durchlaufendem Timer, Übungskarten mit Figur (Paare in B), Timer-Ring bei Halteübungen, Pausenleiste -----
  _einheit() {
    const { z, d, einh } = this._daten();
    const vor = wtVorschlag(z, d), sel = wtWahl.e || vor, E = einh[sel];
    if (!E) { this.shadowRoot.innerHTML = `<style>${WS_CSS}</style><ha-card><div class="leer">Keine Einheiten konfiguriert (einheiten)</div></ha-card>`; return; }
    const heute = sel === z ? 'heute dran · ' : '';
    let blocks = [];
    const auf = E.aufwaermen || [];
    if (auf.length) {
      const sum = auf.reduce((x, u) => x + (+u.timer || 30), 0), zu = WT_UHR.zu && WT_UHR.zu[sel];
      blocks.push(`<ha-card class="auf${zu ? ' zu' : ''}" id="auf"><div class="ak" id="ak"><b>Aufwärmen</b><span>≈ ${Math.max(1, Math.round(sum / 60))} min · ohne Pause</span><ha-icon icon="${zu ? 'mdi:chevron-down' : 'mdi:chevron-up'}"></ha-icon></div>` +
        `<div class="al">${auf.map((u, i) => `<div class="ar" data-i="${i}"><span>${wrEsc(u.n)}</span><span>${wrEsc(u.dosis || '')}</span></div>`).join('')}</div>${wtUhrHtml(`auf:${sel}`, wtMs(wtSchritte(auf[0])[0].s))}</ha-card>`);
    }
    const ueb = E.uebungen || [], paar = {};
    (E.paare || []).forEach((p) => p.forEach((n) => { paar[n] = p; }));
    const karte = (u, i) => {
      const fig = wtFigur(u.id, { groesse: 92 });
      return `<ha-card class="ueb"><div class="ug">${fig ? `<div class="fb">${fig}</div>` : `<div class="fb leer">${i + 1}</div>`}<div class="ut">` +
        `<div class="un"><span class="nr">${i + 1}</span><b>${wrEsc(u.n)}</b></div><div class="ud">${wrEsc(u.dosis || '')}${u.last ? `<span class="sek"> · ${wrEsc(u.last)}</span>` : ''}</div>` +
        `${(u.tipps || []).length ? `<ul class="tp">${u.tipps.map((t) => `<li>${wrEsc(t)}</li>`).join('')}</ul>` : ''}</div></div>` +
        `${u.steigern ? `<div class="st"><ha-icon icon="mdi:trending-up"></ha-icon><span>Steigern: ${wrEsc(u.steigern)}</span></div>` : ''}` +
        `${u.timer ? wtUhrHtml(`ueb:${sel}:${i}`, wtMs(wtSchritte(u)[0].s)) : ''}</ha-card>`;
    };
    for (let i = 0; i < ueb.length; i++) {
      const p = paar[i + 1];
      if (p && p[0] === i + 1) {
        const glied = p.map((n) => ueb[n - 1] ? karte(ueb[n - 1], n - 1) : '').join('');
        blocks.push(`<div class="paar"><div class="pk"><ha-icon icon="mdi:swap-vertical"></ha-icon>${p.join(' ↔ ')} im Wechsel · die andere Übung ist die Pause</div>${glied}</div>`);
        i += p.length - 1;
      } else if (!p) blocks.push(karte(ueb[i], i));
    }
    const andere = ['A', 'B', 'C'].filter((x) => x !== sel && einh[x]);
    if (andere.length && this._cfg.andere !== false) {
      blocks.push(`<ha-card class="ueb"><div class="ak" style="cursor:default"><b>Die anderen Einheiten</b></div>${andere.map((x) =>
        `<div class="and" data-e="${x}"><b>${x}</b><div>${wrEsc(einh[x].name || '')}<small>${wrEsc(wtNamen(einh[x]).slice(0, 4).join(' · '))}${wtNamen(einh[x]).length > 4 ? ' …' : ''}</small></div><ha-icon icon="mdi:chevron-right"></ha-icon></div>`).join('')}</ha-card>`);
    }
    const pausen = (E.pausen || [45, 60, 90]).map((p) => `<span class="pw" data-p="${p}">${wtMs(p)}</span>`).join('');
    this.shadowRoot.innerHTML = `<style>${WS_CSS}${WT_ANS_CSS}</style>${this._kopfHtml(E.icon || 'mdi:dumbbell', `${sel} · ${E.name || ''}`, `<span class="r">${heute}≈ ${E.dauer || '?'} min</span>`)}` +
      `${E.hinweis || E.runden ? `<div class="hinweis">${wrEsc(E.hinweis || E.runden)}</div>` : ''}` +
      `<div class="sp${this.clientWidth >= 640 ? ' zwei' : ''}" id="sp">${blocks.join('')}</div>` +
      `<div class="pausen" id="pausen"><span class="pt"><ha-icon icon="mdi:timer-outline"></ha-icon><span id="pzeit">Pause</span></span>${pausen}</div>`;

    // Timer-Definitionen dieser Einheit (Schritte aus der Konfiguration)
    this._uhrDef = {};
    if (auf.length) this._uhrDef[`auf:${sel}`] = () => ({ art: 'auf', n: auf.length, schritte: auf.flatMap((u, i) => wtSchritte(u).map((x) => Object.assign({ u: i }, x))) });
    ueb.forEach((u, i) => { if (u.timer) this._uhrDef[`ueb:${sel}:${i}`] = () => ({ art: 'ueb', saetze: +E.saetze || 3, schritte: wtSchritte(u) }); });
    const R = this.shadowRoot;
    R.querySelectorAll('.uhr').forEach((el) => {
      const key = el.dataset.uhr;
      el.addEventListener('click', (ev) => {
        wtTonAn();
        if (ev.target.closest('.neu')) { delete WT_UHR.t[key]; wtUhrTick(); this._uhrZeigen(); return; }
        if (!WT_UHR.t[key]) wtUhrNeu(key, this._uhrDef[key]());
        wtUhrStartStop(key);
        this._uhrZeigen();
      });
    });
    R.querySelectorAll('.ar').forEach((el) => el.addEventListener('click', () => {
      const key = `auf:${sel}`, i = +el.dataset.i;
      wtTonAn();
      if (!WT_UHR.t[key]) wtUhrNeu(key, this._uhrDef[key]());
      const t = WT_UHR.t[key], k = t.schritte.findIndex((x) => x.u === i);
      wtUhrSpringen(key, k);
      this._uhrZeigen();
    }));
    const ak = R.getElementById('ak');
    if (ak) ak.addEventListener('click', () => { WT_UHR.zu = WT_UHR.zu || {}; WT_UHR.zu[sel] = !WT_UHR.zu[sel]; this._sig = null; this._render(); });
    R.querySelectorAll('.and').forEach((el) => el.addEventListener('click', () => { wtWaehlen(el.dataset.e === vor ? '' : el.dataset.e); this.scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
    R.querySelectorAll('.pw').forEach((el) => el.addEventListener('click', () => {
      wtTonAn();
      const p = +el.dataset.p, t = WT_UHR.t.pause;
      if (t && t.dauer === p) delete WT_UHR.t.pause;
      else { wtUhrNeu('pause', { art: 'pause', dauer: p, schritte: [{ s: p }] }); wtUhrStartStop('pause'); }
      wtUhrTick(); this._uhrZeigen();
    }));
    this._uhrZeigen();
  }
  // Timer-Anzeigen dieser Karte aktualisieren (vom Takt in wtUhrTick und nach jedem Render)
  _uhrZeigen() {
    const R = this.shadowRoot; if (!R || this._cfg.art !== 'einheit') return;
    const jetzt = Date.now(), tonHinweis = !wtTonOk() ? 'Kein Ton möglich – der Ring blinkt in den letzten 3 s' : wtIos ? 'Kein Ton? Stummschalter am iPhone – der Ring blinkt in den letzten 3 s' : '';
    R.querySelectorAll('.uhr').forEach((el) => {
      const key = el.dataset.uhr, t = WT_UHR.t[key], def = this._uhrDef && this._uhrDef[key] && this._uhrDef[key]();
      if (!def) return;
      const sch = t ? t.schritte[t.i] : def.schritte[0];
      const rest = t ? (t.ziel ? Math.max(0, (t.ziel - jetzt) / 1000) : t.rest) : sch.s;
      const laeuft = !!(t && t.ziel), fertig = !!(t && t.fertig);
      el.querySelector('.zeit').textContent = fertig ? '✓' : wtMs(rest);
      let info;
      if (def.art === 'auf') info = fertig ? ' Aufwärmen fertig' : ` / ${wtMs(sch.s)}${sch.seite ? ` · ${sch.seite}` : ''} · ${(sch.u || 0) + 1}/${def.n}`;
      else { const satz = t ? t.satz : 0; info = fertig ? ` alle ${def.saetze} Sätze` : ` / ${wtMs(sch.s)}${sch.seite ? ` · ${sch.seite}` : ''} · Satz ${Math.min(satz + 1, def.saetze)}/${def.saetze}`; }
      el.querySelector('.info').textContent = info;
      el.querySelector('.ton').textContent = laeuft ? tonHinweis : '';
      el.querySelector('.rv').setAttribute('stroke-dashoffset', (WT_RING_U * (fertig ? 0 : 1 - rest / sch.s)).toFixed(1));
      el.querySelector('.play ha-icon').setAttribute('icon', laeuft ? 'mdi:pause-circle' : fertig ? 'mdi:replay' : 'mdi:play-circle');
      el.classList.toggle('blink', laeuft && rest <= 3);
      el.classList.toggle('still', !t);
      if (def.art === 'auf') {
        const cur = t ? (fertig ? def.n : sch.u) : -1;
        el.parentNode.querySelectorAll('.ar').forEach((r) => { const i = +r.dataset.i; r.classList.toggle('done', i < cur); r.classList.toggle('jetzt', i === cur && !!t); });
      }
    });
    const p = WT_UHR.t.pause, pz = R.getElementById('pzeit'), bar = R.getElementById('pausen');
    if (pz) {
      const rest = p ? Math.max(0, (p.ziel - jetzt) / 1000) : 0;
      const vorbei = !p && WT_UHR.pauseEnde && jetzt - WT_UHR.pauseEnde < 5000;
      pz.innerHTML = p ? `<b>${wtMs(rest)}</b> / ${wtMs(p.dauer)}` : vorbei ? '<b>Weiter!</b>' : 'Pause';
      bar.classList.toggle('blink', !!p && rest <= 3);
      R.querySelectorAll('.pw').forEach((el) => el.classList.toggle('an', !!p && +el.dataset.p === p.dauer));
      if (vorbei) { clearTimeout(this._weiter); this._weiter = setTimeout(() => this._uhrZeigen(), 5100); }
    }
  }

  // ----- art: saison – Soll/Ist je ISO-Woche (Kraft/Stabi + Modus/Pause aus sensor.training_stand, Läufe aus strava_stats.liste) -----
  _saison() {
    const h = this._hass, c = this._cfg, { d, s } = this._daten();
    const liste = ((h.states[c.strava] || {}).attributes || {}).liste || [];
    const heute = wsHeute(), kwJetzt = wtKw(heute), mo0 = wtMontag(heute), N = Math.max(1, +c.wochen || 8);
    const wo = {}; (s.wochen || []).forEach((w) => { wo[w.kw] = w; });
    const ein = {}; (s.eintraege || []).forEach((q) => { if (['A', 'B', 'C'].includes(q.e)) { const k = wtKw(wsTag(q.d)); (ein[k] = ein[k] || []).push(q.e); } });
    const lauf = {}; liste.forEach((x) => { if (x && x[1] === 'running') { const k = wtKw(wsTag(String(x[0]).slice(0, 10))); lauf[k] = (lauf[k] || 0) + 1; } });
    const hm = h.states[c.modus] ? h.states[c.modus].state : 'winter';
    let zeilen = '', mVor = null;
    for (let i = N - 1; i >= 0; i--) {
      const mo = mo0 - 7 * i, k = wtKw(mo), jetzt = k === kwJetzt;
      const m = (jetzt && d.modus) || (wo[k] && wo[k].m) || hm, p = jetzt ? !!d.pause : !!(wo[k] && wo[k].p);
      const r = jetzt && d.woche ? { woche: d.woche, extra: d.extra || {} } : wtSollIst(m, ein[k] || [], lauf[k] || 0);
      if (mVor && m !== mVor) {
        const f = m === 'winter' ? 'var(--wt-blau)' : 'var(--wt-sonne)';
        zeilen += `<div class="trenn" style="color:${f}"><ha-icon icon="${m === 'winter' ? 'mdi:snowflake' : 'mdi:white-balance-sunny'}"></ha-icon>${m === 'winter' ? 'Winter' : 'Sommer'} seit Mo ${wsKurz(mo)}<i></i></div>`;
      }
      mVor = m;
      const ok = r.woche.filter((w) => w.st === 'ok');
      const pl = p ? `<span class="pause">Pause</span>${ok.map((w) => wtPilleT(w.e || w.s, 'ok')).join('')}` : r.woche.map((w) => wtPilleT(w.st === 'ok' ? w.e || w.s : w.s, w.st)).join('');
      zeilen += `<div class="sz${jetzt ? ' jetzt' : ''}"><span class="kw">KW ${+k.slice(5)}</span><ha-icon icon="${m === 'winter' ? 'mdi:snowflake' : 'mdi:white-balance-sunny'}" style="color:var(${m === 'winter' ? '--wt-blau' : '--wt-sonne'})"></ha-icon>` +
        `<span class="pls">${pl}</span><span class="x">${wtExtra(r.extra)}</span><span class="n">${p ? '–' : `${ok.length}/${r.woche.length}`}</span></div>`;
    }
    const regeln = `<div class="regeln"><ha-icon icon="mdi:white-balance-sunny" style="color:var(--wt-sonne)"></ha-icon>Sommer: 2 Läufe · 1 Kraft (A/B im Wechsel) · 1 Stabi<br>` +
      `<ha-icon icon="mdi:snowflake" style="color:var(--wt-blau)"></ha-icon>Winter: A · B · C · 1 Lauf am Wochenende</div>`;
    this.shadowRoot.innerHTML = `<style>${WS_CSS}${WT_ANS_CSS}</style>${this._kopfHtml('mdi:calendar-sync', 'Saison', '<span class="r">Soll je Woche</span>')}<ha-card>${zeilen}${regeln}</ha-card>`;
  }
}
if (!customElements.get('wand-training')) customElements.define('wand-training', WandTraining);
if (!window.customCards.some((c) => c.type === 'wand-training')) window.customCards.push({ type: 'wand-training', name: 'Wand-Training', description: 'Heute-Karte (Wand) und Ansicht Training (naechste, einheit, saison)' });
