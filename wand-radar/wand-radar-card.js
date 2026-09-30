// wand-radar 1.6 (Routenmodus, zoomt stufenlos auf die Strecke) – Radar-Hintergrund der Wand-Ansicht aus dem vorgerechneten DWD-Radar (HA-Add-on „Wand-Radar“).
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
// Konfiguration: type: custom:wand-radar, base: /local/wand-radar, max_seconds: 60, stale_min: 20
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

class WandRadar extends HTMLElement {
  setConfig(c) { this._cfg = Object.assign({ base: '/local/wand-radar', max_seconds: 60, stale_min: 20 }, c || {}); }
  set hass(h) {
    this._hass = h;
    const sig = WR_ROUTE_STATES.map((e) => (h && h.states[e] ? h.states[e].state : '')).join('|');
    if (sig !== this._rsig) { this._rsig = sig; if (this._$) this._syncRoute(); }
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
      this._$('swRoute').addEventListener('click', (e) => { e.stopPropagation(); this._selectView('route'); });
      this._$('swRadar').addEventListener('click', (e) => { e.stopPropagation(); this._selectView('radar'); });
      if (window.ResizeObserver) {
        new ResizeObserver(() => this._drawStrip()).observe(tr);
        let rt = 0, rw = 0;
        new ResizeObserver(() => { const w = this._root.clientWidth; if (w === rw) return; rw = w; clearTimeout(rt); rt = setTimeout(() => { if (this._routeOn) this._drawRoute(); }, 300); }).observe(this._root);
      }
      this._state = 'ruhe';
    }
    window.__wandActive = (window.__wandActive || 0) + 1;
    wandSeiten(false);
    this._loadMeta();
    this._loadRoute();
    this._applyView();
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
      .then((j) => { this._route = j; this._syncRoute(); })
      .catch(() => { /* keine Route-Datei (ältere App): Radar wie bisher */ });
  }
  _st(e) { const h = this._hass; return h && h.states[e] ? h.states[e].state : ''; }
  _syncRoute() {
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
    const war = this._routeOn;
    this._routeOn = ok;
    if (ok !== war) { this._rsel = 'route'; clearTimeout(this._rauto); }      // Route neu da: „Route“ vorgewählt
    const sig = ok ? [r.t, r.schluessel, this._rsig].join('#') : '';
    if (ok && sig !== this._drawSig) { this._drawSig = sig; this._drawRoute(); }
    if (!ok) this._drawSig = '';
    this._applyView();
  }
  _applyView() {
    const on = !!this._routeOn, view = on && this._rsel === 'route', s = document.documentElement.style;
    this._root.classList.toggle('hasroute', on);
    this._root.classList.toggle('rview', view);
    s.setProperty('--wand-mitte', view ? '0' : '1');                // Wetterkarte in der Mitte blendet aus, solange die Route zu sehen ist
    this._$('swRoute').classList.toggle('on', view);
    this._$('swRadar').classList.toggle('on', on && !view);
  }
  _selectView(v) {
    if (!this._routeOn || v === this._rsel) return;
    if (v === 'route') { this._toRoute(); return; }
    this._rsel = 'radar'; this._applyView(); this._touch();
  }
  _toRoute() {
    this._rsel = 'route';
    if (this._state !== 'ruhe') this._stop();
    this._applyView();
  }
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
    if (this._routeOn && this._rsel === 'radar') this._rauto = setTimeout(() => this._toRoute(), (this._cfg.max_seconds || 60) * 1000);
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
