'use strict';
// BTCUSDT footprint viewer: vanilla JS + Canvas 2D. All timestamps are UTC epoch ms.

const DAY = 86400000;
const MONO = '"JetBrains Mono", "Cascadia Mono", Consolas, monospace';
// Canvas palettes; the HTML parts use the matching CSS variables (style.css, [data-theme]).
const THEMES = {
  dark: {
    bg: '#0e1015', grid: '#1a1e27', axis: '#7a8292', text: '#c9ced8', dim: '#5d6575',
    green: [38, 166, 91], red: [224, 72, 72], blue: [76, 141, 255], neutral: [138, 143, 153],
    cellText: '#eef0f4', fillMax: 0.85, selFill: 'rgba(255,255,255,0.05)', selStroke: 'rgba(255,255,255,0.35)',
    sep: '#232835', daySep: '#2b3140', rowA: '#151922', rowB: '#12151c', oiBg: '#11141b', zero: '#3a4150',
    cross: 'rgba(200,205,215,0.35)', crossBg: '#2a3550', tagText: '#ffffff',
    vprof: [240, 180, 41], dprof: [192, 132, 252],
    sess: [[0, 170, 170], [90, 140, 255], [230, 100, 170]], dayLine: [200, 205, 215],
  },
  light: {   // cream background, no pure white
    bg: '#f8f4e4', grid: '#e8e1c9', axis: '#6b6450', text: '#2b2a26', dim: '#9a927a',
    green: [24, 140, 70], red: [206, 52, 52], blue: [44, 104, 204], neutral: [120, 114, 98],
    cellText: '#1d1c19', fillMax: 0.6, selFill: 'rgba(60,50,20,0.06)', selStroke: 'rgba(60,50,20,0.45)',
    sep: '#d9d0b5', daySep: '#cfc5a6', rowA: '#f1ebd6', rowB: '#ece5cd', oiBg: '#f2ecd8', zero: '#b9b096',
    cross: 'rgba(70,60,35,0.4)', crossBg: '#4a5672', tagText: '#ffffff',
    vprof: [196, 98, 0], dprof: [118, 52, 214],
    sess: [[0, 128, 128], [40, 90, 200], [190, 50, 130]], dayLine: [60, 55, 40],
  },
};
let C = THEMES.dark;
const TF_MIN = { '1m': 1, '5m': 5, '15m': 15 };
const DEFAULT_COLW = 64;
const MIN_COLW = 0.005;   // px per candle (a whole year of M5 fits on screen)

const $ = (id) => document.getElementById(id);
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dayNum = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / DAY);

const S = {
  meta: null, agg: '5m', bin: 25, mode: 'delta', tz: 'America/New_York', oiUnit: 'btc',
  colW: DEFAULT_COLW, rightIdx: 0, priceTop: 0, ppu: 1, autoY: true, selected: -1, hover: null, profile: false, dprofile: false,
  layers: { sess: false, sessHL: false, sessVP: false, sessDP: false, dayHL: false, dayVP: false, dayDP: false },
};
const stores = new Map();

function newStore() {
  return { candles: [], minDay: null, maxDay: null, inflight: new Map(),
           fp: new Map(), fpByDay: new Map(), fpInflight: new Set() };
}
function store() {
  let st = stores.get(S.agg);
  if (!st) { st = newStore(); stores.set(S.agg, st); }
  return st;
}
const isVolumeAgg = (a) => !(a in TF_MIN);

// ---------------------------------------------------------------- formatting
function fmtK(v, sign = true) {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  const a = Math.abs(v);
  let s;
  if (a >= 1e9) s = (a / 1e9).toFixed(a >= 1e10 ? 1 : 2) + 'B';
  else if (a >= 1e6) s = (a / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
  else if (a >= 1e3) s = (a / 1e3).toFixed(0) + 'K';
  else s = a.toFixed(0);
  if (/^0(\.0)?[KMB]?$/.test(s)) return '0';
  return (v < 0 ? '−' : (sign ? '+' : '')) + s;
}
const fmtNum = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : v.toFixed(d);
const fmtPrice = (p) => p.toFixed(1);
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}:${String(r).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- time zones (DST via Intl / IANA)
const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', timeZoneName: 'short' });
    dtfCache.set(tz, f);
  }
  return f;
}
function parts(ts, tz) {
  const o = {};
  for (const p of dtf(tz).formatToParts(new Date(ts))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, wd: o.weekday, tzn: o.timeZoneName };
}
function localInfo(c) {   // cached per candle and tz
  if (!c._lt || c._lt.tz !== S.tz) {
    const p = parts(c.start_ts, S.tz);
    const hm = `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
    c._lt = { tz: S.tz, mod: p.h * 60 + p.mi, hm, hms: `${hm}:${String(p.s).padStart(2, '0')}`,
              date: `${p.wd} ${String(p.d).padStart(2, '0')}.${String(p.mo).padStart(2, '0')}.`, dkey: p.y * 400 + p.mo * 32 + p.d,
              dshort: `${String(p.d).padStart(2, '0')}.${String(p.mo).padStart(2, '0')}.${p.mo === 1 && p.d <= 7 ? ` ${p.y}` : ''}`,
              dnum: Math.floor(Date.UTC(p.y, p.mo - 1, p.d) / DAY), ym: p.y * 12 + p.mo - 1, mlabel: `${p.mo}/${p.y}` };
  }
  return c._lt;
}
function fmtTs(ts, withSec = false) {
  const p = parts(ts, S.tz);
  const t = `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}` + (withSec ? `:${String(p.s).padStart(2, '0')}` : '');
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${t} ${S.tz === 'UTC' ? 'UTC' : p.tzn}`;
}
function zonedToUtc(y, mo, d, h, mi, tz) {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let guess = naive;
  for (let k = 0; k < 3; k++) {
    const p = parts(guess, tz);
    const off = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - guess;
    guess = naive - off;
  }
  return guess;
}

// ---------------------------------------------------------------- data loading
function toRows(js) {
  const cols = js.cols, n = js.n, keys = Object.keys(cols), out = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = {};
    for (const k of keys) o[k] = cols[k][i];
    out[i] = o;
  }
  return out;
}
function status(msg) { $('status').textContent = msg; }

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

function loadDay(dn, st = store(), agg = S.agg) {
  // one request per day; concurrent callers await the same promise
  if (st.inflight.has(dn)) return st.inflight.get(dn);
  const p = (async () => {
    try {
      const rows = toRows(await fetchJson(`/api/candles?agg=${agg}&start=${dn * DAY}&end=${(dn + 1) * DAY}`));
      const current = stores.get(S.agg) === st;
      if (st.minDay === null) { st.candles = rows; st.minDay = st.maxDay = dn; }
      else if (dn === st.minDay - 1) {
        st.candles = rows.concat(st.candles); st.minDay = dn;
        if (current) { S.rightIdx += rows.length; if (S.selected >= 0) S.selected += rows.length; }
      } else if (dn === st.maxDay + 1) { st.candles = st.candles.concat(rows); st.maxDay = dn; }
      else return;
      if (current) { draw(); updateSide(); }
    } catch (e) { status(t('err_load') + e.message); throw e; }
    finally { st.inflight.delete(dn); if (stores.get(S.agg) === st) setTimeout(ensure, 0); }
  })();
  st.inflight.set(dn, p);
  return p;
}

async function loadFp(dn, st = store(), agg = S.agg) {
  st.fpInflight.add(dn);
  try {
    const js = await fetchJson(`/api/footprint?agg=${agg}&start=${dn * DAY}&end=${(dn + 1) * DAY}`);
    const c = js.cols, n = js.n, list = [];
    let i = 0;
    while (i < n) {
      const id = c.cid[i];
      let j = i;
      while (j < n && c.cid[j] === id) j++;
      st.fp.set(id, { lv: c.level.slice(i, j), b: c.buy_usd.slice(i, j), s: c.sell_usd.slice(i, j), cache: {} });
      list.push(id);
      i = j;
    }
    st.fpByDay.set(dn, list);
    if (stores.get(S.agg) === st) draw();
  } catch (e) { status(t('err_fp') + e.message); }
  finally { st.fpInflight.delete(dn); }
}

function ensure() {
  const st = store(), m = S.meta && S.meta.aggregations[S.agg];
  if (!m || st.minDay === null) return;
  const first = dayNum(m.first_day), last = dayNum(m.last_day);
  const [l, r] = visRange();
  const n = st.candles.length;
  if (st.inflight.size === 0) {
    if (l < 20 && st.minDay > first) loadDay(st.minDay - 1, st).catch(() => {});
    else if (r > n - 20 && st.maxDay < last) loadDay(st.maxDay + 1, st).catch(() => {});
  }
  if (showCells() && n) {
    const d0 = Math.floor(st.candles[clamp(l, 0, n - 1)].start_ts / DAY);
    const d1 = Math.floor(st.candles[clamp(r, 0, n - 1)].start_ts / DAY);
    for (let d = d0; d <= d1; d++) {
      if (!st.fpByDay.has(d) && !st.fpInflight.has(d) && st.fpInflight.size < 2) loadFp(d, st);
    }
    // evict footprint days far from the view (bounded memory over long ranges)
    for (const [d, list] of st.fpByDay) {
      if (d < d0 - 3 || d > d1 + 3) { for (const id of list) st.fp.delete(id); st.fpByDay.delete(d); }
    }
  }
  ensurePeriods();
  updateStatus();
}

// ---------------------------------------------------------------- sessions / days (server: /api/periods)
const PER = { key: '', map: new Map(), blocks: new Set(), inflight: new Set() };
const PERIOD_BLOCK_DAYS = 7;
const anyLayer = () => Object.values(S.layers).some(Boolean);

function ensurePeriods() {
  if (!anyLayer()) return;
  const key = `${S.tz}|${S.bin}`;   // days follow the display tz, profile levels the display bin
  if (PER.key !== key) { PER.key = key; PER.map = new Map(); PER.blocks = new Set(); PER.inflight = new Set(); }
  const cs = store().candles;
  if (!cs.length) return;
  const [l, r] = visRange();
  const b0 = Math.floor(cs[l].start_ts / DAY / PERIOD_BLOCK_DAYS), b1 = Math.floor(cs[r].start_ts / DAY / PERIOD_BLOCK_DAYS);
  for (let b = b0; b <= b1; b++) {
    if (PER.blocks.has(b) || PER.inflight.has(b) || PER.inflight.size >= 2) continue;
    loadPeriods(b, key);
  }
}

async function loadPeriods(b, key) {
  PER.inflight.add(b);
  try {
    const s = b * PERIOD_BLOCK_DAYS * DAY, e = (b + 1) * PERIOD_BLOCK_DAYS * DAY;
    const js = await fetchJson(`/api/periods?start=${s}&end=${e}&tz=${encodeURIComponent(S.tz)}&bin=${S.bin}`);
    if (PER.key !== key) return;
    const byId = new Map();
    for (const p of toRows(js.periods)) { p.lv = []; p.b = []; p.s = []; byId.set(p.id, p); }
    const L = js.levels.cols, n = js.levels.n;
    for (let i = 0; i < n; i++) {
      const p = byId.get(L.id[i]);
      if (p) { p.lv.push(L.level[i]); p.b.push(L.buy_usd[i]); p.s.push(L.sell_usd[i]); }
    }
    for (const [id, p] of byId) PER.map.set(id, p);
    PER.blocks.add(b);
    draw();
  } catch (e) { status(t('err_periods') + e.message); }
  finally { PER.inflight.delete(b); setTimeout(ensurePeriods, 0); }
}

// x of a timestamp on the candle axis (first candle starting at/after ts)
function timeToX(ts) {
  const cs = store().candles;
  let lo = 0, hi = cs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cs[m].start_ts < ts) lo = m + 1; else hi = m; }
  return xOf(lo);
}

function sessColor(name) {
  const list = (S.meta.sessions && S.meta.sessions.list) || [];
  const i = Math.max(0, list.findIndex((s) => s.name === name));
  return C.sess[i % C.sess.length];
}

function visiblePeriods() {
  const cs = store().candles;
  if (!cs.length || !PER.map.size) return [];
  const [l, r] = visRange(), t0 = cs[l].start_ts, t1 = cs[r].start_ts + 1;
  return [...PER.map.values()].filter((p) => p.start_ts < t1 && p.end_ts > t0);
}

function drawSessionBands() {   // behind the candles
  if (!S.layers.sess) return;
  ctx.font = `10px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  for (const p of visiblePeriods()) {
    if (p.kind !== 'session') continue;
    const x0 = timeToX(p.start_ts), x1 = timeToX(p.end_ts), col = sessColor(p.name);
    ctx.fillStyle = rgba(col, 0.07); ctx.fillRect(x0, 0, x1 - x0, G.mainH);
    ctx.fillStyle = rgba(col, 0.55); ctx.fillRect(x0, G.mainH - 2, x1 - x0, 2);
    if (x1 - x0 > 46) { ctx.fillStyle = rgba(col, 0.9); ctx.fillText(p.name, x0 + 3, G.mainH - 15); }
  }
}

function drawPeriodOverlays() {   // over the candles: high/low lines, volume and delta profiles
  const L = S.layers, list = visiblePeriods();
  if (!list.length) return;
  ctx.font = `10px ${MONO}`; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
  for (const p of list) {
    const isDay = p.kind === 'day';
    const hl = isDay ? L.dayHL : L.sessHL, vp = isDay ? L.dayVP : L.sessVP, dp = isDay ? L.dayDP : L.sessDP;
    if (!hl && !vp && !dp) continue;
    const x0 = timeToX(p.start_ts), x1 = timeToX(p.end_ts), span = x1 - x0;
    if (span < 2) continue;
    const col = isDay ? C.dayLine : sessColor(p.name);
    const tag = isDay ? 'D' : p.name;
    if (hl) {
      for (const [v, lab] of [[p.high, 'H'], [p.low, 'L']]) {
        const y = Math.round(yOf(v)) + 0.5;
        ctx.strokeStyle = rgba(col, isDay ? 0.75 : 0.9); ctx.setLineDash(isDay ? [6, 3] : [2, 3]); ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.setLineDash([]); ctx.lineWidth = 1;
        if (span > 70) {   // sessions: label at the start, days: at the end (they share start points)
          const t = `${tag} ${lab} ${fmtPrice(v)}`;
          ctx.fillStyle = rgba(col, 1); ctx.textAlign = isDay ? 'right' : 'left';
          ctx.fillText(t, isDay ? x1 - 3 : x0 + 3, lab === 'H' ? y - 1 : y + 12);
          ctx.textAlign = 'left';
        }
      }
    }
    const rh = S.bin * S.ppu, W = Math.min(span * (vp && dp ? 0.3 : 0.4), 220);
    if ((!vp && !dp) || W < 6 || rh < 0.6 || !p.lv.length) continue;
    const n = p.lv.length;
    let vmax = 0, dmax = 0, poc = 0;
    for (let k = 0; k < n; k++) {
      const v = p.b[k] + p.s[k], d = Math.abs(p.b[k] - p.s[k]);
      if (v > vmax) { vmax = v; poc = k; }
      dmax = Math.max(dmax, d);
    }
    for (let k = 0; k < n; k++) {
      const yT = yOf(p.lv[k] + S.bin), h = Math.max(1, rh - (rh > 3 ? 1 : 0));
      if (yT > G.mainH || yT + h < 0) continue;
      if (vp && vmax > 0) {   // anchored at the period start, growing right
        const w = ((p.b[k] + p.s[k]) / vmax) * W;
        ctx.fillStyle = rgba(col, k === poc ? 0.75 : 0.32); ctx.fillRect(x0, yT, w, h);
      }
      if (dp && dmax > 0) {   // zero line near the period end, buyers right / sellers left
        const d = p.b[k] - p.s[k], w = (Math.abs(d) / dmax) * (W / 2), zx = x1 - W / 2 - 2;
        ctx.fillStyle = rgba(d >= 0 ? C.green : C.red, 0.55); ctx.fillRect(d >= 0 ? zx : zx - w, yT, w, h);
      }
    }
    if (dp && dmax > 0) {
      const zx = Math.round(x1 - W / 2 - 2) + 0.5;
      ctx.strokeStyle = rgba(col, 0.6); ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(zx, yOf(p.high)); ctx.lineTo(zx, yOf(p.low)); ctx.stroke(); ctx.setLineDash([]);
    }
  }
}

function fpFor(c, bin) {
  const f = store().fp.get(c.cid);
  if (!f) return null;
  let r = f.cache[bin];
  if (!r) {   // re-bin the base-bin footprint (levels are sorted ascending)
    r = { lv: [], b: [], s: [] };
    for (let i = 0; i < f.lv.length; i++) {
      const L = Math.floor(f.lv[i] / bin) * bin, k = r.lv.length - 1;
      if (k >= 0 && r.lv[k] === L) { r.b[k] += f.b[i]; r.s[k] += f.s[i]; }
      else { r.lv.push(L); r.b.push(f.b[i]); r.s.push(f.s[i]); }
    }
    f.cache[bin] = r;
  }
  return r;
}

// ---------------------------------------------------------------- geometry
const canvas = $('chart'), ctx = canvas.getContext('2d');
const G = { W: 0, H: 0, plotW: 0, AX: 76, mainH: 0, tableTop: 0, oiTop: 0, oiH: 0, timeTop: 0, ROW: 16, TROWS: 5, TIME: 20 };

function layout() {
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  G.W = r.width; G.H = r.height;
  if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  G.plotW = G.W - G.AX;
  G.timeTop = G.H - G.TIME;
  G.oiH = Math.max(56, Math.round(G.H * 0.11));
  G.oiTop = G.timeTop - G.oiH - 2;
  G.tableTop = G.oiTop - 6 - G.ROW * G.TROWS;
  G.mainH = G.tableTop - 6;
}
const xOf = (i) => G.plotW - (S.rightIdx - i) * S.colW;
const idxAt = (x) => S.rightIdx - (G.plotW - x) / S.colW;
const yOf = (p) => (S.priceTop - p) * S.ppu;
const priceAt = (y) => S.priceTop - y / S.ppu;
function visRange() {
  const n = store().candles.length;
  return [clamp(Math.floor(idxAt(0)), 0, Math.max(0, n - 1)), clamp(Math.ceil(S.rightIdx), 0, Math.max(0, n - 1))];
}
const rowH = () => S.bin * S.ppu;
const showCells = () => S.colW >= 12 && rowH() >= 3;
const showText = () => S.colW >= 40 && rowH() >= 10;

function autoFitY() {
  const st = store(), [l, r] = visRange();
  let lo = Infinity, hi = -Infinity;
  for (let i = l; i <= r && i < st.candles.length; i++) { lo = Math.min(lo, st.candles[i].low); hi = Math.max(hi, st.candles[i].high); }
  if (!isFinite(lo)) return;
  const pad = (hi - lo) * 0.06 + S.bin;
  S.ppu = G.mainH / Math.max(hi - lo + 2 * pad, 1);
  S.priceTop = hi + pad;
}

// ---------------------------------------------------------------- drawing
let drawPending = false;
function draw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => { drawPending = false; render(); });
}

function niceStep(minUsd) {
  const steps = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
  return steps.find((s) => s >= minUsd) || 20000;
}

function render() {
  layout();
  const st = store(), cs = st.candles, n = cs.length;
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, G.W, G.H);
  if (!n) { ctx.fillStyle = C.dim; ctx.font = `13px ${MONO}`; ctx.fillText(t('loading'), 20, 40); return; }
  if (S.autoY) autoFitY();
  const [l, r] = visRange();
  const cells = showCells(), text = showText();

  // price grid + axis
  const step = niceStep(28 / S.ppu);
  ctx.font = `11px ${MONO}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const pLo = priceAt(G.mainH), pHi = S.priceTop;
  for (let p = Math.ceil(pLo / step) * step; p <= pHi; p += step) {
    const y = Math.round(yOf(p)) + 0.5;
    ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(G.plotW, y); ctx.stroke();
    ctx.fillStyle = C.axis; ctx.fillText(p.toFixed(step < 1 ? 1 : 0), G.plotW + 6, y);
  }

  // main panel
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, G.plotW, G.mainH); ctx.clip();
  if (S.selected >= l && S.selected <= r) {
    ctx.fillStyle = C.selFill; ctx.fillRect(xOf(S.selected), 0, S.colW, G.mainH);
  }
  drawSessionBands();
  if (cells) drawCells(cs, l, r, text); else drawCandlesWide(cs, l, r);
  drawPeriodOverlays();
  drawSelection(cs);
  drawPocMarkers(cs);
  ctx.restore();

  drawWickTags(cs);
  drawTable(cs, l, r);
  drawOi(cs, l, r);
  drawTimeAxis(cs, l, r);
  drawCrosshair(cs);

  // separators
  ctx.strokeStyle = C.sep;
  ctx.beginPath(); ctx.moveTo(G.plotW + 0.5, 0); ctx.lineTo(G.plotW + 0.5, G.H); ctx.stroke();
}

function candleColor(c) { return c.close > c.open ? C.green : c.close < c.open ? C.red : C.neutral; }

function drawCandle(c, x, w) {
  const col = candleColor(c), cx = Math.round(x + w / 2) + 0.5;
  ctx.strokeStyle = rgba(col, 1); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx, yOf(c.high)); ctx.lineTo(cx, yOf(c.low)); ctx.stroke();
  const y1 = yOf(Math.max(c.open, c.close)), y2 = yOf(Math.min(c.open, c.close));
  ctx.fillStyle = rgba(col, 1);
  ctx.fillRect(Math.round(x), y1, Math.max(1, Math.round(w)), Math.max(1, y2 - y1));
}

const COMPRESS_BELOW = 1.5;   // px per candle; below this, candles are merged per pixel column
const compressed = () => S.colW < COMPRESS_BELOW;

// visible candles grouped by pixel column: [{px, i0, i1}]
function pixelGroups(l, r) {
  const out = [];
  let cur = null;
  for (let i = l; i <= r; i++) {
    const px = Math.floor(xOf(i));
    if (cur && cur.px === px) cur.i1 = i;
    else { cur = { px, i0: i, i1: i }; out.push(cur); }
  }
  return out;
}

function drawCandlesWide(cs, l, r) {
  if (compressed()) {   // one bar per pixel: high/low of the group, colour by group open -> close
    for (const g of pixelGroups(l, r)) {
      let hi = -Infinity, lo = Infinity;
      for (let i = g.i0; i <= g.i1; i++) { hi = Math.max(hi, cs[i].high); lo = Math.min(lo, cs[i].low); }
      const o = cs[g.i0].open, c = cs[g.i1].close;
      ctx.fillStyle = rgba(c > o ? C.green : c < o ? C.red : C.neutral, 1);
      const y1 = yOf(hi);
      ctx.fillRect(g.px, y1, 1, Math.max(1, yOf(lo) - y1));
    }
    return;
  }
  const w = Math.max(1, S.colW * 0.65);
  for (let i = l; i <= r; i++) drawCandle(cs[i], xOf(i) + (S.colW - w) / 2, w);
}

function percentile(arr, q) {
  if (!arr.length) return 1;
  arr.sort((a, b) => a - b);
  return arr[Math.min(arr.length - 1, Math.floor(q * (arr.length - 1)))] || 1;
}

function drawCells(cs, l, r, text) {
  const bin = S.bin, rh = rowH(), mode = S.mode;
  const candleW = clamp(Math.round(S.colW * 0.1), 3, 7);
  // intensity scale: 95th percentile of the visible values
  const vals = [];
  for (let i = l; i <= r; i++) {
    const f = fpFor(cs[i], bin);
    if (!f) continue;
    for (let k = 0; k < f.lv.length; k++) {
      if (mode === 'delta') vals.push(Math.abs(f.b[k] - f.s[k]));
      else if (mode === 'volume') vals.push(f.b[k] + f.s[k]);
      else vals.push(f.b[k], f.s[k]);
    }
  }
  const p95 = percentile(vals, 0.95);
  const fs = Math.min(12, Math.floor(rh * 0.78));
  ctx.font = `${fs}px ${MONO}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  const alphaOf = (v) => { const a = Math.min(1, v / p95); return a < 0.12 ? 0 : 0.15 + (C.fillMax - 0.15) * a; };

  for (let i = l; i <= r; i++) {
    const c = cs[i], x = xOf(i);
    const cx0 = x + candleW + 3, cw = S.colW - candleW - 5;
    drawCandle(c, x + 1, candleW);
    const f = fpFor(c, bin);
    if (!f || cw < 3) continue;
    for (let k = 0; k < f.lv.length; k++) {
      const yT = yOf(f.lv[k] + bin), y0 = Math.round(yT) + 0.5, h = Math.max(1, Math.round(yT + rh) - Math.round(yT) - 1);
      if (y0 > G.mainH || y0 + h < 0) continue;
      const b = f.b[k], s = f.s[k], d = b - s;
      if (mode === 'sellbuy') {
        const half = cw / 2;
        let a = alphaOf(s); if (a) { ctx.fillStyle = rgba(C.red, a); ctx.fillRect(cx0, y0, half - 0.5, h); }
        a = alphaOf(b); if (a) { ctx.fillStyle = rgba(C.green, a); ctx.fillRect(cx0 + half + 0.5, y0, half - 0.5, h); }
        if (text && cw >= 76) {
          ctx.fillStyle = C.text;
          ctx.fillText(fmtK(s, false), cx0 + half / 2, y0 + h / 2);
          ctx.fillText(fmtK(b, false), cx0 + half * 1.5, y0 + h / 2);
        }
      } else {
        const v = mode === 'delta' ? Math.abs(d) : b + s;
        const a = alphaOf(v);
        if (a) { ctx.fillStyle = rgba(mode === 'volume' ? C.blue : (d >= 0 ? C.green : C.red), a); ctx.fillRect(cx0, y0, cw, h); }
        if (text) {
          const t = mode === 'delta' ? fmtK(d) : fmtK(b + s, false);
          ctx.fillStyle = a ? C.cellText : C.dim;
          if (ctx.measureText(t).width < cw - 2) ctx.fillText(t, cx0 + cw / 2, y0 + h / 2);
        }
      }
    }
    if (S.profile) drawProfile(f, cx0, cw, bin);
    if (S.dprofile) drawDeltaProfile(f, cx0, cw, bin);
  }
}

// Smoothed curve through points (quadratic midpoint interpolation), continuing the current path.
function traceCurve(pts) {
  ctx.lineTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
  }
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
}

// Delta profile of one candle: (buy - sell) per price level around a vertical zero line in the middle
// of the cell area (right = buyers dominate, left = sellers), scaled to the candle's max |delta|.
function drawDeltaProfile(f, cx0, cw, bin) {
  const n = f.lv.length;
  if (!n || cw < 8) return;
  const dl = new Map();
  let m = 0;
  for (let k = 0; k < n; k++) { const d = f.b[k] - f.s[k]; dl.set(f.lv[k], d); m = Math.max(m, Math.abs(d)); }
  if (!m) return;
  const mid = cx0 + cw / 2, half = (cw / 2) * 0.92, lo = f.lv[0], hi = f.lv[n - 1], pts = [];
  let neg = null, pos = null, dmin = 0, dmax = 0;   // most negative / most positive delta level
  for (let L = lo; L <= hi; L += bin) {
    const d = dl.get(L) || 0;
    const pt = { x: mid + (d / m) * half, y: yOf(L + bin / 2) };
    pts.push(pt);
    if (d < dmin) { dmin = d; neg = pt; }
    if (d > dmax) { dmax = d; pos = pt; }
  }
  const yBot = yOf(lo), yTop = yOf(hi + bin);
  ctx.strokeStyle = rgba(C.dprof, 0.45); ctx.setLineDash([2, 2]);   // zero line
  ctx.beginPath(); ctx.moveTo(Math.round(mid) + 0.5, yBot); ctx.lineTo(Math.round(mid) + 0.5, yTop); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(mid, yBot); traceCurve(pts); ctx.lineTo(mid, yTop); ctx.closePath();
  ctx.fillStyle = rgba(C.dprof, 0.16); ctx.fill();
  ctx.beginPath(); ctx.moveTo(mid, yBot); traceCurve(pts); ctx.lineTo(mid, yTop);
  ctx.strokeStyle = rgba(C.dprof, 0.95); ctx.lineWidth = 1.3; ctx.stroke(); ctx.lineWidth = 1;
  for (const [pt, col] of [[neg, C.red], [pos, C.green]]) {
    if (!pt) continue;
    ctx.fillStyle = rgba(col, 1); ctx.strokeStyle = C.bg; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}

// Volume profile of one candle: smoothed distribution of total volume per price level,
// drawn from the left edge of the cell area (levels without trades count as zero).
function drawProfile(f, cx0, cw, bin) {
  const n = f.lv.length;
  if (!n || cw < 8) return;
  const vol = new Map();
  let m = 0;
  for (let k = 0; k < n; k++) { const v = f.b[k] + f.s[k]; vol.set(f.lv[k], v); m = Math.max(m, v); }
  if (!m) return;
  const w = cw * 0.92, lo = f.lv[0], hi = f.lv[n - 1], pts = [];
  let poc = null;
  for (let L = lo; L <= hi; L += bin) {
    const v = vol.get(L) || 0;
    const pt = { x: cx0 + (v / m) * w, y: yOf(L + bin / 2) };
    pts.push(pt);
    if (v === m && !poc) poc = pt;
  }
  const yBot = yOf(lo), yTop = yOf(hi + bin);
  const curve = () => traceCurve(pts);
  ctx.beginPath(); ctx.moveTo(cx0, yBot); curve(); ctx.lineTo(cx0, yTop); ctx.closePath();
  ctx.fillStyle = rgba(C.vprof, 0.16); ctx.fill();
  ctx.beginPath(); ctx.moveTo(cx0, yBot); curve(); ctx.lineTo(cx0, yTop);
  ctx.strokeStyle = rgba(C.vprof, 0.9); ctx.lineWidth = 1.3; ctx.stroke(); ctx.lineWidth = 1;
  if (poc) {   // point of control
    ctx.fillStyle = rgba(C.vprof, 1);
    ctx.beginPath(); ctx.arc(poc.x, poc.y, 2.2, 0, Math.PI * 2); ctx.fill();
  }
}

function drawSelection(cs) {
  const i = S.selected;
  if (i < 0 || i >= cs.length) return;
  const c = cs[i], x = xOf(i);
  ctx.save();
  ctx.setLineDash([5, 3]); ctx.lineWidth = 1.2;
  ctx.font = `10px ${MONO}`; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
  for (const [p, col] of wickLines(c)) {
    const y = Math.round(yOf(p)) + 0.5;
    ctx.strokeStyle = rgba(col, 0.95);
    ctx.beginPath(); ctx.moveTo(Math.min(x - S.colW * 0.6, x - 40), y); ctx.lineTo(Math.max(x + S.colW * 1.6, x + S.colW + 40), y); ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = C.selStroke;
  ctx.strokeRect(Math.round(x) + 0.5, 0.5, Math.round(S.colW) - 1, G.mainH - 1);
}

function wickLines(c) {
  return [[Math.min(c.open, c.close), C.green, 'L'], [Math.max(c.open, c.close), C.red, 'S']];
}

// POC levels of the selected candle at the display bin
function pocLevels(c) {
  const pb = S.bin, out = [];
  for (const [key, col, lab] of [[`vpoc_${pb}`, C.vprof, 'vPOC'], [`dpoc_neg_${pb}`, C.red, 'Δ−'], [`dpoc_pos_${pb}`, C.green, 'Δ+']]) {
    const v = c[key];
    if (v !== null && v !== undefined) out.push({ p: v + pb / 2, lo: v, col, lab });
  }
  return out;
}

function drawPocMarkers(cs) {
  const i = S.selected;
  if (i < 0 || i >= cs.length) return;
  const x = xOf(i), pb = S.bin;
  for (const t of pocLevels(cs[i])) {   // bucket outline across the column
    const y1 = yOf(t.lo + pb), y2 = yOf(t.lo);
    ctx.strokeStyle = rgba(t.col, 0.95); ctx.lineWidth = 2;
    ctx.strokeRect(Math.round(x) + 1.5, Math.round(y1) + 0.5, Math.round(S.colW) - 3, Math.max(2, Math.round(y2 - y1) - 1));
    ctx.lineWidth = 1;
  }
}

function drawWickTags(cs) {
  const i = S.selected;
  if (i < 0 || i >= cs.length) return;
  const c = cs[i], tags = [];
  for (const [p, col, lab] of wickLines(c)) tags.push({ y: yOf(p), col, text: `${lab} ${fmtPrice(p)}` });
  for (const t of pocLevels(c)) tags.push({ y: yOf(t.p), col: t.col, text: `${t.lab} ${t.lo}` });
  tags.sort((a, b) => a.y - b.y);
  ctx.font = `11px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  let last = -1e9;
  for (const t of tags) {   // stack so the tags never overlap
    const y = Math.round(Math.max(t.y, last + 16)) + 0.5;
    last = y;
    if (y < 0 || y > G.mainH) continue;
    ctx.fillStyle = rgba(t.col, 0.9); ctx.fillRect(G.plotW + 1, y - 8, G.AX - 1, 16);
    ctx.fillStyle = C.tagText; ctx.fillText(t.text, G.plotW + 4, y);
  }
}

function drawTable(cs, l, r) {
  const rows = [
    ['Volume', (c) => c.volume_usd, (v) => fmtK(v, false), false],
    ['CVD', (c) => c.cvd_usd, (v) => fmtK(v), true],
    ['Delta', (c) => c.delta_usd, (v) => fmtK(v), true],
    ['Trades', (c) => c.trades, (v) => v >= 1e4 ? (v / 1e3).toFixed(0) + 'K' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(v), false],
    [S.oiUnit === 'btc' ? 'OI Δ BTC' : 'OI Δ USD', (c) => S.oiUnit === 'btc' ? c.d_oi : c.d_oi_usd,
     (v) => S.oiUnit === 'btc' ? (Math.abs(v) >= 1e3 ? fmtK(v) : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(0)) : fmtK(v), true],
  ];
  const txt = S.colW >= 38;
  ctx.font = `11px ${MONO}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  rows.forEach(([label], ri) => { ctx.fillStyle = C.axis; ctx.fillText(label, G.plotW + 6, G.tableTop + ri * G.ROW + G.ROW / 2); });
  ctx.save();
  ctx.beginPath(); ctx.rect(0, G.tableTop, G.plotW, G.ROW * G.TROWS); ctx.clip();
  if (compressed()) {   // per pixel: sums (volume, delta, trades, ΔOI), last value (CVD)
    const groups = pixelGroups(l, r);
    rows.forEach(([label, get, fmt, signed], ri) => {
      const y = G.tableTop + ri * G.ROW;
      ctx.fillStyle = ri % 2 ? C.rowB : C.rowA; ctx.fillRect(0, y, G.plotW, G.ROW);
      const vals = groups.map((g) => {
        if (ri === 1) return get(cs[g.i1]);
        let s = null;
        for (let i = g.i0; i <= g.i1; i++) { const v = get(cs[i]); if (v !== null && v !== undefined) s = (s || 0) + v; }
        return s;
      });
      const m = Math.max(1e-9, ...vals.map((v) => Math.abs(v || 0)));
      groups.forEach((g, k) => {
        const v = vals[k];
        if (v === null || v === undefined || v === 0) return;
        const a = signed ? 0.15 + 0.6 * Math.abs(v) / m : 0.08 + 0.5 * v / m;
        ctx.fillStyle = rgba(signed ? (v > 0 ? C.green : C.red) : C.blue, a);
        ctx.fillRect(g.px, y + 1, 1, G.ROW - 2);
      });
    });
    ctx.restore();
    return;
  }
  rows.forEach(([label, get, fmt, signed], ri) => {
    const y = G.tableTop + ri * G.ROW;
    ctx.fillStyle = ri % 2 ? C.rowB : C.rowA; ctx.fillRect(0, y, G.plotW, G.ROW);
    // volume: intensity vs. max visible
    let vmax = 1;
    if (!signed) for (let i = l; i <= r; i++) vmax = Math.max(vmax, get(cs[i]) || 0);
    ctx.textAlign = 'center';
    for (let i = l; i <= r; i++) {
      const v = get(cs[i]);
      if (v === null || v === undefined) continue;
      const x = xOf(i);
      if (signed) {
        if (v !== 0) { ctx.fillStyle = rgba(v > 0 ? C.green : C.red, 0.22); ctx.fillRect(x + 1, y + 1, S.colW - 2, G.ROW - 2); }
      } else if (ri === 0) {
        ctx.fillStyle = rgba(C.blue, 0.08 + 0.3 * v / vmax); ctx.fillRect(x + 1, y + 1, S.colW - 2, G.ROW - 2);
      }
      if (txt) {
        ctx.fillStyle = signed ? (v > 0 ? rgba(C.green, 1) : v < 0 ? rgba(C.red, 1) : C.text) : C.text;
        const t = fmt(v);
        if (ctx.measureText(t).width < S.colW - 2) ctx.fillText(t, x + S.colW / 2, y + G.ROW / 2);
      }
    }
  });
  ctx.restore();
}

function drawOi(cs, l, r) {
  const top = G.oiTop, h = G.oiH, mid = top + h / 2;
  ctx.fillStyle = C.oiBg; ctx.fillRect(0, top, G.plotW, h);
  const get0 = (c) => S.oiUnit === 'btc' ? c.d_oi : c.d_oi_usd;
  let get = get0, xs = null;
  if (compressed()) {   // per pixel: sum of ΔOI of the merged candles (null when none has a snapshot)
    const groups = pixelGroups(l, r), sums = [];
    for (const g of groups) {
      let s = null;
      for (let i = g.i0; i <= g.i1; i++) { const v = get0(cs[i]); if (v !== null && v !== undefined) s = (s || 0) + v; }
      sums.push(s);
    }
    xs = groups.map((g) => g.px);
    cs = sums.map((v) => ({ v })); get = (o) => o.v; l = 0; r = sums.length - 1;
  }
  let m = 0;
  for (let i = l; i <= r; i++) { const v = get(cs[i]); if (v !== null && v !== undefined) m = Math.max(m, Math.abs(v)); }
  ctx.strokeStyle = C.zero; ctx.beginPath(); ctx.moveTo(0, Math.round(mid) + 0.5); ctx.lineTo(G.plotW, Math.round(mid) + 0.5); ctx.stroke();
  ctx.font = `10px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = C.axis;
  ctx.fillText(`ΔOI ${S.oiUnit.toUpperCase()}`, G.plotW + 6, top + 8);
  if (m > 0) {
    const fm = S.oiUnit === 'btc' ? (m >= 1e3 ? fmtK(m, false) : m.toFixed(0)) : fmtK(m, false);
    ctx.fillText('+' + fm, G.plotW + 6, top + 22); ctx.fillText('−' + fm, G.plotW + 6, top + h - 6);
  }
  if (!m) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, top, G.plotW, h); ctx.clip();
  const w = xs ? 1 : Math.max(1, S.colW * 0.7);
  for (let i = l; i <= r; i++) {
    const v = get(cs[i]);
    if (v === null || v === undefined) continue;
    const bh = (v / m) * (h / 2 - 3);
    ctx.fillStyle = rgba(v >= 0 ? C.green : C.red, 0.85);
    ctx.fillRect(xs ? xs[i] : xOf(i) + (S.colW - w) / 2, bh >= 0 ? mid - bh : mid, w, Math.max(1, Math.abs(bh)));
  }
  ctx.restore();
}

function drawTimeAxis(cs, l, r) {
  const top = G.timeTop;
  ctx.fillStyle = C.bg; ctx.fillRect(0, top, G.W, G.TIME);
  ctx.font = `11px ${MONO}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  const tf = TF_MIN[S.agg];
  // average px per day (also for volume candles, from their average count per day)
  const perDay = tf ? 1440 / tf : ((S.meta.aggregations[S.agg] || {}).per_day || 100);
  const dayPx = perDay * S.colW;
  let stepMin = null, every = null, stepDays = null;
  if (dayPx < 74) stepDays = [1, 2, 7, 14, 30].find((k) => k * dayPx >= 74) || 30;   // long ranges: dates only
  else if (tf) stepMin = [1, 5, 15, 30, 60, 120, 180, 240, 360, 720, 1440].find((m) => (m / tf) * S.colW >= 74) || 1440;
  else every = Math.max(1, Math.ceil(84 / S.colW));
  let prevDay = null, lastX = -1e9, prevKey = null;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, G.plotW, G.H); ctx.clip();
  const idxs = compressed() ? pixelGroups(l, r).map((g) => g.i0) : null;
  const nIdx = idxs ? idxs.length : r - l + 1;
  for (let k = 0; k < nIdx; k++) {
    const i = idxs ? idxs[k] : l + k;
    const c = cs[i], li = localInfo(c), x = xOf(i);
    const newDay = prevDay !== null && li.dkey !== prevDay;
    prevDay = li.dkey;
    if (stepDays) {   // label where the month / week / day bucket changes between inspected candles
      const key = stepDays >= 30 ? li.ym : Math.floor(li.dnum / stepDays);
      const lab = prevKey !== null && key !== prevKey;
      prevKey = key;
      if (lab && x - lastX >= 60) {
        lastX = x; ctx.fillStyle = C.axis;
        ctx.fillText(stepDays >= 30 ? li.mlabel : li.dshort, x, top + G.TIME / 2);
      }
      continue;
    }
    if (newDay && dayPx >= 30) {   // day separator (local day in display timezone)
      ctx.strokeStyle = C.daySep; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, G.timeTop); ctx.stroke();
      ctx.setLineDash([]);
    }
    const lab = tf ? (li.mod % stepMin === 0) : (i % every === 0);
    if (!lab || x - lastX < 60) continue;
    lastX = x;
    ctx.fillStyle = li.mod === 0 || (newDay && !tf) ? C.text : C.axis;
    ctx.fillText(tf ? (li.mod === 0 ? li.date : li.hm) : (newDay ? li.date : li.hms), x + S.colW / 2, top + G.TIME / 2);
  }
  ctx.restore();
  ctx.textAlign = 'left'; ctx.fillStyle = C.dim;
  ctx.fillText(S.tz === 'UTC' ? 'UTC' : 'NY', G.plotW + 6, top + G.TIME / 2);
}

function drawCrosshair(cs) {
  const h = S.hover;
  if (!h || h.x > G.plotW) { $('tooltip').hidden = true; return; }
  const i = Math.floor(idxAt(h.x));
  ctx.strokeStyle = C.cross; ctx.setLineDash([3, 3]);
  if (i >= 0 && i < cs.length) {
    const cx = Math.round(xOf(i) + S.colW / 2) + 0.5;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, G.timeTop); ctx.stroke();
  }
  if (h.y < G.mainH) {
    const y = Math.round(h.y) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(G.plotW, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.crossBg; ctx.fillRect(G.plotW + 1, y - 9, G.AX - 1, 18);
    ctx.fillStyle = C.tagText; ctx.font = `11px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(fmtPrice(priceAt(h.y)), G.plotW + 6, y);
  }
  ctx.setLineDash([]);
  const tt = $('tooltip');
  if (i < 0 || i >= cs.length) { tt.hidden = true; return; }
  const c = cs[i];
  const oi = c.d_oi === null || c.d_oi === undefined ? t('no_snapshot') :
    `${c.d_oi >= 0 ? '+' : '−'}${Math.abs(c.d_oi).toFixed(1)} BTC  ${fmtK(c.d_oi_usd)}`;
  tt.textContent =
    `${fmtTs(c.start_ts, isVolumeAgg(S.agg))}\n` +
    `O ${fmtPrice(c.open)}  H ${fmtPrice(c.high)}\nL ${fmtPrice(c.low)}  C ${fmtPrice(c.close)}\n` +
    `Vol    ${fmtK(c.volume_usd, false)}  (${c.volume.toFixed(1)} BTC)\n` +
    `Delta  ${fmtK(c.delta_usd)}  (${c.delta >= 0 ? '+' : '−'}${Math.abs(c.delta).toFixed(1)} BTC)\n` +
    `Trades ${c.trades.toLocaleString('en-US')}\nDur    ${fmtDur(c.duration_ms)}\nΔOI    ${oi}`;
  tt.hidden = false;
  const wrap = $('chart-wrap').getBoundingClientRect();
  const tw = tt.offsetWidth, th = tt.offsetHeight;
  let tx = h.x + 16, ty = h.y + 16;
  if (tx + tw > wrap.width - 4) tx = h.x - tw - 16;
  if (ty + th > wrap.height - 4) ty = h.y - th - 16;
  tt.style.left = `${Math.max(2, tx)}px`; tt.style.top = `${Math.max(2, ty)}px`;
}

// ---------------------------------------------------------------- side panel
const sgn = (v) => v > 0 ? 'pos' : v < 0 ? 'neg' : '';

function updateSide() {
  const st = store();
  const i = S.selected, body = $('detail-body');
  if (i < 0 || i >= st.candles.length) { body.innerHTML = `<span class="muted">${t('click_candle')}</span>`; return; }
  const c = st.candles[i];
  if (!c._full) { body.innerHTML = `<span class="muted">${t('loading_detail')}</span>`; loadDetail(c); return; }
  const vol = isVolumeAgg(S.agg), fc = (S.meta && S.meta.features) || {};
  const zTxt = c.z === null || c.z === undefined ? t('short_history') : c.z.toFixed(3);
  const zLabel = vol ? `${t('z_speed', fc.vol_window || 10)}${c.vspeed !== null && c.vspeed !== undefined ? ` (${fmtDur(Math.exp(-c.vspeed))})` : ''}`
    : `z(ln Vol_USD), N=${fc.n || 30}`;
  const f3 = (v) => fmtNum(v, 3);
  const kv = (rows) => '<table class="kv">' + rows.map(([a, b, cls]) => `<tr class="${cls || ''}"><td>${a}</td><td>${b}</td></tr>`).join('') + '</table>';
  const oiTxt = c.d_oi === null || c.d_oi === undefined ? t('oi_no_boundary') :
    `<span class="${sgn(c.d_oi)}">${c.d_oi >= 0 ? '+' : '−'}${Math.abs(c.d_oi).toFixed(1)} BTC / ${fmtK(c.d_oi_usd)}</span>`;
  const colorTxt = c.color > 0 ? `<span class="pos">${t('green')}</span>` : c.color < 0 ? `<span class="neg">${t('red')}</span>` : 'doji';
  body.innerHTML =
    `<div>${vol ? fmtTs(c.start_ts, true) + ' → ' + fmtTs(c.last_ts, true) : fmtTs(c.start_ts)}</div>` +
    `<h3>${t('candle')}</h3>` + kv([
      ['O / H', `${fmtPrice(c.open)} / ${fmtPrice(c.high)}`], ['L / C', `${fmtPrice(c.low)} / ${fmtPrice(c.close)}`],
      ['Volume', `${fmtK(c.volume_usd, false)} · ${c.volume.toFixed(2)} BTC`],
      ['Buy / Sell', `${fmtK(c.buy_usd, false)} / ${fmtK(c.sell_usd, false)}`],
      ['Delta', `<span class="${sgn(c.delta_usd)}">${fmtK(c.delta_usd)}</span> · ${fmtNum(c.delta_ratio, 3)} vol`],
      ['CVD', `<span class="${sgn(c.cvd_usd)}">${fmtK(c.cvd_usd)}</span>`],
      [t('color_close'), `${colorTxt} · ${fmtNum(c.close_pos, 3)}`],
      ['Trades', c.trades.toLocaleString('en-US')], ['Duration', fmtDur(c.duration_ms)],
      ['ΔOI', oiTxt],
      [t('rel_tod'), c.rel_tod === null || c.rel_tod === undefined ? t('short_history_dash') : c.rel_tod.toFixed(2) + '×'],
      [zLabel, zTxt],
    ]) +
    `<h3>${t('lower_wick')}</h3>` + kv([
      ['Vol(K)', `${fmtK(c.lw_vol_usd, false)} · ${c.lw_vol.toFixed(2)} BTC`],
      ['Buy(K) / Sell(K)', `${fmtK(c.lw_buy_usd, false)} / ${fmtK(c.lw_sell_usd, false)}`],
      [t('vol_share'), f3(c.lw_share)], [t('range_share'), f3(c.lw_range)], [t('conc'), fmtNum(c.lw_conc, 2)],
      ['Δ(K) · Δ(K)/Vol(K)', `<span class="${sgn(c.lw_delta_usd)}">${fmtK(c.lw_delta_usd)}</span> · ${fmtNum(c.lw_delta_ratio, 3)}`],
      [t('sell_in_wick'), f3(c.lw_sell_share)],
    ]) +
    `<h3>${t('upper_wick')}</h3>` + kv([
      ['Vol(K)', `${fmtK(c.uw_vol_usd, false)} · ${c.uw_vol.toFixed(2)} BTC`],
      ['Buy(K) / Sell(K)', `${fmtK(c.uw_buy_usd, false)} / ${fmtK(c.uw_sell_usd, false)}`],
      [t('vol_share'), f3(c.uw_share)], [t('range_share'), f3(c.uw_range)], [t('conc'), fmtNum(c.uw_conc, 2)],
      ['Δ(K) · Δ(K)/Vol(K)', `<span class="${sgn(c.uw_delta_usd)}">${fmtK(c.uw_delta_usd)}</span> · ${fmtNum(c.uw_delta_ratio, 3)}`],
      [t('buy_in_wick'), f3(c.uw_buy_share)],
    ]) + metricsHtml(c);
}

async function loadDetail(c) {
  if (c._loading) return;
  c._loading = true;
  try {
    const js = await fetchJson(`/api/candle?agg=${S.agg}&cid=${c.cid}&start_ts=${c.start_ts}`);
    const row = toRows(js)[0] || {};
    for (const [k, v] of Object.entries(row)) if (!(k in c) || c[k] === undefined) c[k] = v;
    c._full = true;
  } catch (e) { status(t('err_detail') + e.message); }
  finally { c._loading = false; updateSide(); }
}

// Intra-candle order-flow metrics (see README "Metodika").
function metricsHtml(c) {
  const mc = (S.meta && S.meta.metrics) || {};
  const pct = (v) => (v === null || v === undefined) ? '—' : `${(v * 100).toFixed(0)} %`;
  const x = (v, d = 2) => (v === null || v === undefined) ? '—' : `${v.toFixed(d)}×`;
  const num = (v, d = 1) => (v === null || v === undefined) ? '—' : v.toFixed(d);
  const usd = (v) => (v === null || v === undefined) ? '—' : fmtK(v, false);
  const sd = (v) => `<span class="${sgn(v)}">${fmtK(v)}</span>`;
  const auction = (b, s, unf) => `${usd(b)} / ${usd(s)} · ${unf ? t('unfinished') : `<b>${t('finished')}</b>`}`;
  const kv2 = (rows) => '<table class="kv">' + rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('') + '</table>';
  const kv3 = (rows) => '<table class="kv kv3"><tr class="hd"><td></td><td>' + t('lower') + '</td><td>' + t('upper') + '</td></tr>' +
    rows.map(([a, l, h]) => `<tr><td>${a}</td><td>${l}</td><td>${h}</td></tr>`).join('') + '</table>';
  let oiTxt = '—';
  if (c.oi_vol_ratio !== null && c.oi_vol_ratio !== undefined) {
    oiTxt = `<span class="${sgn(c.oi_vol_ratio)}">${(c.oi_vol_ratio * 100).toFixed(1)} %</span> ${t('of_volume')} · ` +
      (c.oi_vol_ratio < 0 ? t('oi_falling') : t('oi_rising'));
  }
  return `<h3>${t('delta_path')}</h3>` + kv2([
    [t('cum_delta'), `${sd(c.dpath_min_usd)} / ${sd(c.dpath_max_usd)}`],
    // ratio only when the extreme is material (>= 1 % of the candle volume), otherwise it explodes
    [t('recov_long'), `${usd(c.d_recov_l_usd)} · ${-c.dpath_min_usd >= 0.01 * c.volume_usd ? pct(c.d_recov_l_ratio) : '—'}`],
    [t('recov_short'), `${usd(c.d_recov_s_usd)} · ${c.dpath_max_usd >= 0.01 * c.volume_usd ? pct(c.d_recov_s_ratio) : '—'}`],
    [t('t_lowhigh'), `${pct(c.t_low_frac)} / ${pct(c.t_high_frac)}`],
    [t('t_dminmax'), `${pct(c.t_dmin_frac)} / ${pct(c.t_dmax_frac)}`],
  ]) +
  `<h3>${t('extremes', S.meta ? S.meta.base_bin : 5)}</h3>` + kv2([
    [t('auction_low'), auction(c.low_buy_usd, c.low_sell_usd, c.unfinished_low)],
    [t('auction_high'), auction(c.high_buy_usd, c.high_sell_usd, c.unfinished_high)],
    [t('exh_low'), `${x(c.exh_low)} / ${x(c.exh_low2)}`],
    [t('exh_high'), `${x(c.exh_high)} / ${x(c.exh_high2)}`],
  ]) +
  `<h3>${t('wicks')}</h3>` + kv3([
    [`imbalance buy (stack) ≥${mc.imbalance_ratio}:1`, `${c.lw_buy_imb} (${c.lw_buy_stack})`, `${c.uw_buy_imb} (${c.uw_buy_stack})`],
    [`imbalance sell (stack)`, `${c.lw_sell_imb} (${c.lw_sell_stack})`, `${c.uw_sell_imb} (${c.uw_sell_stack})`],
    [t('effort'), usd(c.lw_effort), usd(c.uw_effort)],
    [t('vs_body'), x(c.lw_effort_ratio), x(c.uw_effort_ratio)],
    [t('big_trades', mc.big_trade_btc), `${pct(c.lw_big_share)} (${c.lw_big_count})`, `${pct(c.uw_big_share)} (${c.uw_big_count})`],
    [t('big_against'), `sell ${pct(c.lw_big_sell_share)}`, `buy ${pct(c.uw_big_buy_share)}`],
    [t('avg_trade'), usd(c.lw_avg_trade_usd), usd(c.uw_avg_trade_usd)],
    [t('vs_body'), x(c.lw_size_ratio), x(c.uw_size_ratio)],
    [t('trade_rate'), num(c.lw_rate), num(c.uw_rate)],
    [t('vs_body'), x(c.lw_rate_ratio), x(c.uw_rate_ratio)],
    [t('time_in_wick'), pct(c.lw_time_frac), pct(c.uw_time_frac)],
  ]) +
  `<div class="muted small">${t('body_line', usd(c.body_avg_trade_usd), num(c.body_rate), usd(c.body_effort))}</div>` +
  '<h3>Open interest</h3>' + kv2([['ΔOI / volume', oiTxt]]);
}

function updateStatus() {
  const st = store();
  if (st.minDay === null) return;
  const iso = (d) => new Date(d * DAY).toISOString().slice(0, 10);
  const mode = showCells() ? (showText() ? t('mode_text') : t('mode_cells')) : t('mode_candles');
  status(`${S.agg} · data ${iso(st.minDay)} … ${iso(st.maxDay)} UTC · ${mode}`);
}

// ---------------------------------------------------------------- navigation
function visibleCount() { return G.plotW / S.colW; }

async function gotoTime(ts, anchor = 'center') {
  const m = S.meta.aggregations[S.agg];
  if (!m) return;
  const first = dayNum(m.first_day), last = dayNum(m.last_day);
  ts = clamp(ts, first * DAY, (last + 1) * DAY - 1);
  const dn = Math.floor(ts / DAY);
  let st = store();
  if (st.minDay === null || dn < st.minDay - 1 || dn > st.maxDay + 1) {
    st = newStore(); stores.set(S.agg, st);
    await loadDay(dn, st);
  }
  while (st.minDay > Math.max(first, dn - 1)) await loadDay(st.minDay - 1, st);
  while (st.maxDay < Math.min(last, dn + 1)) await loadDay(st.maxDay + 1, st);
  const cs = st.candles;
  let i = cs.findIndex((c) => c.start_ts + 0 >= ts);
  if (i < 0) i = cs.length;
  layout();
  const vc = visibleCount();
  S.rightIdx = anchor === 'right' ? i + 3 : anchor === 'left' ? i + vc * 0.85 : i + vc / 2;
  draw(); updateSide(); ensure();
}

// Load all candles of a date range (days in the display timezone) and show the whole range.
const RANGE_CHUNK_DAYS = 20;
const MAX_RANGE_CANDLES = 150_000;   // browser memory guard (light columns)

async function loadRange(fromIso, toIso) {
  const m = S.meta.aggregations[S.agg];
  if (!m || !fromIso || !toIso) return;
  if (toIso < fromIso) [fromIso, toIso] = [toIso, fromIso];
  const [y0, mo0, d0] = fromIso.split('-').map(Number), [y1, mo1, d1] = toIso.split('-').map(Number);
  const t0 = zonedToUtc(y0, mo0, d0, 0, 0, S.tz), t1 = zonedToUtc(y1, mo1, d1 + 1, 0, 0, S.tz);
  const first = dayNum(m.first_day), last = dayNum(m.last_day);
  const dA = clamp(Math.floor(t0 / DAY), first, last), dB = clamp(Math.floor((t1 - 1) / DAY), first, last);
  const est = Math.round((dB - dA + 1) * m.per_day);
  if (est > MAX_RANGE_CANDLES) {
    const maxDays = Math.floor(MAX_RANGE_CANDLES / m.per_day);
    status(t('range_too_big', S.agg, est.toLocaleString(numLocale()), MAX_RANGE_CANDLES.toLocaleString(numLocale()), maxDays));
    return;
  }
  const st = newStore(), agg = S.agg;
  stores.set(agg, st);
  S.selected = -1;
  const chunks = [];
  for (let d = dA; d <= dB; d += RANGE_CHUNK_DAYS) chunks.push([d, Math.min(dB, d + RANGE_CHUNK_DAYS - 1)]);
  const parts = new Array(chunks.length);
  let done = 0, next = 0;
  status(t('loading_range', agg, fromIso, toIso, 0, chunks.length));
  const worker = async () => {
    while (next < chunks.length) {
      const k = next++, [a, b] = chunks[k];
      parts[k] = toRows(await fetchJson(`/api/candles?agg=${agg}&start=${a * DAY}&end=${(b + 1) * DAY}`));
      status(t('loading_range', agg, fromIso, toIso, ++done, chunks.length));
    }
  };
  try { await Promise.all([worker(), worker(), worker()]); }
  catch (e) { status(t('err_load') + e.message); return; }
  if (stores.get(agg) !== st) return;   // another load started meanwhile
  st.candles = parts.flat(); st.minDay = dA; st.maxDay = dB;
  S.range = { from: fromIso, to: toIso };
  // fit the requested range [t0, t1) into the view
  layout();
  const cs = st.candles;
  let i0 = cs.findIndex((c) => c.start_ts >= t0); if (i0 < 0) i0 = 0;
  let i1 = cs.findIndex((c) => c.start_ts >= t1); if (i1 < 0) i1 = cs.length;
  S.colW = clamp(G.plotW / Math.max(1, i1 - i0), MIN_COLW, 400);
  S.rightIdx = i1; S.autoY = true;
  draw(); updateSide(); ensure();
}

function centerTime() {
  const cs = store().candles;
  if (!cs.length) return null;
  const i = clamp(Math.round(S.rightIdx - visibleCount() / 2), 0, cs.length - 1);
  return cs[i].start_ts;
}

async function setAgg(a) {
  const tc = centerTime();
  S.agg = a; S.selected = -1;
  if (S.range) {   // keep the loaded range when it fits the new aggregation
    const m = S.meta.aggregations[a];
    const days = (dayNum(S.range.to) - dayNum(S.range.from) + 1);
    if (m && days * m.per_day <= MAX_RANGE_CANDLES) { await loadRange(S.range.from, S.range.to); return; }
    const r = S.range;
    S.range = null;
    if (tc !== null) await gotoTime(tc, 'center');
    status(t('range_too_big_agg', r.from, r.to, a, Math.round(days * m.per_day).toLocaleString(numLocale()),
      MAX_RANGE_CANDLES.toLocaleString(numLocale())));
    return;
  }
  if (tc !== null) await gotoTime(tc, 'center');
  else await gotoTime(dayNum(S.meta.aggregations[a].last_day) * DAY + DAY - 1, 'right');
}

// ---------------------------------------------------------------- input
let drag = null;
function hitArea(x, y) {
  if (x > G.plotW && y < G.mainH) return 'price';   // price axis: drag vertically to scale price
  if (y > G.timeTop && x < G.plotW) return 'time';  // time axis: drag horizontally to scale time
  return 'pan';
}
canvas.addEventListener('mousedown', (e) => {
  drag = { x: e.offsetX, y: e.offsetY, right: S.rightIdx, top: S.priceTop, moved: false, vert: false,
           mode: hitArea(e.offsetX, e.offsetY), ppu: S.ppu, colW: S.colW, anchor: priceAt(G.mainH / 2) };
});
window.addEventListener('mouseup', (e) => {
  if (drag && drag.mode === 'pan' && !drag.moved && e.target === canvas && e.offsetX < G.plotW) {
    const i = Math.floor(idxAt(e.offsetX));
    S.selected = i >= 0 && i < store().candles.length ? i : -1;
    updateSide(); draw();
  }
  if (drag && drag.moved) ensure();
  drag = null;
});
canvas.addEventListener('mousemove', (e) => {
  S.hover = { x: e.offsetX, y: e.offsetY };
  const area = drag ? drag.mode : hitArea(e.offsetX, e.offsetY);
  canvas.style.cursor = area === 'price' ? 'ns-resize' : area === 'time' ? 'ew-resize' : (drag ? 'grabbing' : 'crosshair');
  if (drag && drag.mode === 'price') {   // up = zoom in, down = zoom out, around the panel centre
    drag.moved = true;
    S.ppu = clamp(drag.ppu * Math.exp(-(e.offsetY - drag.y) * 0.006), 0.002, 200);
    S.priceTop = drag.anchor + (G.mainH / 2) / S.ppu;
    S.autoY = false;
  } else if (drag && drag.mode === 'time') {   // right = wider candles, anchored at the right edge
    drag.moved = true;
    S.colW = clamp(drag.colW * Math.exp((e.offsetX - drag.x) * 0.006), MIN_COLW, 400);
  } else if (drag) {
    const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    S.rightIdx = drag.right - dx / S.colW;
    if (!drag.vert && Math.abs(dy) > 14) { drag.vert = true; S.autoY = false; drag.top = S.priceTop; drag.y = e.offsetY; }
    if (drag.vert) S.priceTop = drag.top + (e.offsetY - drag.y) / S.ppu;
  }
  draw();
});
canvas.addEventListener('mouseleave', () => { S.hover = null; draw(); });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY || e.deltaX;
  const f = Math.exp(-delta * 0.0015);
  if (e.ctrlKey || e.shiftKey || e.altKey || e.offsetX > G.plotW) {
    const p = priceAt(e.offsetY);
    S.ppu = clamp(S.ppu * f, 0.002, 200);
    S.priceTop = p + e.offsetY / S.ppu;
    S.autoY = false;
  } else {
    const idx = idxAt(e.offsetX);
    S.colW = clamp(S.colW * f, MIN_COLW, 400);
    S.rightIdx = idx + (G.plotW - e.offsetX) / S.colW;
  }
  draw(); ensure();
}, { passive: false });
canvas.addEventListener('dblclick', (e) => {
  const area = hitArea(e.offsetX, e.offsetY);
  if (area === 'price') { S.autoY = true; draw(); return; }        // reset price scale only
  if (area === 'time') { S.colW = DEFAULT_COLW; draw(); ensure(); return; }
  const t = centerTime();
  S.colW = DEFAULT_COLW; S.autoY = true;
  if (t !== null) {
    const i = store().candles.findIndex((c) => c.start_ts >= t);
    S.rightIdx = i + visibleCount() / 2;
  }
  draw(); ensure();
});
new ResizeObserver(() => draw()).observe($('chart-wrap'));

function volLabel(a) {
  const m = /^v(usd|btc)_(\d+(?:\.\d+)?)$/.exec(a);
  if (!m) return a;
  const v = +m[2];
  const usd = v >= 1e9 ? `${+(v / 1e9).toFixed(3)}B` : v >= 1e6 ? `${+(v / 1e6).toFixed(3)}M` : `${+(v / 1e3).toFixed(3)}K`;
  return m[1] === 'usd' ? `Vol ${usd} USD` : `Vol ${v} BTC`;
}

function bindLayers() {
  const btn = $('layers-btn'), pop = $('layers-pop');
  try { Object.assign(S.layers, JSON.parse(localStorage.getItem('fp.layers') || '{}')); } catch (e) { /* storage unavailable */ }
  const sync = () => btn.classList.toggle('on', anyLayer());
  pop.querySelectorAll('input[data-layer]').forEach((cb) => {
    cb.checked = !!S.layers[cb.dataset.layer];
    cb.addEventListener('change', () => {
      S.layers[cb.dataset.layer] = cb.checked; sync();
      try { localStorage.setItem('fp.layers', JSON.stringify(S.layers)); } catch (e) { /* ignore */ }
      draw(); ensure();
    });
  });
  btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
  document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) pop.hidden = true; });
  const sd = S.meta.sessions || { list: [] };
  const tzShort = sd.timezone === 'America/New_York' ? 'NY' : sd.timezone;
  $('sess-def').textContent = `(${sd.list.map((s) => `${s.name} ${s.start}–${s.end}`).join(', ')}, ${tzShort})`;
  $('day-def').textContent = t('day_def');
  sync();
}

function applyTheme(name) {
  C = THEMES[name] || THEMES.dark;
  document.documentElement.dataset.theme = name;
  $('theme-btn').textContent = name === 'dark' ? t('theme_light') : t('theme_dark');
  draw();
}

function applyLang(lang) {
  LANG = lang in I18N ? lang : 'cs';
  applyStaticI18n();
  document.querySelectorAll('#lang-seg button').forEach((b) => b.classList.toggle('on', b.dataset.lang === LANG));
  const custom = document.querySelector('#agg option[value="__custom"]');
  if (custom) custom.textContent = t('custom_threshold');
  if (S.meta) $('day-def').textContent = t('day_def');
  $('theme-btn').textContent = document.documentElement.dataset.theme === 'light' ? t('theme_dark') : t('theme_light');
  draw(); updateSide(); updateStatus();
}

function bindControls() {
  const agg = $('agg');
  const labels = { '1m': 'M1', '5m': 'M5', '15m': 'M15' };
  const names = Object.keys(S.meta.aggregations);
  const order = (a) => a in TF_MIN ? TF_MIN[a] : 1e6;
  for (const a of names.sort((x, y) => order(x) - order(y) || x.localeCompare(y))) {
    const o = document.createElement('option'); o.value = a; o.textContent = labels[a] || volLabel(a); agg.appendChild(o);
  }
  const custom = document.createElement('option'); custom.value = '__custom'; custom.textContent = t('custom_threshold'); agg.appendChild(custom);
  agg.value = S.agg;
  agg.addEventListener('change', () => {
    if (agg.value === '__custom') { $('custom-wrap').hidden = false; return; }
    $('custom-wrap').hidden = true;
    setAgg(agg.value);
  });
  $('custom-go').addEventListener('click', () => customAgg());

  const bin = $('bin');
  for (const b of S.meta.bins) { const o = document.createElement('option'); o.value = b; o.textContent = `${b} USD`; bin.appendChild(o); }
  bin.value = S.bin;
  bin.addEventListener('change', () => { S.bin = +bin.value; draw(); ensure(); });
  $('mode').addEventListener('change', (e) => { S.mode = e.target.value; draw(); });

  const segs = (id, attr, fn) => $(id).querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); fn(b.dataset[attr]);
  }));
  segs('tz-seg', 'tz', (tz) => { S.tz = tz; draw(); updateSide(); ensure(); });
  bindLayers();
  segs('oi-seg', 'oi', (u) => { S.oiUnit = u; draw(); });
  segs('lang-seg', 'lang', (l) => {
    applyLang(l);
    try { localStorage.setItem('fp.lang', LANG); } catch (e) { /* ignore */ }
  });
  let theme = 'dark';
  try { theme = localStorage.getItem('fp.theme') || 'dark'; } catch (e) { /* storage unavailable */ }
  applyTheme(theme);
  $('theme-btn').addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(theme);
    try { localStorage.setItem('fp.theme', theme); } catch (e) { /* ignore */ }
  });
  for (const [id, key] of [['profile-btn', 'profile'], ['dprofile-btn', 'dprofile']]) {   // On/Off, remembered per browser
    try { S[key] = localStorage.getItem('fp.' + key) === '1'; } catch (e) { /* storage unavailable */ }
    const btn = $(id);
    btn.classList.toggle('on', S[key]);
    btn.addEventListener('click', () => {
      S[key] = !S[key]; btn.classList.toggle('on', S[key]);
      try { localStorage.setItem('fp.' + key, S[key] ? '1' : '0'); } catch (e) { /* ignore */ }
      draw();
    });
  }
  document.querySelectorAll('#tz-seg button').forEach((b) => b.classList.toggle('on', b.dataset.tz === S.tz));

  const go = () => loadRange($('range-from').value, $('range-to').value);
  $('range-go').addEventListener('click', go);
  for (const id of ['range-from', 'range-to']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('range-all').addEventListener('click', () => {
    const m = S.meta.aggregations[S.agg];
    $('range-from').value = m.first_day; $('range-to').value = m.last_day;
    go();
  });

}

async function customAgg() {
  const v = +$('custom-value').value, unit = $('custom-unit').value;
  if (!(v > 0)) return;
  try {
    const r = await fetch(`/api/volume?unit=${unit}&value=${v}`, { method: 'POST' });
    if (!r.ok) { status(t('err') + (await r.json()).detail); return; }
    let job = await r.json();
    const agg = job.agg;
    while (job.status === 'running') {   // computed once on the server, then cached on disk
      status(t('computing', agg, job.done, job.total || '?'));
      await new Promise((res) => setTimeout(res, 700));
      job = (await fetchJson('/api/jobs'))[agg] || { status: 'done' };
    }
    if (job.status === 'error') { status(t('err_build', agg, job.error)); return; }
    S.meta = await fetchJson('/api/meta');
    const sel = $('agg');
    if (![...sel.options].some((o) => o.value === agg)) {
      const o = document.createElement('option'); o.value = agg; o.textContent = volLabel(agg);
      sel.insertBefore(o, sel.querySelector('option[value="__custom"]'));
    }
    sel.value = agg; $('custom-wrap').hidden = true;
    await setAgg(agg);
  } catch (e) { status(t('err') + e.message); }
}

async function init() {
  try { applyLang(localStorage.getItem('fp.lang') || 'cs'); } catch (e) { applyLang('cs'); }
  S.meta = await fetchJson('/api/meta');
  S.tz = S.meta.timezone || S.tz;
  S.bin = S.meta.default_bin || S.bin;
  if (!(S.agg in S.meta.aggregations)) S.agg = Object.keys(S.meta.aggregations)[0];
  if (!S.agg) { status(t('no_data')); return; }
  bindControls();
  const last = dayNum(S.meta.aggregations[S.agg].last_day);
  $('range-from').value = new Date((last - 2) * DAY).toISOString().slice(0, 10);
  $('range-to').value = new Date(last * DAY).toISOString().slice(0, 10);
  await gotoTime((last + 1) * DAY - 1, 'right');
}

init().catch((e) => status(t('err') + e.message));
