// wand-radar 1.10 (Routen- und Trainingsmodus, Elemente für die Ansichten „Sport“ und „Training“) – Radar-Hintergrund der Wand-Ansicht aus dem vorgerechneten DWD-Radar (HA-Add-on „Wand-Radar“).
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
// - Training (seit 1.10): drittes Element custom:wand-training (art: heute = Heute-Karte der Wand mit Strichfigur, art: plan = Übungsliste);
//   liest sensor.training_heute, die Übungen (einheiten) stehen in der Kartenkonfiguration der Ansicht „training“.
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
// art: heute (Wand, linker Stapel: „Heute dran: A · Beine“ mit Mini-Figur) · plan (Unteransicht „Training“: Übungsliste je Einheit, bis die
// Ansicht ausgebaut ist). Daten: sensor.training_heute (Vorschlag-Motor in HA). Die Übungen stehen nur an EINER Stelle: in der Kartenkonfiguration
// (`einheiten`) der Ansicht „training“; die Wand-Karte liest sie per Websocket (lovelace/config) von dort. Im Code stecken nur die Figuren.
// Strichfiguren: Seitenansicht, Blick nach rechts, Boden y = 100; je Übung zwei Posen (a = Start, b = Umkehrpunkt), Animation a → b → a per SVG-SMIL.
// Posen über Gelenkpunkte (Hüfte, Rumpfrichtung, Fuß, Hand), Knie/Ellbogen rechnet wtIk() (aus plaene/training/figuren.mjs übernommen).
const WT_KRAFT = '#ce93d8', WT_LAUF = '#fc5200';
const WT_L = { ober: 23, unter: 23, rumpf: 30, kopf: 39, oa: 14, ua: 13, fuss: 7 };
const wtAdd = (p, v, f = 1) => [p[0] + v[0] * f, p[1] + v[1] * f];
const wtUnit = (v) => { const d = Math.hypot(v[0], v[1]) || 1; return [v[0] / d, v[1] / d]; };
const wtGrad = (w) => (w * Math.PI) / 180;
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
  const sh = wtAdd(hip, dir, WT_L.rumpf), kopf = wtAdd(hip, dir, WT_L.kopf);
  const beine = p.beine.map((b) => {
    const knie = wtIk(hip, b.fuss, WT_L.ober, WT_L.unter, b.knick ?? -1);
    const zeh = b.zeh || wtAdd(b.fuss, [Math.cos(wtGrad(b.zw || 0)), Math.sin(wtGrad(b.zw || 0))], WT_L.fuss);
    return [hip, knie, b.fuss, zeh];
  });
  const arme = p.arme.map((a) => [sh, wtIk(sh, a.hand, WT_L.oa, WT_L.ua, a.knick ?? 1), a.hand]);
  return { kopf, beine, arme, rumpf: [hip, sh], hanteln: p.arme.filter((a) => a.hantel).map((a) => a.hand), hantelHuefte: p.hantelHuefte ? hip : null };
}
const wtD = (pts) => pts.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join(' ');
const wtAnim = (attr, a, b, dur) => (a === b ? '' :
  `<animate attributeName="${attr}" values="${a};${b};${a}" dur="${dur}s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/>`);
const WT_STUFE_FARBE = 'fill="#2a2d33" stroke="#5f6368" stroke-width="1.2"';
const WT_COUCH = (x0, x1, y) => `<rect x="${x0}" y="${y - 20}" width="8" height="${120 - y}" rx="3" ${WT_STUFE_FARBE}/><rect x="${x0}" y="${y}" width="${x1 - x0}" height="${100 - y - 4}" rx="3" fill="#30333a" stroke="#5f6368" stroke-width="1.2"/><line x1="${x0 + 3}" y1="96" x2="${x0 + 3}" y2="100" stroke="#5f6368" stroke-width="2"/><line x1="${x1 - 3}" y1="96" x2="${x1 - 3}" y2="100" stroke="#5f6368" stroke-width="2"/>`;
const WT_TREPPE = (stufen, richtung = 'links') => `<path d="${richtung === 'links'
  ? `M${stufen[0][1]} 100 ` + stufen.map(([y, , x0]) => `V${y} H${x0}`).join(' ') + ' V100 Z'
  : `M${stufen[0][1]} 100 ` + stufen.map(([y, , x1]) => `V${y} H${x1}`).join(' ') + ' V100 Z'}" ${WT_STUFE_FARBE} stroke-linejoin="round"/>`;
const WT_GELAENDER = (x0, y0, x1, y1) => `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="#9aa0a6" stroke-width="2.2" stroke-linecap="round"/>`;
const WT_WAND = (x) => `<rect x="${x - 6}" y="-12" width="6" height="112.5" fill="#24272c"/><line x1="${x}" y1="-12" x2="${x}" y2="100.5" stroke="#5f6368" stroke-width="1.5"/>`;
// Posen je Übungs-ID (Phase 4 ergänzt B, C und das Aufwärmen)
const WT_POSEN = {
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
  wallsit: {
    dur: 2.4,
    props: WT_WAND(18),
    a: { hip: [26, 70], t: -2, beine: [{ fuss: [50, 92], zeh: [56, 98] }, { fuss: [48, 92], zeh: [54, 98] }], arme: [{ hand: [42, 67] }, { hand: [40, 67] }] },
    b: { hip: [26, 70], t: -2, beine: [{ fuss: [50, 90], zeh: [56, 98] }, { fuss: [48, 90], zeh: [54, 98] }], arme: [{ hand: [42, 67] }, { hand: [40, 67] }] },
  },
  waden: {
    dur: 2.6,
    props: WT_TREPPE([[86, 55, 76], [72, 76, 106]], 'rechts') + WT_GELAENDER(64, 38, 106, 16),
    a: { hip: [52, 43], t: 0, beine: [{ fuss: [51, 88.5], zeh: [58, 86] }, { fuss: [38, 68], knick: -1 }], arme: [{ hand: [84, 27] }, { hand: [55, 69], hantel: 1 }] },
    b: { hip: [53, 33], t: 0, beine: [{ fuss: [53, 78], zeh: [58, 86] }, { fuss: [39, 58], knick: -1 }], arme: [{ hand: [84, 27] }, { hand: [56, 59], hantel: 1 }] },
  },
};
// Figur als SVG-Text: wtFigur(id, { groesse, farbe, still: 'a'|'b' }); leer, wenn es für die Übung (noch) keine Posen gibt
function wtFigur(id, o = {}) {
  const u = WT_POSEN[id]; if (!u) return '';
  const farbe = o.farbe || WT_KRAFT, fern = o.fern || '#7d5f86', dur = u.dur || 3;
  const A = wtGelenke(u.a), B = wtGelenke(o.still ? (o.still === 'b' ? u.b : u.a) : u.b);
  const P = o.still === 'b' ? B : A;
  const linie = (pa, pb, c, w) => `<path d="${wtD(pa)}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${o.still ? '' : wtAnim('d', wtD(pa), wtD(pb), dur)}</path>`;
  const kreis = (pa, pb, r, attrs) => `<circle cx="${pa[0].toFixed(1)}" cy="${pa[1].toFixed(1)}" r="${r}" ${attrs}>${o.still ? '' : wtAnim('cx', pa[0].toFixed(1), pb[0].toFixed(1), dur) + wtAnim('cy', pa[1].toFixed(1), pb[1].toFixed(1), dur)}</circle>`;
  const hantel = (pa, pb) => kreis(pa, pb, 3.4, 'fill="#3a3d44" stroke="#9aa0a6" stroke-width="1.4"');
  const g = (X, Y) => [
    linie(X.beine[1], Y.beine[1], fern, 4.2), linie(X.arme[1], Y.arme[1], fern, 3.6),
    linie(X.rumpf, Y.rumpf, farbe, 5), kreis(X.kopf, Y.kopf, 6.2, `fill="${farbe}"`),
    linie(X.beine[0], Y.beine[0], farbe, 4.6), linie(X.arme[0], Y.arme[0], farbe, 4),
    ...X.hanteln.map((h, k) => hantel(h, Y.hanteln[k])),
    X.hantelHuefte ? hantel(wtAdd(X.hantelHuefte, [0, -5]), wtAdd(Y.hantelHuefte, [0, -5])) : '',
  ].join('');
  const s = o.groesse || 96;
  return `<svg viewBox="-6 -14 112 118" width="${s}" height="${(s * 118 / 112).toFixed(1)}" style="display:block;overflow:visible">` +
    `<line x1="-4" y1="100.5" x2="104" y2="100.5" stroke="#3c4043" stroke-width="1.5"/>${u.props || ''}${o.still ? g(P, P) : g(A, B)}</svg>`;
}
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
`;
// Pille für das Wochen-Soll (Status ok | faellig | offen), Farbe Lauf orange, sonst Kraft-Lila
const wtPille = (t, st) => {
  const f = t === 'L' ? WT_LAUF : WT_KRAFT;
  const s = st === 'ok' ? `background:${f};color:#111` : st === 'faellig' ? `border:1.5px solid ${f};color:${f};background:none` : '';
  return `<span class="pl" style="${s}">${wrEsc(t)}</span>`;
};
class WandTraining extends HTMLElement {
  setConfig(c) {
    if (!c || !c.art) throw new Error('art fehlt (heute, plan)');
    this._cfg = Object.assign({ entity: 'sensor.training_heute', test: 'input_boolean.wand_training_heute_test', ansicht: 'training', ziel: '', weg: 'script.training_heute_nicht', animation: 60 }, c);
    this._sig = null;
  }
  getCardSize() { return this._cfg && this._cfg.art === 'plan' ? 8 : 3; }
  getGridOptions() { return { columns: 12, min_columns: 6 }; }
  set hass(h) {
    this._hass = h;
    const c = this._cfg, e = h && h.states[c.entity], t = h && h.states[c.test];
    if (c.art === 'heute' && !this._einh && !this._laedt) {
      this._laedt = true;
      const dash = c.dashboard || location.pathname.split('/')[1] || 'home-new';
      if (!c.ziel) c.ziel = `/${dash}/${c.ansicht}`;
      const laden = () => wtEinheitenLaden(this._hass, dash, c.ansicht).then((r) => {
        if (r) { this._einh = r; this._sig = null; this._render(); } else this._nochmal = setTimeout(laden, 65000);   // ohne Einheiten: Karte zeigt nur Kopf
      });
      laden();
    }
    const sig = [e ? e.state : '', e ? e.last_updated : '', t ? t.state : '', !!this._einh, this._kompakt].join('|');
    if (sig === this._sig) return;
    this._sig = sig;
    this._render();
  }
  connectedCallback() { if (this._cfg && this._cfg.art === 'heute') requestAnimationFrame(() => this._stapelBeobachten()); }
  disconnectedCallback() {
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this._mo) { this._mo.disconnect(); this._mo = null; }
    clearTimeout(this._still); clearTimeout(this._nochmal);
    if (!this._einh) this._laedt = false;
  }
  _render() {
    if (!this._cfg || !this._hass) return;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    if (this._cfg.art === 'plan') { this._plan(); return; }
    if (this._cfg.art !== 'heute') { this.shadowRoot.innerHTML = `<div>Unbekannte Art „${wrEsc(this._cfg.art)}“</div>`; return; }
    this._heute();
  }

  // ----- art: heute (Wand) -----
  _heute() {
    const h = this._hass, c = this._cfg, e = h.states[c.entity], d = (e && e.attributes.daten) || {};
    const test = h.states[c.test] && h.states[c.test].state === 'on';
    const z = e ? e.state : '';
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
    const k = this.shadowRoot.getElementById('k');
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
    if (!this._kompakt) requestAnimationFrame(() => { const hh = this.offsetHeight; if (hh > 60) this._vollH = hh; this._stapelPruefen(); });
    else requestAnimationFrame(() => this._stapelPruefen());
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
    const kompakt = summe + (this._vollH || 235) > max;
    if (kompakt !== !!this._kompakt) { this._kompakt = kompakt; this._sig = null; this._render(); }
  }

  // ----- art: plan (Unteransicht, vorläufig bis Phase 4) -----
  _plan() {
    const c = this._cfg, ein = c.einheiten || {}, e = this._hass.states[c.entity], z = e ? e.state : '';
    const html = Object.entries(ein).map(([k, E]) => {
      const auf = (E.aufwaermen || []).length ? `<div class="pa">Aufwärmen · ${(E.aufwaermen || []).map((u) => `${wrEsc(u.n)} <span>${wrEsc(u.dosis || '')}</span>`).join(' · ')}</div>` : '';
      const paar = {}; (E.paare || []).forEach((p) => p.forEach((n) => { paar[n] = p.filter((m) => m !== n); }));
      const ueb = (E.uebungen || []).map((u, i) => {
        const fig = wtFigur(u.id, { groesse: 64 });
        const zus = paar[i + 1] ? ` · im Wechsel mit ${paar[i + 1].join(', ')}` : '';
        return `<div class="pu">${fig ? `<div class="pf">${fig}</div>` : `<div class="pf pn">${i + 1}</div>`}<div><b>${i + 1}. ${wrEsc(u.n)}</b><div class="pd">${wrEsc([u.dosis, u.last].filter(Boolean).join(' · '))}${zus}</div>` +
          `${(u.tipps || []).length ? `<div class="pt">${u.tipps.map(wrEsc).join(' · ')}</div>` : ''}${u.steigern ? `<div class="pt">Steigern: ${wrEsc(u.steigern)}</div>` : ''}</div></div>`;
      }).join('');
      return `<div class="kopf"><ha-icon icon="${E.icon || 'mdi:dumbbell'}"></ha-icon><span class="t">${k} · ${wrEsc(E.name || '')}</span><span class="r">${z === k ? 'heute dran · ' : ''}≈ ${E.dauer || '?'} min</span></div>` +
        `<ha-card>${E.runden ? `<div class="pa">${wrEsc(E.runden)}</div>` : ''}${auf}${ueb}</ha-card>`;
    }).join('<div style="height:16px"></div>');
    this.shadowRoot.innerHTML = `<style>${WS_CSS}
      .pa { font-size: 13px; color: var(--secondary-text-color); margin-bottom: 12px; line-height: 1.5; }
      .pa span { opacity: .8; }
      .pu { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 12px; align-items: start; }
      .pu + .pu { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--divider-color, rgba(127,127,127,.2)); }
      .pu b { font-size: 15px; }
      .pf { border-radius: 10px; background: #1b1d20; padding: 4px 0; display: flex; justify-content: center; }
      .pn { height: 56px; align-items: center; font-size: 20px; font-weight: 700; color: ${WT_KRAFT}; }
      .pd { font-size: 13px; margin-top: 2px; }
      .pt { font-size: 12.5px; color: var(--secondary-text-color); margin-top: 4px; line-height: 1.4; }
    </style>${html || '<ha-card><div class="leer">Keine Einheiten konfiguriert (einheiten)</div></ha-card>'}`;
  }
}
if (!customElements.get('wand-training')) customElements.define('wand-training', WandTraining);
if (!window.customCards.some((c) => c.type === 'wand-training')) window.customCards.push({ type: 'wand-training', name: 'Wand-Training', description: 'Heute-Karte (Wand) und Übungen der Ansicht Training' });
