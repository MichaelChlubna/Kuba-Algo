// Footprint chart engine: data loading per aggregation + Canvas 2D rendering + mouse / touch input.
// A straight port of the original vanilla JS viewer (backend/fp/static/app.js in commit 221e88e) with the
// same algorithms (level of detail, per-pixel merging, lazy loading by UTC day), plus imbalance
// highlighting, VWAP and a visible-range volume profile. Crosshair and tooltip live on a separate overlay
// canvas, so moving the mouse never redraws the chart itself.
import { api, liveSocket, toRows } from '../api/client';
import type { CandleFootprint, CandleFull, Columnar, FootprintRow, LiveMessage, Meta, Period, ProfileResponse } from '../api/types';
import { translate, numLocale, type I18nKey } from '../i18n';
import { aggLabel, fmtDur, fmtK, fmtPrice, fmtTrades, isTimeAgg, TF_MIN } from '../lib/format';
import { imbalances, percentile, rebin, vwap, type Imbalances } from '../lib/footprint';
import { carryDetail, mergeLive } from '../lib/live';
import { DAY, dayNum, fmtTs, isoDay, localInfo, zonedToUtc } from '../lib/time';
import { useSettings, type Settings } from '../store/settings';
import { useUi } from '../store/ui';
import { rgba, themeWith, type RGB, type Theme } from './themes';

const MONO = '"JetBrains Mono", "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace';
export const DEFAULT_COLW = 64;
const MIN_COLW = 0.005; // px per candle (a whole year of M5 fits on screen)
const COMPRESS_BELOW = 1.5; // px per candle; below this, candles are merged per pixel column
const PERIOD_BLOCK_DAYS = 7;
const RANGE_CHUNK_DAYS = 20;
export const MAX_RANGE_CANDLES = 150_000; // browser memory guard (light columns)
const DETAIL_REFRESH_MS = 5000; // detail of the selected open candle is refreshed at most this often
const sameCandle = (a: { cid: number; start_ts: number }, b: { cid: number; start_ts: number }) => a.cid === b.cid && a.start_ts === b.start_ts;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

type Row = CandleFull & { _full?: boolean; _loading?: boolean };

interface Fp extends CandleFootprint { cache: Map<string, CandleFootprint | Imbalances> }

interface Store {
  candles: Row[];
  minDay: number | null;
  maxDay: number | null;
  inflight: Map<number, Promise<void>>;
  fp: Map<number, Fp>;
  fpByDay: Map<number, number[]>;
  fpInflight: Set<number>;
  vwap?: { key: string; values: Float64Array };
  live?: boolean; // live updates reached the last loaded candle: new days may be appended
}

const newStore = (): Store => ({ candles: [], minDay: null, maxDay: null, inflight: new Map(), fp: new Map(), fpByDay: new Map(), fpInflight: new Set() });

interface PeriodRow extends Period { lv: number[]; b: number[]; s: number[] }

interface Geometry {
  W: number; H: number; plotW: number; AX: number; mainH: number; tableTop: number; oiTop: number; oiH: number;
  timeTop: number; ROW: number; TROWS: number; TIME: number;
}

interface Drag {
  x: number; y: number; right: number; top: number; moved: boolean; vert: boolean;
  mode: 'price' | 'time' | 'pan'; ppu: number; colW: number; anchor: number;
}

export class ChartEngine {
  private ctx: CanvasRenderingContext2D;
  private octx: CanvasRenderingContext2D;
  private meta: Meta | null = null;
  private stores = new Map<string, Store>();
  private s: Settings = useSettings.getState();
  private C: Theme = themeWith('dark', undefined);
  private G: Geometry = { W: 0, H: 0, plotW: 0, AX: 76, mainH: 0, tableTop: 0, oiTop: 0, oiH: 0, timeTop: 0, ROW: 16, TROWS: 5, TIME: 20 };
  // view state
  agg = '5m';
  bin = 25;
  tz = 'America/New_York';
  colW = DEFAULT_COLW;
  rightIdx = 0;
  priceTop = 0;
  ppu = 1;
  autoY = true;
  selected = -1;
  private hover: { x: number; y: number } | null = null;
  private hoverMouse = false; // tooltip only for a mouse; on touch the candle detail panel shows the same data
  private range: { from: string; to: string } | null = null;
  private PER = { key: '', map: new Map<string, PeriodRow>(), blocks: new Set<number>(), inflight: new Set<number>() };
  private RVP: { key: string; data: ProfileResponse | null; timer: number | null; inflight: string } = { key: '', data: null, timer: null, inflight: '' };
  private drawPending = false;
  private overlayPending = false;
  private drag: Drag | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; colW: number; idx: number; cx: number } | null = null;
  private unsub: (() => void)[] = [];
  private ro: ResizeObserver;
  private disposed = false;
  private ws: WebSocket | null = null;
  private wsTimer: number | null = null;
  private liveLayersAt = 0;
  private liveKeys = new Set<string>(); // candle columns the live feed sends (light columns)
  private detailAt = 0; // last /api/candle request

  constructor(private canvas: HTMLCanvasElement, private overlay: HTMLCanvasElement, private tooltip: HTMLDivElement) {
    this.ctx = canvas.getContext('2d')!;
    this.octx = overlay.getContext('2d')!;
    this.applySettings(useSettings.getState(), null);
    this.unsub.push(useSettings.subscribe((s, prev) => this.applySettings(s, prev)));
    this.bindInput();
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(canvas.parentElement!);
  }

  dispose() {
    this.disposed = true;
    this.connectLive();
    this.unsub.forEach((u) => u());
    this.ro.disconnect();
    window.removeEventListener('pointerup', this.onPointerUp);
  }

  private t = (key: I18nKey, ...args: (string | number)[]) => translate(this.s.lang, key, ...args);
  private status(msg: string) { useUi.getState().set({ status: msg }); }

  // ---------------------------------------------------------------- settings
  private applySettings(s: Settings, prev: Settings | null) {
    this.s = s;
    this.C = themeWith(s.theme, s.colors[s.theme]);
    if (!prev || !this.meta) return;
    if (s.agg !== prev.agg && s.agg !== this.agg && s.agg in this.meta.aggregations) { void this.setAgg(s.agg); return; }
    if (s.bin !== prev.bin && s.bin) this.bin = s.bin;
    if (s.tz !== prev.tz && s.tz) this.tz = s.tz;
    if (s.lang !== prev.lang) this.updateStatus();
    this.draw();
    this.ensure();
  }

  private store(agg = this.agg): Store {
    let st = this.stores.get(agg);
    if (!st) { st = newStore(); this.stores.set(agg, st); }
    return st;
  }

  // ---------------------------------------------------------------- init / navigation
  async init(meta: Meta) {
    this.meta = meta;
    useUi.getState().set({ live: meta.live ?? null });
    const s = this.s;
    this.tz = s.tz || meta.timezone || this.tz;
    this.bin = s.bin && meta.bins.includes(s.bin) ? s.bin : meta.default_bin || this.bin;
    this.agg = s.agg in meta.aggregations ? s.agg : ('5m' in meta.aggregations ? '5m' : Object.keys(meta.aggregations)[0]);
    if (!this.agg) { this.status(this.t('no_data')); return; }
    if (this.agg !== s.agg) useSettings.getState().set({ agg: this.agg });
    const last = dayNum(meta.aggregations[this.agg].last_day);
    useUi.getState().set({ rangeFrom: isoDay(Math.max(dayNum(meta.aggregations[this.agg].first_day), last - 2)), rangeTo: isoDay(last) });
    await this.gotoTime((last + 1) * DAY - 1, 'right');
    this.connectLive();
  }

  setMeta(meta: Meta) { this.meta = meta; }

  private visibleCount() { return this.G.plotW / this.colW; }

  async gotoTime(ts: number, anchor: 'center' | 'right' | 'left' = 'center') {
    const m = this.meta?.aggregations[this.agg];
    if (!m) return;
    const first = dayNum(m.first_day), last = dayNum(m.last_day);
    ts = clamp(ts, first * DAY, (last + 1) * DAY - 1);
    const dn = Math.floor(ts / DAY);
    let st = this.store();
    if (st.minDay === null || dn < st.minDay - 1 || dn > st.maxDay! + 1) {
      st = newStore(); this.stores.set(this.agg, st);
      await this.loadDay(dn, st);
    }
    while (st.minDay! > Math.max(first, dn - 1)) await this.loadDay(st.minDay! - 1, st);
    while (st.maxDay! < Math.min(last, dn + 1)) await this.loadDay(st.maxDay! + 1, st);
    const cs = st.candles;
    let i = cs.findIndex((c) => c.start_ts >= ts);
    if (i < 0) i = cs.length;
    this.layout();
    const vc = this.visibleCount();
    this.rightIdx = anchor === 'right' ? i + 3 : anchor === 'left' ? i + vc * 0.85 : i + vc / 2;
    this.draw(); this.publishSelected(); this.ensure();
  }

  /** Load all candles of a date range (days in the display timezone) and show the whole range. */
  async loadRange(fromIso: string, toIso: string) {
    const m = this.meta?.aggregations[this.agg];
    if (!m || !fromIso || !toIso) return;
    if (toIso < fromIso) [fromIso, toIso] = [toIso, fromIso];
    const [y0, mo0, d0] = fromIso.split('-').map(Number), [y1, mo1, d1] = toIso.split('-').map(Number);
    const t0 = zonedToUtc(y0, mo0, d0, 0, 0, this.tz), t1 = zonedToUtc(y1, mo1, d1 + 1, 0, 0, this.tz);
    const first = dayNum(m.first_day), last = dayNum(m.last_day);
    const dA = clamp(Math.floor(t0 / DAY), first, last), dB = clamp(Math.floor((t1 - 1) / DAY), first, last);
    const est = Math.round((dB - dA + 1) * m.per_day);
    const loc = numLocale(this.s.lang);
    if (est > MAX_RANGE_CANDLES) {
      this.status(this.t('range_too_big', this.agg, est.toLocaleString(loc), MAX_RANGE_CANDLES.toLocaleString(loc), Math.floor(MAX_RANGE_CANDLES / m.per_day)));
      return;
    }
    const st = newStore(), agg = this.agg;
    this.stores.set(agg, st);
    this.selected = -1;
    const chunks: [number, number][] = [];
    for (let d = dA; d <= dB; d += RANGE_CHUNK_DAYS) chunks.push([d, Math.min(dB, d + RANGE_CHUNK_DAYS - 1)]);
    const parts: Row[][] = new Array(chunks.length);
    let done = 0, next = 0;
    this.status(this.t('loading_range', agg, fromIso, toIso, 0, chunks.length));
    const worker = async () => {
      while (next < chunks.length) {
        const k = next++, [a, b] = chunks[k];
        parts[k] = toRows(await api.candles<Row>(agg, a * DAY, (b + 1) * DAY));
        this.status(this.t('loading_range', agg, fromIso, toIso, ++done, chunks.length));
      }
    };
    try { await Promise.all([worker(), worker(), worker()]); }
    catch (e) { this.status(this.t('err_load') + (e as Error).message); return; }
    if (this.stores.get(agg) !== st) return; // another load started meanwhile
    st.candles = parts.flat(); st.minDay = dA; st.maxDay = dB;
    this.range = { from: fromIso, to: toIso };
    this.layout();
    const cs = st.candles;
    let i0 = cs.findIndex((c) => c.start_ts >= t0); if (i0 < 0) i0 = 0;
    let i1 = cs.findIndex((c) => c.start_ts >= t1); if (i1 < 0) i1 = cs.length;
    this.colW = clamp(this.G.plotW / Math.max(1, i1 - i0), MIN_COLW, 400);
    this.rightIdx = i1; this.autoY = true;
    this.draw(); this.publishSelected(); this.ensure();
  }

  loadAll() {
    const m = this.meta?.aggregations[this.agg];
    if (!m) return;
    useUi.getState().set({ rangeFrom: m.first_day, rangeTo: m.last_day });
    return this.loadRange(m.first_day, m.last_day);
  }

  private centerTime(): number | null {
    const cs = this.store().candles;
    if (!cs.length) return null;
    return cs[clamp(Math.round(this.rightIdx - this.visibleCount() / 2), 0, cs.length - 1)].start_ts;
  }

  async setAgg(a: string) {
    if (!this.meta?.aggregations[a]) return;
    const tc = this.centerTime();
    this.agg = a; this.selected = -1;
    this.connectLive();
    if (useSettings.getState().agg !== a) useSettings.getState().set({ agg: a });
    if (this.range) { // keep the loaded range when it fits the new aggregation
      const m = this.meta.aggregations[a];
      const days = dayNum(this.range.to) - dayNum(this.range.from) + 1;
      if (days * m.per_day <= MAX_RANGE_CANDLES) { await this.loadRange(this.range.from, this.range.to); return; }
      const r = this.range;
      this.range = null;
      if (tc !== null) await this.gotoTime(tc, 'center');
      const loc = numLocale(this.s.lang);
      this.status(this.t('range_too_big_agg', r.from, r.to, a, Math.round(days * m.per_day).toLocaleString(loc), MAX_RANGE_CANDLES.toLocaleString(loc)));
      return;
    }
    if (tc !== null) await this.gotoTime(tc, 'center');
    else await this.gotoTime(dayNum(this.meta.aggregations[a].last_day) * DAY + DAY - 1, 'right');
  }

  /** Build (once, server side) and switch to a custom volume / tick threshold. */
  async customAgg(unit: 'usd' | 'btc' | 'tick', value: number): Promise<string | null> {
    if (!(value > 0)) return null;
    try {
      let job = await api.buildVolume(unit, value);
      const agg = job.agg;
      while (job.status === 'running') { // computed once on the server, then cached on disk
        this.status(this.t('computing', agg, job.done ?? 0, job.total || '?'));
        await new Promise((res) => setTimeout(res, 700));
        job = { agg, ...((await api.jobs())[agg] ?? { status: 'done' }) };
      }
      if (job.status === 'error') { this.status(this.t('err_build', agg, job.error ?? '')); return null; }
      const meta = await api.meta();
      this.meta = meta;
      useUi.getState().set({ meta });
      await this.setAgg(agg);
      return agg;
    } catch (e) {
      const msg = (e as Error).message;
      this.status(msg.startsWith('429') ? this.t('too_many_jobs') : this.t('err') + msg);
      return null;
    }
  }

  // ---------------------------------------------------------------- data loading
  private loadDay(dn: number, st = this.store(), agg = this.agg): Promise<void> {
    // one request per day; concurrent callers await the same promise
    const pending = st.inflight.get(dn);
    if (pending) return pending;
    const p = (async () => {
      try {
        const rows = toRows(await api.candles<Row>(agg, dn * DAY, (dn + 1) * DAY));
        const current = this.stores.get(this.agg) === st;
        if (st.minDay === null) { st.candles = rows; st.minDay = st.maxDay = dn; }
        else if (dn === st.minDay - 1) {
          st.candles = rows.concat(st.candles); st.minDay = dn;
          if (current) { this.rightIdx += rows.length; if (this.selected >= 0) this.selected += rows.length; }
        } else if (dn === st.maxDay! + 1) { st.candles = st.candles.concat(rows); st.maxDay = dn; }
        else return;
        st.vwap = undefined;
        if (current) { this.draw(); this.publishSelected(); }
      } catch (e) { this.status(this.t('err_load') + (e as Error).message); throw e; }
      finally {
        st.inflight.delete(dn);
        if (this.stores.get(this.agg) === st) setTimeout(() => this.ensure(), 0);
      }
    })();
    st.inflight.set(dn, p);
    return p;
  }

  private async loadFp(dn: number, st = this.store(), agg = this.agg) {
    st.fpInflight.add(dn);
    try {
      const js = await api.footprint<FootprintRow>(agg, dn * DAY, (dn + 1) * DAY);
      const c = js.cols, n = js.n, list: number[] = [];
      let i = 0;
      while (i < n) {
        const id = c.cid[i];
        let j = i;
        while (j < n && c.cid[j] === id) j++;
        st.fp.set(id, { lv: c.level.slice(i, j), b: c.buy_usd.slice(i, j), s: c.sell_usd.slice(i, j), cache: new Map() });
        list.push(id);
        i = j;
      }
      st.fpByDay.set(dn, list);
      if (this.stores.get(this.agg) === st) this.draw();
    } catch (e) { this.status(this.t('err_fp') + (e as Error).message); }
    finally { st.fpInflight.delete(dn); }
  }

  private ensure() {
    if (this.disposed) return;
    const st = this.store(), m = this.meta?.aggregations[this.agg];
    if (!m || st.minDay === null) return;
    const first = dayNum(m.first_day), last = dayNum(m.last_day);
    const [l, r] = this.visRange();
    const n = st.candles.length;
    if (st.inflight.size === 0) {
      if (l < 20 && st.minDay > first) this.loadDay(st.minDay - 1, st).catch(() => {});
      else if (r > n - 20 && st.maxDay! < last) this.loadDay(st.maxDay! + 1, st).catch(() => {});
    }
    if (this.showCells() && n) {
      const d0 = Math.floor(st.candles[clamp(l, 0, n - 1)].start_ts / DAY);
      const d1 = Math.floor(st.candles[clamp(r, 0, n - 1)].start_ts / DAY);
      for (let d = d0; d <= d1; d++) {
        if (!st.fpByDay.has(d) && !st.fpInflight.has(d) && st.fpInflight.size < 2) void this.loadFp(d, st);
      }
      // evict footprint days far from the view (bounded memory over long ranges)
      for (const [d, list] of st.fpByDay) {
        if (d < d0 - 3 || d > d1 + 3) { for (const id of list) st.fp.delete(id); st.fpByDay.delete(d); }
      }
    }
    this.ensurePeriods();
    this.ensureRangeProfile();
    this.updateStatus();
  }

  // ---------------------------------------------------------------- sessions / days (server: /api/periods)
  private anyPeriodLayer() {
    const L = this.s.layers;
    return L.sess || L.sessHL || L.sessVP || L.sessDP || L.dayHL || L.dayVP || L.dayDP;
  }

  private ensurePeriods() {
    if (!this.anyPeriodLayer()) return;
    const PER = this.PER;
    const key = `${this.tz}|${this.bin}`; // days follow the display tz, profile levels the display bin
    if (PER.key !== key) { PER.key = key; PER.map = new Map(); PER.blocks = new Set(); PER.inflight = new Set(); }
    const cs = this.store().candles;
    if (!cs.length) return;
    const [l, r] = this.visRange();
    const b0 = Math.floor(cs[l].start_ts / DAY / PERIOD_BLOCK_DAYS), b1 = Math.floor(cs[r].start_ts / DAY / PERIOD_BLOCK_DAYS);
    for (let b = b0; b <= b1; b++) {
      if (PER.blocks.has(b) || PER.inflight.has(b) || PER.inflight.size >= 2) continue;
      void this.loadPeriods(b, key);
    }
  }

  private async loadPeriods(b: number, key: string) {
    const PER = this.PER;
    PER.inflight.add(b);
    try {
      const s = b * PERIOD_BLOCK_DAYS * DAY, e = (b + 1) * PERIOD_BLOCK_DAYS * DAY;
      const js = await api.periods(s, e, this.tz, this.bin);
      if (PER.key !== key) return;
      const byId = new Map<string, PeriodRow>();
      for (const p of toRows(js.periods)) byId.set(p.id, { ...p, lv: [], b: [], s: [] });
      const L = js.levels.cols;
      for (let i = 0; i < js.levels.n; i++) {
        const p = byId.get(L.id[i]);
        if (p) { p.lv.push(L.level[i]); p.b.push(L.buy_usd[i]); p.s.push(L.sell_usd[i]); }
      }
      for (const [id, p] of byId) PER.map.set(id, p);
      PER.blocks.add(b);
      this.draw();
    } catch (e) { this.status(this.t('err_periods') + (e as Error).message); }
    finally { PER.inflight.delete(b); setTimeout(() => this.ensurePeriods(), 0); }
  }

  // ---------------------------------------------------------------- visible range profile (server: /api/profile)
  private ensureRangeProfile() {
    if (!this.s.layers.rangeVP) return;
    const cs = this.store().candles;
    if (!cs.length) return;
    const [l, r] = this.visRange();
    const t0 = cs[l].start_ts, t1 = Math.max(cs[r].end_ts, cs[r].start_ts + 1);
    const key = `${t0}|${t1}|${this.bin}`;
    if (key === this.RVP.key || key === this.RVP.inflight) return;
    if (this.RVP.timer !== null) clearTimeout(this.RVP.timer);
    this.RVP.timer = window.setTimeout(async () => { // debounce while panning / zooming
      this.RVP.timer = null;
      this.RVP.inflight = key;
      try {
        const data = await api.profile(t0, t1, this.bin);
        if (this.RVP.inflight === key) { this.RVP = { ...this.RVP, key, data, inflight: '' }; this.draw(); }
      } catch (e) { this.RVP.inflight = ''; this.status(this.t('err') + (e as Error).message); }
    }, 220);
  }

  // ---------------------------------------------------------------- live data (WebSocket /api/live)
  /** (Re)connect the live stream of the current aggregation; closes it when live data are off or on dispose. */
  private connectLive() {
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    if (this.wsTimer !== null) { clearTimeout(this.wsTimer); this.wsTimer = null; }
    if (this.disposed || !this.meta?.live) return;
    const agg = this.agg;
    this.ws = liveSocket(agg, (m) => this.applyLive(m), () => {
      this.ws = null;
      const prev = useUi.getState().live ?? this.meta!.live!;
      useUi.getState().set({ live: { ...prev, state: 'reconnecting' } });
      if (!this.disposed && this.agg === agg) this.wsTimer = window.setTimeout(() => this.connectLive(), 3000);
    });
  }

  private applyLive(m: LiveMessage) {
    useUi.getState().set({ live: m.status });
    const st = this.stores.get(m.agg);
    if (!m.candles?.n || !st || st.maxDay === null) return;
    const rows = toRows(m.candles) as Row[];
    for (const k of Object.keys(m.candles.cols)) this.liveKeys.add(k);
    const current = this.stores.get(this.agg) === st;
    const follow = current && this.rightIdx >= st.candles.length - 1; // the newest candle is in view
    const res = mergeLive(st.candles, rows, st.maxDay, () => st.live === true);
    if (res.appended + res.replaced === 0) return;
    st.live = true;
    const lastDay = Math.floor(st.candles[st.candles.length - 1].start_ts / DAY);
    if (lastDay > st.maxDay) {
      st.maxDay = lastDay;
      const am = this.meta?.aggregations[m.agg];
      if (am && dayNum(am.last_day) < lastDay) am.last_day = isoDay(lastDay);
    }
    if (m.fp) this.applyLiveFp(st, m.fp);
    st.vwap = undefined;
    if (!current) return;
    if (follow) this.rightIdx += res.appended;
    if (res.appended) this.refreshLiveLayers();
    if (this.selected >= 0) this.publishSelected();
    this.draw();
  }

  /** Footprint of live candles; days whose footprint is not loaded yet are left to ensure() (REST). */
  private applyLiveFp(st: Store, fp: Columnar<FootprintRow>) {
    const c = fp.cols, n = fp.n;
    let i = 0;
    while (i < n) {
      const id = c.cid[i];
      let j = i;
      while (j < n && c.cid[j] === id) j++;
      const day = Math.floor(c.start_ts[i] / DAY), list = st.fpByDay.get(day);
      if (list) {
        if (!st.fp.has(id)) list.push(id);
        st.fp.set(id, { lv: c.level.slice(i, j), b: c.buy_usd.slice(i, j), s: c.sell_usd.slice(i, j), cache: new Map() });
      }
      i = j;
    }
  }

  /** Sessions / days and the range profile of the live day, refreshed at most every 15 s. */
  private refreshLiveLayers() {
    const now = Date.now();
    if (now - this.liveLayersAt < 15_000) return;
    this.liveLayersAt = now;
    const last = this.store().candles[this.store().candles.length - 1];
    if (last) this.PER.blocks.delete(Math.floor(last.start_ts / DAY / PERIOD_BLOCK_DAYS));
    this.RVP.key = '';
    this.ensure();
  }

  // ---------------------------------------------------------------- geometry
  private layout() {
    const G = this.G, L = this.s.layout;
    const r = this.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    G.W = r.width; G.H = r.height;
    for (const [cv, cx] of [[this.canvas, this.ctx], [this.overlay, this.octx]] as const) {
      if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) {
        cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
      }
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    G.AX = G.W < 520 ? 62 : 76;
    G.plotW = G.W - G.AX;
    G.timeTop = G.H - G.TIME;
    G.oiH = L.oi ? Math.max(56, Math.round(G.H * 0.11)) : 0;
    G.oiTop = G.timeTop - G.oiH - (L.oi ? 2 : 0);
    G.TROWS = L.table ? 5 : 0;
    G.tableTop = G.oiTop - (L.table ? 6 : 0) - G.ROW * G.TROWS;
    G.mainH = G.tableTop - 6;
  }

  private xOf = (i: number) => this.G.plotW - (this.rightIdx - i) * this.colW;
  private idxAt = (x: number) => this.rightIdx - (this.G.plotW - x) / this.colW;
  private yOf = (p: number) => (this.priceTop - p) * this.ppu;
  private priceAt = (y: number) => this.priceTop - y / this.ppu;

  private visRange(): [number, number] {
    const n = this.store().candles.length;
    return [clamp(Math.floor(this.idxAt(0)), 0, Math.max(0, n - 1)), clamp(Math.ceil(this.rightIdx), 0, Math.max(0, n - 1))];
  }

  private rowH = () => this.bin * this.ppu;
  private showCells = () => this.colW >= 12 && this.rowH() >= 3;
  private showText = () => this.colW >= 40 && this.rowH() >= 10;
  private compressed = () => this.colW < COMPRESS_BELOW;

  private autoFitY() {
    const st = this.store(), [l, r] = this.visRange();
    let lo = Infinity, hi = -Infinity;
    for (let i = l; i <= r && i < st.candles.length; i++) { lo = Math.min(lo, st.candles[i].low); hi = Math.max(hi, st.candles[i].high); }
    if (!isFinite(lo)) return;
    const pad = (hi - lo) * 0.06 + this.bin;
    this.ppu = this.G.mainH / Math.max(hi - lo + 2 * pad, 1);
    this.priceTop = hi + pad;
  }

  private timeToX(ts: number) {
    const cs = this.store().candles;
    let lo = 0, hi = cs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cs[m].start_ts < ts) lo = m + 1; else hi = m; }
    return this.xOf(lo);
  }

  private fpFor(c: Row, bin: number): CandleFootprint | null {
    const f = this.store().fp.get(c.cid);
    if (!f) return null;
    const key = `b${bin}`;
    let r = f.cache.get(key) as CandleFootprint | undefined;
    if (!r) { r = rebin(f, bin); f.cache.set(key, r); }
    return r;
  }

  private imbFor(c: Row, f: CandleFootprint, bin: number): Imbalances {
    const im = this.s.imbalance, key = `i${bin}|${im.ratioPct}|${im.minUsd}|${im.stackMin}`;
    const cache = this.store().fp.get(c.cid)!.cache;
    let r = cache.get(key) as Imbalances | undefined;
    if (!r) { r = imbalances(f, bin, { ratio: im.ratioPct / 100, minUsd: im.minUsd, stackMin: im.stackMin }); cache.set(key, r); }
    return r;
  }

  // ---------------------------------------------------------------- drawing
  draw() {
    if (this.drawPending || this.disposed) return;
    this.drawPending = true;
    requestAnimationFrame(() => { this.drawPending = false; this.render(); this.renderOverlay(); });
  }

  private drawOverlay() {
    if (this.overlayPending || this.disposed) return;
    this.overlayPending = true;
    requestAnimationFrame(() => { this.overlayPending = false; this.renderOverlay(); });
  }

  private render() {
    this.layout();
    const { ctx, G, C } = this;
    const st = this.store(), cs = st.candles, n = cs.length;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, G.W, G.H);
    if (!n) { ctx.fillStyle = C.dim; ctx.font = `13px ${MONO}`; ctx.fillText(this.t('loading'), 20, 40); return; }
    if (this.autoY) this.autoFitY();
    const [l, r] = this.visRange();
    const cells = this.showCells(), text = this.showText();

    // price grid + axis
    const step = niceStep(28 / this.ppu);
    ctx.font = `11px ${MONO}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const pLo = this.priceAt(G.mainH), pHi = this.priceTop;
    for (let p = Math.ceil(pLo / step) * step; p <= pHi; p += step) {
      const y = Math.round(this.yOf(p)) + 0.5;
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(G.plotW, y); ctx.stroke();
      ctx.fillStyle = C.axis; ctx.fillText(p.toFixed(step < 1 ? 1 : 0), G.plotW + 6, y);
    }

    // main panel
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, G.plotW, G.mainH); ctx.clip();
    if (this.selected >= l && this.selected <= r) {
      ctx.fillStyle = C.selFill; ctx.fillRect(this.xOf(this.selected), 0, this.colW, G.mainH);
    }
    this.drawSessionBands();
    if (this.s.layers.rangeVP) this.drawRangeProfile();
    if (cells) this.drawCells(cs, l, r, text); else this.drawCandlesWide(cs, l, r);
    this.drawPeriodOverlays();
    if (this.s.layers.vwap) this.drawVwap(cs, l, r);
    this.drawSelection(cs);
    this.drawPocMarkers(cs);
    ctx.restore();

    this.drawAxisTags(cs);
    if (G.TROWS) this.drawTable(cs, l, r);
    if (G.oiH) this.drawOi(cs, l, r);
    this.drawTimeAxis(cs, l, r);

    ctx.strokeStyle = C.sep;
    ctx.beginPath(); ctx.moveTo(G.plotW + 0.5, 0); ctx.lineTo(G.plotW + 0.5, G.H); ctx.stroke();
    useUi.getState().cellMode !== (cells ? (text ? 'text' : 'cells') : 'candles') &&
      useUi.getState().set({ cellMode: cells ? (text ? 'text' : 'cells') : 'candles' });
  }

  private candleColor(c: Row) { const C = this.C; return c.close > c.open ? C.green : c.close < c.open ? C.red : C.neutral; }

  private drawCandle(c: Row, x: number, w: number) {
    const ctx = this.ctx, col = this.candleColor(c), cx = Math.round(x + w / 2) + 0.5;
    ctx.strokeStyle = rgba(col, 1); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, this.yOf(c.high)); ctx.lineTo(cx, this.yOf(c.low)); ctx.stroke();
    const y1 = this.yOf(Math.max(c.open, c.close)), y2 = this.yOf(Math.min(c.open, c.close));
    ctx.fillStyle = rgba(col, 1);
    ctx.fillRect(Math.round(x), y1, Math.max(1, Math.round(w)), Math.max(1, y2 - y1));
  }

  /** visible candles grouped by pixel column: [{px, i0, i1}] */
  private pixelGroups(l: number, r: number) {
    const out: { px: number; i0: number; i1: number }[] = [];
    let cur: { px: number; i0: number; i1: number } | null = null;
    for (let i = l; i <= r; i++) {
      const px = Math.floor(this.xOf(i));
      if (cur && cur.px === px) cur.i1 = i;
      else { cur = { px, i0: i, i1: i }; out.push(cur); }
    }
    return out;
  }

  private drawCandlesWide(cs: Row[], l: number, r: number) {
    const { ctx, C } = this;
    if (this.compressed()) { // one bar per pixel: high/low of the group, colour by group open -> close
      for (const g of this.pixelGroups(l, r)) {
        let hi = -Infinity, lo = Infinity;
        for (let i = g.i0; i <= g.i1; i++) { hi = Math.max(hi, cs[i].high); lo = Math.min(lo, cs[i].low); }
        const o = cs[g.i0].open, c = cs[g.i1].close;
        ctx.fillStyle = rgba(c > o ? C.green : c < o ? C.red : C.neutral, 1);
        const y1 = this.yOf(hi);
        ctx.fillRect(g.px, y1, 1, Math.max(1, this.yOf(lo) - y1));
      }
      return;
    }
    const w = Math.max(1, this.colW * 0.65);
    for (let i = l; i <= r; i++) this.drawCandle(cs[i], this.xOf(i) + (this.colW - w) / 2, w);
  }

  private drawCells(cs: Row[], l: number, r: number, text: boolean) {
    const { ctx, C, G } = this;
    const bin = this.bin, rh = this.rowH(), mode = this.s.mode, imbOn = this.s.imbalance.show;
    const candleW = clamp(Math.round(this.colW * 0.1), 3, 7);
    // intensity scale: 95th percentile of the visible values
    const vals: number[] = [];
    for (let i = l; i <= r; i++) {
      const f = this.fpFor(cs[i], bin);
      if (!f) continue;
      for (let k = 0; k < f.lv.length; k++) {
        if (mode === 'delta') vals.push(Math.abs(f.b[k] - f.s[k]));
        else if (mode === 'volume') vals.push(f.b[k] + f.s[k]);
        else vals.push(f.b[k], f.s[k]);
      }
    }
    const p95 = percentile(vals, 0.95);
    const fs = Math.min(12, Math.floor(rh * 0.78));
    const font = `${fs}px ${MONO}`, bold = `bold ${fs}px ${MONO}`;
    ctx.font = font; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    const alphaOf = (v: number) => { const a = Math.min(1, v / p95); return a < 0.12 ? 0 : 0.15 + (C.fillMax - 0.15) * a; };

    for (let i = l; i <= r; i++) {
      const c = cs[i], x = this.xOf(i);
      const cx0 = x + candleW + 3, cw = this.colW - candleW - 5;
      this.drawCandle(c, x + 1, candleW);
      const f = this.fpFor(c, bin);
      if (!f || cw < 3) continue;
      const im = imbOn ? this.imbFor(c, f, bin) : null;
      for (let k = 0; k < f.lv.length; k++) {
        const yT = this.yOf(f.lv[k] + bin), y0 = Math.round(yT) + 0.5, h = Math.max(1, Math.round(yT + rh) - Math.round(yT) - 1);
        if (y0 > G.mainH || y0 + h < 0) continue;
        const b = f.b[k], s = f.s[k], d = b - s;
        const ib = im?.buy[k], is = im?.sell[k];
        if (mode === 'sellbuy') {
          const half = cw / 2;
          let a = alphaOf(s); if (a) { ctx.fillStyle = rgba(C.red, a); ctx.fillRect(cx0, y0, half - 0.5, h); }
          a = alphaOf(b); if (a) { ctx.fillStyle = rgba(C.green, a); ctx.fillRect(cx0 + half + 0.5, y0, half - 0.5, h); }
          if (is) this.imbFrame(cx0, y0, half - 0.5, h, C.red);
          if (ib) this.imbFrame(cx0 + half + 0.5, y0, half - 0.5, h, C.green);
          if (text && cw >= 76) {
            ctx.font = is ? bold : font; ctx.fillStyle = is ? rgba(C.red, 1) : C.text;
            ctx.fillText(fmtK(s, false), cx0 + half / 2, y0 + h / 2);
            ctx.font = ib ? bold : font; ctx.fillStyle = ib ? rgba(C.green, 1) : C.text;
            ctx.fillText(fmtK(b, false), cx0 + half * 1.5, y0 + h / 2);
            ctx.font = font;
          }
        } else {
          const v = mode === 'delta' ? Math.abs(d) : b + s;
          const a = alphaOf(v);
          if (a) { ctx.fillStyle = rgba(mode === 'volume' ? C.blue : d >= 0 ? C.green : C.red, a); ctx.fillRect(cx0, y0, cw, h); }
          // imbalance: a marker on the aggressive side (sell left, buy right)
          const mw = clamp(Math.round(cw * 0.06), 2, 4);
          if (is) { ctx.fillStyle = rgba(C.red, 1); ctx.fillRect(cx0, y0, mw, h); }
          if (ib) { ctx.fillStyle = rgba(C.green, 1); ctx.fillRect(cx0 + cw - mw, y0, mw, h); }
          if (text) {
            const tx = mode === 'delta' ? fmtK(d) : fmtK(b + s, false);
            ctx.font = ib || is ? bold : font;
            ctx.fillStyle = a ? C.cellText : C.dim;
            if (ctx.measureText(tx).width < cw - 2) ctx.fillText(tx, cx0 + cw / 2, y0 + h / 2);
            ctx.font = font;
          }
        }
      }
      if (im) this.drawStacks(f, im, cx0, cw, bin);
      if (this.s.profile) this.drawProfile(f, cx0, cw, bin);
      if (this.s.dprofile) this.drawDeltaProfile(f, cx0, cw, bin);
    }
  }

  private imbFrame(x: number, y: number, w: number, h: number, col: RGB) {
    if (w < 3 || h < 3) return;
    const ctx = this.ctx;
    ctx.strokeStyle = rgba(col, 0.9);
    ctx.strokeRect(Math.round(x) + 1.5, y + 0.5, Math.round(w) - 3, h - 1);
  }

  /** Stacked imbalances: a bar beside the cells over the run (sell left, buy right). */
  private drawStacks(f: CandleFootprint, im: Imbalances, cx0: number, cw: number, bin: number) {
    const ctx = this.ctx;
    for (const [runs, col, x] of [[im.sellStacks, this.C.red, cx0 - 3], [im.buyStacks, this.C.green, cx0 + cw + 1]] as const) {
      for (const [a, b] of runs) {
        const yTop = this.yOf(f.lv[b] + bin), yBot = this.yOf(f.lv[a]);
        ctx.fillStyle = rgba(col, 0.95);
        ctx.fillRect(Math.round(x), Math.round(yTop) + 1, 2, Math.max(2, Math.round(yBot - yTop) - 1));
      }
    }
  }

  /** Smoothed curve through points (quadratic midpoint interpolation), continuing the current path. */
  private traceCurve(pts: { x: number; y: number }[]) {
    const ctx = this.ctx;
    ctx.lineTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  }

  /** Delta profile of one candle around a vertical zero line in the middle of the cell area. */
  private drawDeltaProfile(f: CandleFootprint, cx0: number, cw: number, bin: number) {
    const { ctx, C } = this;
    const n = f.lv.length;
    if (!n || cw < 8) return;
    const dl = new Map<number, number>();
    let m = 0;
    for (let k = 0; k < n; k++) { const d = f.b[k] - f.s[k]; dl.set(f.lv[k], d); m = Math.max(m, Math.abs(d)); }
    if (!m) return;
    const mid = cx0 + cw / 2, half = (cw / 2) * 0.92, lo = f.lv[0], hi = f.lv[n - 1], pts: { x: number; y: number }[] = [];
    let neg: { x: number; y: number } | null = null, pos: { x: number; y: number } | null = null, dmin = 0, dmax = 0;
    for (let L = lo; L <= hi; L += bin) {
      const d = dl.get(L) || 0;
      const pt = { x: mid + (d / m) * half, y: this.yOf(L + bin / 2) };
      pts.push(pt);
      if (d < dmin) { dmin = d; neg = pt; }
      if (d > dmax) { dmax = d; pos = pt; }
    }
    const yBot = this.yOf(lo), yTop = this.yOf(hi + bin);
    ctx.strokeStyle = rgba(C.dprof, 0.45); ctx.setLineDash([2, 2]); // zero line
    ctx.beginPath(); ctx.moveTo(Math.round(mid) + 0.5, yBot); ctx.lineTo(Math.round(mid) + 0.5, yTop); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(mid, yBot); this.traceCurve(pts); ctx.lineTo(mid, yTop); ctx.closePath();
    ctx.fillStyle = rgba(C.dprof, 0.16); ctx.fill();
    ctx.beginPath(); ctx.moveTo(mid, yBot); this.traceCurve(pts); ctx.lineTo(mid, yTop);
    ctx.strokeStyle = rgba(C.dprof, 0.95); ctx.lineWidth = 1.3; ctx.stroke(); ctx.lineWidth = 1;
    for (const [pt, col] of [[neg, C.red], [pos, C.green]] as const) {
      if (!pt) continue;
      ctx.fillStyle = rgba(col, 1); ctx.strokeStyle = C.bg; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  /** Volume profile of one candle, drawn from the left edge of the cell area. */
  private drawProfile(f: CandleFootprint, cx0: number, cw: number, bin: number) {
    const { ctx, C } = this;
    const n = f.lv.length;
    if (!n || cw < 8) return;
    const vol = new Map<number, number>();
    let m = 0;
    for (let k = 0; k < n; k++) { const v = f.b[k] + f.s[k]; vol.set(f.lv[k], v); m = Math.max(m, v); }
    if (!m) return;
    const w = cw * 0.92, lo = f.lv[0], hi = f.lv[n - 1], pts: { x: number; y: number }[] = [];
    let poc: { x: number; y: number } | null = null;
    for (let L = lo; L <= hi; L += bin) {
      const v = vol.get(L) || 0;
      const pt = { x: cx0 + (v / m) * w, y: this.yOf(L + bin / 2) };
      pts.push(pt);
      if (v === m && !poc) poc = pt;
    }
    const yBot = this.yOf(lo), yTop = this.yOf(hi + bin);
    ctx.beginPath(); ctx.moveTo(cx0, yBot); this.traceCurve(pts); ctx.lineTo(cx0, yTop); ctx.closePath();
    ctx.fillStyle = rgba(C.vprof, 0.16); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx0, yBot); this.traceCurve(pts); ctx.lineTo(cx0, yTop);
    ctx.strokeStyle = rgba(C.vprof, 0.9); ctx.lineWidth = 1.3; ctx.stroke(); ctx.lineWidth = 1;
    if (poc) { // point of control
      ctx.fillStyle = rgba(C.vprof, 1);
      ctx.beginPath(); ctx.arc(poc.x, poc.y, 2.2, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---------------------------------------------------------------- overlays: sessions, days, VWAP, range profile
  private sessColor(name: string): RGB {
    const list = this.meta?.sessions?.list ?? [];
    const i = Math.max(0, list.findIndex((s) => s.name === name));
    return this.C.sess[i % this.C.sess.length];
  }

  private visiblePeriods(): PeriodRow[] {
    const cs = this.store().candles;
    if (!cs.length || !this.PER.map.size || !this.anyPeriodLayer()) return [];
    const [l, r] = this.visRange(), t0 = cs[l].start_ts, t1 = cs[r].start_ts + 1;
    return [...this.PER.map.values()].filter((p) => p.start_ts < t1 && p.end_ts > t0);
  }

  private drawSessionBands() { // behind the candles
    if (!this.s.layers.sess) return;
    const { ctx, G } = this;
    ctx.font = `10px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (const p of this.visiblePeriods()) {
      if (p.kind !== 'session') continue;
      const x0 = this.timeToX(p.start_ts), x1 = this.timeToX(p.end_ts), col = this.sessColor(p.name);
      ctx.fillStyle = rgba(col, 0.07); ctx.fillRect(x0, 0, x1 - x0, G.mainH);
      ctx.fillStyle = rgba(col, 0.55); ctx.fillRect(x0, G.mainH - 2, x1 - x0, 2);
      if (x1 - x0 > 46) { ctx.fillStyle = rgba(col, 0.9); ctx.fillText(p.name, x0 + 3, G.mainH - 15); }
    }
  }

  private drawPeriodOverlays() { // over the candles: high/low lines, volume and delta profiles
    const { ctx, G, C } = this;
    const L = this.s.layers, list = this.visiblePeriods();
    if (!list.length) return;
    ctx.font = `10px ${MONO}`; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
    for (const p of list) {
      const isDay = p.kind === 'day';
      const hl = isDay ? L.dayHL : L.sessHL, vp = isDay ? L.dayVP : L.sessVP, dp = isDay ? L.dayDP : L.sessDP;
      if (!hl && !vp && !dp) continue;
      const x0 = this.timeToX(p.start_ts), x1 = this.timeToX(p.end_ts), span = x1 - x0;
      if (span < 2) continue;
      const col = isDay ? C.dayLine : this.sessColor(p.name);
      const tag = isDay ? 'D' : p.name;
      if (hl) {
        for (const [v, lab] of [[p.high, 'H'], [p.low, 'L']] as const) {
          const y = Math.round(this.yOf(v)) + 0.5;
          ctx.strokeStyle = rgba(col, isDay ? 0.75 : 0.9); ctx.setLineDash(isDay ? [6, 3] : [2, 3]); ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
          ctx.setLineDash([]); ctx.lineWidth = 1;
          if (span > 70) { // sessions: label at the start, days: at the end (they share start points)
            ctx.fillStyle = rgba(col, 1); ctx.textAlign = isDay ? 'right' : 'left';
            ctx.fillText(`${tag} ${lab} ${fmtPrice(v)}`, isDay ? x1 - 3 : x0 + 3, lab === 'H' ? y - 1 : y + 12);
            ctx.textAlign = 'left';
          }
        }
      }
      const rh = this.bin * this.ppu, W = Math.min(span * (vp && dp ? 0.3 : 0.4), 220);
      if ((!vp && !dp) || W < 6 || rh < 0.6 || !p.lv.length) continue;
      const n = p.lv.length;
      let vmax = 0, dmax = 0, poc = 0;
      for (let k = 0; k < n; k++) {
        const v = p.b[k] + p.s[k], d = Math.abs(p.b[k] - p.s[k]);
        if (v > vmax) { vmax = v; poc = k; }
        dmax = Math.max(dmax, d);
      }
      for (let k = 0; k < n; k++) {
        const yT = this.yOf(p.lv[k] + this.bin), h = Math.max(1, rh - (rh > 3 ? 1 : 0));
        if (yT > G.mainH || yT + h < 0) continue;
        if (vp && vmax > 0) { // anchored at the period start, growing right
          ctx.fillStyle = rgba(col, k === poc ? 0.75 : 0.32); ctx.fillRect(x0, yT, ((p.b[k] + p.s[k]) / vmax) * W, h);
        }
        if (dp && dmax > 0) { // zero line near the period end, buyers right / sellers left
          const d = p.b[k] - p.s[k], w = (Math.abs(d) / dmax) * (W / 2), zx = x1 - W / 2 - 2;
          ctx.fillStyle = rgba(d >= 0 ? C.green : C.red, 0.55); ctx.fillRect(d >= 0 ? zx : zx - w, yT, w, h);
        }
      }
      if (dp && dmax > 0) {
        const zx = Math.round(x1 - W / 2 - 2) + 0.5;
        ctx.strokeStyle = rgba(col, 0.6); ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.moveTo(zx, this.yOf(p.high)); ctx.lineTo(zx, this.yOf(p.low)); ctx.stroke(); ctx.setLineDash([]);
      }
    }
  }

  /** Running VWAP from the local day start (display tz); days whose start is not loaded are skipped. */
  private vwapValues(cs: Row[]): Float64Array {
    const st = this.store(), key = `${this.tz}|${cs.length}|${cs[0]?.cid}`;
    if (st.vwap && st.vwap.key === key) return st.vwap.values;
    const first = cs.length ? localInfo(cs[0], this.tz) : null;
    const tf = TF_MIN[this.agg];
    const completeFirst = !!first && !!tf && first.mod === 0;
    const values = vwap(cs, (i) => localInfo(cs[i], this.tz).dkey, completeFirst);
    st.vwap = { key, values };
    return values;
  }

  private drawVwap(cs: Row[], l: number, r: number) {
    const { ctx, C } = this;
    const v = this.vwapValues(cs);
    ctx.strokeStyle = rgba(C.vwap, 0.95); ctx.lineWidth = 1.6;
    ctx.beginPath();
    let pen = false, prevKey = -1;
    const step = this.compressed() ? Math.max(1, Math.floor(1 / this.colW)) : 1;
    for (let i = l; i <= r; i += step) {
      const key = localInfo(cs[i], this.tz).dkey;
      if (Number.isNaN(v[i]) || key !== prevKey) pen = false;
      prevKey = key;
      if (Number.isNaN(v[i])) continue;
      const x = this.xOf(i) + this.colW / 2, y = this.yOf(v[i]);
      if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    }
    ctx.stroke(); ctx.lineWidth = 1;
  }

  private drawRangeProfile() {
    const d = this.RVP.data;
    if (!d || !d.levels.n) return;
    const { ctx, G, C } = this;
    const L = d.levels.cols, W = Math.min(G.plotW * 0.22, 260), rh = this.bin * this.ppu;
    let m = 0;
    for (let k = 0; k < d.levels.n; k++) m = Math.max(m, L.buy_usd[k] + L.sell_usd[k]);
    if (!m) return;
    for (let k = 0; k < d.levels.n; k++) {
      const yT = this.yOf(L.level[k] + this.bin), h = Math.max(1, rh - (rh > 3 ? 1 : 0));
      if (yT > G.mainH || yT + h < 0) continue;
      const inVa = d.val !== null && d.vah !== null && L.level[k] >= d.val && L.level[k] < d.vah;
      const w = ((L.buy_usd[k] + L.sell_usd[k]) / m) * W;
      ctx.fillStyle = rgba(C.vprof, L.level[k] === d.poc ? 0.7 : inVa ? 0.3 : 0.14);
      ctx.fillRect(G.plotW - w, yT, w, h);
    }
    ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    for (const p of [d.vah, d.val]) {
      if (p === null) continue;
      const y = Math.round(this.yOf(p)) + 0.5;
      ctx.strokeStyle = rgba(C.vprof, 0.8); ctx.beginPath(); ctx.moveTo(G.plotW - W, y); ctx.lineTo(G.plotW, y); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // ---------------------------------------------------------------- selection, POC and axis tags
  private wickLines(c: Row): [number, RGB, string][] {
    return [[Math.min(c.open, c.close), this.C.green, 'L'], [Math.max(c.open, c.close), this.C.red, 'S']];
  }

  private drawSelection(cs: Row[]) {
    const i = this.selected;
    if (i < 0 || i >= cs.length) return;
    const { ctx, C, G } = this;
    const c = cs[i], x = this.xOf(i), colW = this.colW;
    ctx.save();
    ctx.setLineDash([5, 3]); ctx.lineWidth = 1.2;
    for (const [p, col] of this.wickLines(c)) {
      const y = Math.round(this.yOf(p)) + 0.5;
      ctx.strokeStyle = rgba(col, 0.95);
      ctx.beginPath(); ctx.moveTo(Math.min(x - colW * 0.6, x - 40), y); ctx.lineTo(Math.max(x + colW * 1.6, x + colW + 40), y); ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = C.selStroke;
    ctx.strokeRect(Math.round(x) + 0.5, 0.5, Math.round(colW) - 1, G.mainH - 1);
  }

  /** POC levels of the selected candle at the display bin */
  private pocLevels(c: Row) {
    const pb = this.bin, out: { p: number; lo: number; col: RGB; lab: string }[] = [];
    for (const [key, col, lab] of [[`vpoc_${pb}`, this.C.vprof, 'vPOC'], [`dpoc_neg_${pb}`, this.C.red, 'Δ−'], [`dpoc_pos_${pb}`, this.C.green, 'Δ+']] as const) {
      const v = c[key as `vpoc_${number}`];
      if (v !== null && v !== undefined) out.push({ p: v + pb / 2, lo: v, col, lab });
    }
    return out;
  }

  private drawPocMarkers(cs: Row[]) {
    const i = this.selected;
    if (i < 0 || i >= cs.length) return;
    const ctx = this.ctx, x = this.xOf(i), pb = this.bin;
    for (const t of this.pocLevels(cs[i])) { // bucket outline across the column
      const y1 = this.yOf(t.lo + pb), y2 = this.yOf(t.lo);
      ctx.strokeStyle = rgba(t.col, 0.95); ctx.lineWidth = 2;
      ctx.strokeRect(Math.round(x) + 1.5, Math.round(y1) + 0.5, Math.round(this.colW) - 3, Math.max(2, Math.round(y2 - y1) - 1));
      ctx.lineWidth = 1;
    }
  }

  /** Price-axis tags: selected candle (wick edges, POCs), VWAP, range profile POC / VAH / VAL. */
  private drawAxisTags(cs: Row[]) {
    const { ctx, G, C } = this;
    const tags: { y: number; col: RGB; text: string }[] = [];
    const i = this.selected;
    if (i >= 0 && i < cs.length) {
      const c = cs[i];
      for (const [p, col, lab] of this.wickLines(c)) tags.push({ y: this.yOf(p), col, text: `${lab} ${fmtPrice(p)}` });
      for (const t of this.pocLevels(c)) tags.push({ y: this.yOf(t.p), col: t.col, text: `${t.lab} ${t.lo}` });
    }
    if (this.s.layers.vwap && cs.length) {
      const v = this.vwapValues(cs), [, r] = this.visRange();
      if (!Number.isNaN(v[r])) tags.push({ y: this.yOf(v[r]), col: C.vwap, text: `VWAP ${fmtPrice(v[r])}` });
    }
    const d = this.RVP.data;
    if (this.s.layers.rangeVP && d && d.poc !== null) {
      tags.push({ y: this.yOf(d.poc + this.bin / 2), col: C.vprof, text: `POC ${d.poc}` });
      if (d.vah !== null) tags.push({ y: this.yOf(d.vah), col: C.vprof, text: `VAH ${d.vah}` });
      if (d.val !== null) tags.push({ y: this.yOf(d.val), col: C.vprof, text: `VAL ${d.val}` });
    }
    tags.sort((a, b) => a.y - b.y);
    ctx.font = `11px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    let last = -1e9;
    for (const t of tags) { // stack so the tags never overlap
      const y = Math.round(Math.max(t.y, last + 16)) + 0.5;
      last = y;
      if (y < 0 || y > G.mainH) continue;
      ctx.fillStyle = rgba(t.col, 0.9); ctx.fillRect(G.plotW + 1, y - 8, G.AX - 1, 16);
      ctx.fillStyle = C.tagText; ctx.fillText(t.text, G.plotW + 4, y);
    }
  }

  // ---------------------------------------------------------------- table, ΔOI, time axis
  private drawTable(cs: Row[], l: number, r: number) {
    const { ctx, G, C } = this;
    const btc = this.s.oiUnit === 'btc';
    const rows: [string, (c: Row) => number | null, (v: number) => string, boolean][] = [
      ['Volume', (c) => c.volume_usd, (v) => fmtK(v, false), false],
      ['CVD', (c) => c.cvd_usd, (v) => fmtK(v), true],
      ['Delta', (c) => c.delta_usd, (v) => fmtK(v), true],
      ['Trades', (c) => c.trades, fmtTrades, false],
      [btc ? 'OI Δ BTC' : 'OI Δ USD', (c) => (btc ? c.d_oi : c.d_oi_usd),
        (v) => (btc ? (Math.abs(v) >= 1e3 ? fmtK(v) : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(0)) : fmtK(v)), true],
    ];
    const txt = this.colW >= 38;
    ctx.font = `11px ${MONO}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    rows.forEach(([label], ri) => { ctx.fillStyle = C.axis; ctx.fillText(label, G.plotW + 6, G.tableTop + ri * G.ROW + G.ROW / 2); });
    ctx.save();
    ctx.beginPath(); ctx.rect(0, G.tableTop, G.plotW, G.ROW * G.TROWS); ctx.clip();
    if (this.compressed()) { // per pixel: sums (volume, delta, trades, ΔOI), last value (CVD)
      const groups = this.pixelGroups(l, r);
      rows.forEach(([, get, , signed], ri) => {
        const y = G.tableTop + ri * G.ROW;
        ctx.fillStyle = ri % 2 ? C.rowB : C.rowA; ctx.fillRect(0, y, G.plotW, G.ROW);
        const vals = groups.map((g) => {
          if (ri === 1) return get(cs[g.i1]);
          let s: number | null = null;
          for (let i = g.i0; i <= g.i1; i++) { const v = get(cs[i]); if (v !== null && v !== undefined) s = (s || 0) + v; }
          return s;
        });
        const m = Math.max(1e-9, ...vals.map((v) => Math.abs(v || 0)));
        groups.forEach((g, k) => {
          const v = vals[k];
          if (v === null || v === undefined || v === 0) return;
          const a = signed ? 0.15 + (0.6 * Math.abs(v)) / m : 0.08 + (0.5 * v) / m;
          ctx.fillStyle = rgba(signed ? (v > 0 ? C.green : C.red) : C.blue, a);
          ctx.fillRect(g.px, y + 1, 1, G.ROW - 2);
        });
      });
      ctx.restore();
      return;
    }
    rows.forEach(([, get, fmt, signed], ri) => {
      const y = G.tableTop + ri * G.ROW;
      ctx.fillStyle = ri % 2 ? C.rowB : C.rowA; ctx.fillRect(0, y, G.plotW, G.ROW);
      let vmax = 1;
      if (!signed) for (let i = l; i <= r; i++) vmax = Math.max(vmax, get(cs[i]) || 0);
      ctx.textAlign = 'center';
      for (let i = l; i <= r; i++) {
        const v = get(cs[i]);
        if (v === null || v === undefined) continue;
        const x = this.xOf(i);
        if (signed) {
          if (v !== 0) { ctx.fillStyle = rgba(v > 0 ? C.green : C.red, 0.22); ctx.fillRect(x + 1, y + 1, this.colW - 2, G.ROW - 2); }
        } else if (ri === 0) {
          ctx.fillStyle = rgba(C.blue, 0.08 + (0.3 * v) / vmax); ctx.fillRect(x + 1, y + 1, this.colW - 2, G.ROW - 2);
        }
        if (txt) {
          ctx.fillStyle = signed ? (v > 0 ? rgba(C.green, 1) : v < 0 ? rgba(C.red, 1) : C.text) : C.text;
          const t = fmt(v);
          if (ctx.measureText(t).width < this.colW - 2) ctx.fillText(t, x + this.colW / 2, y + G.ROW / 2);
        }
      }
    });
    ctx.restore();
  }

  private drawOi(cs0: Row[], l: number, r: number) {
    const { ctx, G, C } = this;
    const top = G.oiTop, h = G.oiH, mid = top + h / 2, btc = this.s.oiUnit === 'btc';
    ctx.fillStyle = C.oiBg; ctx.fillRect(0, top, G.plotW, h);
    const get0 = (c: Row) => (btc ? c.d_oi : c.d_oi_usd);
    const getOi = (c: Row) => (btc ? c.oi_end : c.oi_end_usd) ?? null;
    let vals: (number | null)[], ois: (number | null)[], xs: number[] | null = null;
    if (this.compressed()) { // per pixel: sum of ΔOI of the merged candles (null when none has a snapshot)
      const groups = this.pixelGroups(l, r);
      vals = groups.map((g) => {
        let s: number | null = null;
        for (let i = g.i0; i <= g.i1; i++) { const v = get0(cs0[i]); if (v !== null && v !== undefined) s = (s || 0) + v; }
        return s;
      });
      ois = groups.map((g) => getOi(cs0[g.i1])); // OI at the end of the last merged candle
      xs = groups.map((g) => g.px);
    } else {
      vals = cs0.slice(l, r + 1).map(get0);
      ois = cs0.slice(l, r + 1).map(getOi);
    }
    let m = 0;
    for (const v of vals) if (v !== null && v !== undefined) m = Math.max(m, Math.abs(v));
    ctx.strokeStyle = C.zero; ctx.beginPath(); ctx.moveTo(0, Math.round(mid) + 0.5); ctx.lineTo(G.plotW, Math.round(mid) + 0.5); ctx.stroke();
    ctx.font = `10px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = C.axis;
    ctx.fillText(`ΔOI ${this.s.oiUnit.toUpperCase()}`, G.plotW + 6, top + 8);
    if (m) this.drawOiBars(vals, xs, l, m);
    this.drawOiLine(ois, xs, l);
  }

  private drawOiBars(vals: (number | null)[], xs: number[] | null, l: number, m: number) {
    const { ctx, G, C } = this;
    const top = G.oiTop, h = G.oiH, mid = top + h / 2, btc = this.s.oiUnit === 'btc';
    const fm = btc ? (m >= 1e3 ? fmtK(m, false) : m.toFixed(0)) : fmtK(m, false);
    ctx.fillText('+' + fm, G.plotW + 6, top + 22); ctx.fillText('−' + fm, G.plotW + 6, top + h - 6);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, top, G.plotW, h); ctx.clip();
    const w = xs ? 1 : Math.max(1, this.colW * 0.7);
    vals.forEach((v, k) => {
      if (v === null || v === undefined) return;
      const bh = (v / m) * (h / 2 - 3);
      ctx.fillStyle = rgba(v >= 0 ? C.green : C.red, 0.85);
      ctx.fillRect(xs ? xs[k] : this.xOf(l + k) + (this.colW - w) / 2, bh >= 0 ? mid - bh : mid, w, Math.max(1, Math.abs(bh)));
    });
    ctx.restore();
  }

  /** Open interest itself: a line scaled to the visible min..max of the panel, tag with the last value. */
  private drawOiLine(ois: (number | null)[], xs: number[] | null, l: number) {
    const { ctx, G, C } = this;
    const top = G.oiTop, h = G.oiH;
    let lo = Infinity, hi = -Infinity, last: number | null = null;
    for (const v of ois) if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); last = v; }
    if (last === null) return;
    const pad = 6, span = hi - lo || 1;
    const yOf = (v: number) => top + h - pad - ((v - lo) / span) * (h - 2 * pad);
    const xc = (k: number) => (xs ? xs[k] + 0.5 : this.xOf(l + k) + this.colW / 2);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, top, G.plotW, h); ctx.clip();
    ctx.strokeStyle = rgba(C.oiLine, 0.9); ctx.lineWidth = 1.5; ctx.beginPath();
    let pen = false;
    ois.forEach((v, k) => {
      if (v === null) { pen = false; return; }
      if (pen) ctx.lineTo(xc(k), yOf(v)); else ctx.moveTo(xc(k), yOf(v));
      pen = true;
    });
    ctx.stroke();
    ctx.restore();
    const y = Math.min(top + h - 8, Math.max(top + 8, yOf(last)));
    ctx.fillStyle = rgba(C.oiLine, 0.9); ctx.fillRect(G.plotW + 1, y - 8, G.AX - 1, 16);
    ctx.fillStyle = C.bg; ctx.font = `10px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('OI ' + (this.s.oiUnit === 'btc' ? (last / 1e3).toFixed(2) + 'K' : fmtK(last, false)), G.plotW + 4, y);
  }

  private drawTimeAxis(cs: Row[], l: number, r: number) {
    const { ctx, G, C } = this;
    const top = G.timeTop;
    ctx.fillStyle = C.bg; ctx.fillRect(0, top, G.W, G.TIME);
    ctx.font = `11px ${MONO}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    const tf = TF_MIN[this.agg];
    // average px per day (also for volume candles, from their average count per day)
    const perDay = tf ? 1440 / tf : this.meta?.aggregations[this.agg]?.per_day || 100;
    const dayPx = perDay * this.colW;
    let stepMin = 0, every = 0, stepDays = 0;
    if (dayPx < 74) stepDays = [1, 2, 7, 14, 30].find((k) => k * dayPx >= 74) || 30; // long ranges: dates only
    else if (tf) stepMin = [1, 5, 15, 30, 60, 120, 180, 240, 360, 720, 1440].find((m) => (m / tf) * this.colW >= 74) || 1440;
    else every = Math.max(1, Math.ceil(84 / this.colW));
    let prevDay: number | null = null, lastX = -1e9, prevKey: number | null = null;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, G.plotW, G.H); ctx.clip();
    const idxs = this.compressed() ? this.pixelGroups(l, r).map((g) => g.i0) : null;
    const nIdx = idxs ? idxs.length : r - l + 1;
    for (let k = 0; k < nIdx; k++) {
      const i = idxs ? idxs[k] : l + k;
      const li = localInfo(cs[i], this.tz), x = this.xOf(i);
      const newDay = prevDay !== null && li.dkey !== prevDay;
      prevDay = li.dkey;
      if (stepDays) { // label where the month / week / day bucket changes between inspected candles
        const key = stepDays >= 30 ? li.ym : Math.floor(li.dnum / stepDays);
        const lab = prevKey !== null && key !== prevKey;
        prevKey = key;
        if (lab && x - lastX >= 60) {
          lastX = x; ctx.fillStyle = C.axis;
          ctx.fillText(stepDays >= 30 ? li.mlabel : li.dshort, x, top + G.TIME / 2);
        }
        continue;
      }
      if (newDay && dayPx >= 30) { // day separator (local day in display timezone)
        ctx.strokeStyle = C.daySep; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, G.timeTop); ctx.stroke();
        ctx.setLineDash([]);
      }
      const lab = tf ? li.mod % stepMin === 0 : i % every === 0;
      if (!lab || x - lastX < 60) continue;
      lastX = x;
      ctx.fillStyle = li.mod === 0 || (newDay && !tf) ? C.text : C.axis;
      ctx.fillText(tf ? (li.mod === 0 ? li.date : li.hm) : newDay ? li.date : li.hms, x + this.colW / 2, top + G.TIME / 2);
    }
    ctx.restore();
    ctx.textAlign = 'left'; ctx.fillStyle = C.dim;
    ctx.fillText(this.tz === 'UTC' ? 'UTC' : 'NY', G.plotW + 6, top + G.TIME / 2);
  }

  // ---------------------------------------------------------------- overlay: crosshair + tooltip
  private renderOverlay() {
    const { octx: ctx, G, C } = this;
    ctx.clearRect(0, 0, G.W, G.H);
    const h = this.hover, tt = this.tooltip, cs = this.store().candles;
    if (!h || h.x > G.plotW || !cs.length) { tt.hidden = true; return; }
    const i = Math.floor(this.idxAt(h.x));
    ctx.strokeStyle = C.cross; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    if (i >= 0 && i < cs.length) {
      const cx = Math.round(this.xOf(i) + this.colW / 2) + 0.5;
      ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, G.timeTop); ctx.stroke();
    }
    if (h.y < G.mainH) {
      const y = Math.round(h.y) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(G.plotW, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.crossBg; ctx.fillRect(G.plotW + 1, y - 9, G.AX - 1, 18);
      ctx.fillStyle = C.tagText; ctx.font = `11px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtPrice(this.priceAt(h.y)), G.plotW + 6, y);
    }
    ctx.setLineDash([]);
    if (i < 0 || i >= cs.length || !this.hoverMouse) { tt.hidden = true; return; }
    const c = cs[i];
    const oi = c.d_oi === null || c.d_oi === undefined ? this.t('no_snapshot')
      : `${c.d_oi >= 0 ? '+' : '−'}${Math.abs(c.d_oi).toFixed(1)} BTC  ${fmtK(c.d_oi_usd)}`;
    let txt = `${fmtTs(c.start_ts, this.tz, !isTimeAgg(this.agg))}\n` +
      `O ${fmtPrice(c.open)}  H ${fmtPrice(c.high)}\nL ${fmtPrice(c.low)}  C ${fmtPrice(c.close)}\n` +
      `Vol    ${fmtK(c.volume_usd, false)}  (${c.volume.toFixed(1)} BTC)\n` +
      `Delta  ${fmtK(c.delta_usd)}  (${c.delta >= 0 ? '+' : '−'}${Math.abs(c.delta).toFixed(1)} BTC)\n` +
      `Trades ${c.trades.toLocaleString('en-US')}\nDur    ${fmtDur(c.duration_ms)}\nΔOI    ${oi}` +
      (c.oi_end === null || c.oi_end === undefined ? ''
        : `\nOI     ${Math.round(c.oi_end).toLocaleString('en-US')} BTC  ${fmtK(c.oi_end_usd, false)}`);
    // footprint level under the cursor
    const f = h.y < G.mainH && this.showCells() ? this.fpFor(c, this.bin) : null;
    if (f) {
      const lvl = Math.floor(this.priceAt(h.y) / this.bin) * this.bin, k = f.lv.indexOf(lvl);
      if (k >= 0) txt += `\n${lvl}  buy ${fmtK(f.b[k], false)}  sell ${fmtK(f.s[k], false)}  Δ ${fmtK(f.b[k] - f.s[k])}`;
    }
    if (this.s.layers.vwap) {
      const v = this.vwapValues(cs)[i];
      if (!Number.isNaN(v)) txt += `\nVWAP   ${fmtPrice(v)}`;
    }
    tt.textContent = txt;
    tt.hidden = false;
    const wrap = this.canvas.parentElement!.getBoundingClientRect();
    const tw = tt.offsetWidth, th = tt.offsetHeight;
    let tx = h.x + 16, ty = h.y + 16;
    if (tx + tw > wrap.width - 4) tx = h.x - tw - 16;
    if (ty + th > wrap.height - 4) ty = h.y - th - 16;
    tt.style.left = `${Math.max(2, tx)}px`; tt.style.top = `${Math.max(2, ty)}px`;
  }

  // ---------------------------------------------------------------- selection -> React side panel
  private publishSelected() {
    const cs = this.store().candles, i = this.selected;
    const ui = useUi.getState();
    if (i < 0 || i >= cs.length) { if (ui.selected) ui.set({ selected: null }); return; }
    const c = cs[i];
    const prev = ui.selected;
    // a live update replaced the open candle by a light row: keep the loaded detail on screen (no
    // "loading" flash every second) and refresh it in the background now and then
    if (!c._full && prev?._full && sameCandle(prev, c)) {
      carryDetail(c, prev, this.liveKeys);
      c._full = true;
      if (Date.now() - this.detailAt > DETAIL_REFRESH_MS) void this.loadDetail(c, true);
    }
    if (ui.selected !== c) ui.set({ selected: c });
    if (!c._full) void this.loadDetail(c);
  }

  /** Fetch all columns of a candle; `refresh` overwrites the detail columns of an open (live) candle. */
  private async loadDetail(c: Row, refresh = false) {
    if (c._loading) return;
    c._loading = true;
    this.detailAt = Date.now();
    try {
      const row = toRows(await api.candle<CandleFull>(this.agg, c.cid, c.start_ts))[0] ?? {};
      const rec = c as Record<string, unknown>;
      if (refresh) carryDetail(rec, row, this.liveKeys);
      else for (const [k, v] of Object.entries(row)) if (!(k in c) || rec[k] === undefined) rec[k] = v;
      c._full = true;
    } catch (e) { this.status(this.t('err_detail') + (e as Error).message); }
    finally {
      c._loading = false;
      // the live feed may have replaced the candle by a newer row while the request ran
      const cur = this.store().candles[this.selected];
      if (cur && sameCandle(cur, c)) {
        if (cur !== c && c._full) { carryDetail(cur, c, this.liveKeys); cur._full = true; }
        useUi.getState().set({ selected: { ...cur } as Row });
      }
    }
  }

  private updateStatus() {
    const st = this.store();
    if (st.minDay === null) return;
    const mode = this.showCells() ? (this.showText() ? this.t('mode_text') : this.t('mode_cells')) : this.t('mode_candles');
    const from = isoDay(st.minDay), to = isoDay(st.maxDay!);
    const ui = useUi.getState();
    if (!ui.dataRange || ui.dataRange.from !== from || ui.dataRange.to !== to) ui.set({ dataRange: { from, to } });
    this.status(`${aggLabel(this.agg, this.t('ticks'))} · data ${from} … ${to} UTC · ${mode}`);
  }

  // ---------------------------------------------------------------- input (mouse, touch, pen via pointer events)
  private hitArea(x: number, y: number): Drag['mode'] {
    if (x > this.G.plotW && y < this.G.mainH) return 'price'; // price axis: drag vertically to scale price
    if (y > this.G.timeTop && x < this.G.plotW) return 'time'; // time axis: drag horizontally to scale time
    return 'pan';
  }

  private pos(e: PointerEvent | MouseEvent | WheelEvent) {
    const r = this.overlay.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bindInput() {
    const el = this.overlay;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      const p = this.pos(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2) { // pinch: zoom time around the midpoint
        const [a, b] = [...this.pointers.values()];
        const cx = (a.x + b.x) / 2;
        this.pinch = { dist: Math.max(10, Math.abs(a.x - b.x)), colW: this.colW, idx: this.idxAt(cx), cx };
        this.drag = null;
        return;
      }
      this.drag = { x: p.x, y: p.y, right: this.rightIdx, top: this.priceTop, moved: false, vert: false,
        mode: this.hitArea(p.x, p.y), ppu: this.ppu, colW: this.colW, anchor: this.priceAt(this.G.mainH / 2) };
    });
    window.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', (e) => { this.pointers.delete(e.pointerId); this.pinch = null; this.drag = null; });
    el.addEventListener('pointermove', (e) => {
      const p = this.pos(e);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.max(10, Math.abs(a.x - b.x));
        this.colW = clamp(this.pinch.colW * (dist / this.pinch.dist), MIN_COLW, 400);
        this.rightIdx = this.pinch.idx + (this.G.plotW - this.pinch.cx) / this.colW;
        this.draw(); this.ensure();
        return;
      }
      this.hover = e.pointerType === 'mouse' || this.drag ? p : null;
      this.hoverMouse = e.pointerType === 'mouse';
      const d = this.drag;
      const area = d ? d.mode : this.hitArea(p.x, p.y);
      el.style.cursor = area === 'price' ? 'ns-resize' : area === 'time' ? 'ew-resize' : d ? 'grabbing' : 'crosshair';
      if (!d) { this.drawOverlay(); return; }
      if (d.mode === 'price') { // up = zoom in, down = zoom out, around the panel centre
        d.moved = true;
        this.ppu = clamp(d.ppu * Math.exp(-(p.y - d.y) * 0.006), 0.002, 200);
        this.priceTop = d.anchor + this.G.mainH / 2 / this.ppu;
        this.autoY = false;
      } else if (d.mode === 'time') { // right = wider candles, anchored at the right edge
        d.moved = true;
        this.colW = clamp(d.colW * Math.exp((p.x - d.x) * 0.006), MIN_COLW, 400);
      } else {
        const dx = p.x - d.x, dy = p.y - d.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
        this.rightIdx = d.right - dx / this.colW;
        if (!d.vert && Math.abs(dy) > 14) { d.vert = true; this.autoY = false; d.top = this.priceTop; d.y = p.y; }
        if (d.vert) this.priceTop = d.top + (p.y - d.y) / this.ppu;
      }
      this.draw();
    });
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { this.hover = null; this.drawOverlay(); } });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = this.pos(e);
      const delta = e.deltaY || e.deltaX;
      const f = Math.exp(-delta * 0.0015);
      if (e.ctrlKey || e.shiftKey || e.altKey || p.x > this.G.plotW) {
        const price = this.priceAt(p.y);
        this.ppu = clamp(this.ppu * f, 0.002, 200);
        this.priceTop = price + p.y / this.ppu;
        this.autoY = false;
      } else {
        const idx = this.idxAt(p.x);
        this.colW = clamp(this.colW * f, MIN_COLW, 400);
        this.rightIdx = idx + (this.G.plotW - p.x) / this.colW;
      }
      this.draw(); this.ensure();
    }, { passive: false });
    el.addEventListener('dblclick', (e) => {
      const p = this.pos(e);
      const area = this.hitArea(p.x, p.y);
      if (area === 'price') { this.autoY = true; this.draw(); return; } // reset price scale only
      if (area === 'time') { this.colW = DEFAULT_COLW; this.draw(); this.ensure(); return; }
      const t = this.centerTime();
      this.colW = DEFAULT_COLW; this.autoY = true;
      if (t !== null) this.rightIdx = this.store().candles.findIndex((c) => c.start_ts >= t) + this.visibleCount() / 2;
      this.draw(); this.ensure();
    });
  }

  private onPointerUp = (e: PointerEvent) => {
    const had = this.pointers.delete(e.pointerId);
    if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; this.drag = null; return; }
    const d = this.drag;
    if (had && d && d.mode === 'pan' && !d.moved) {
      const p = this.pos(e);
      if (p.x < this.G.plotW && p.y < this.G.timeTop) {
        const i = Math.floor(this.idxAt(p.x));
        this.selected = i >= 0 && i < this.store().candles.length ? i : -1;
        this.publishSelected(); this.draw();
      }
    }
    if (d && d.moved) this.ensure();
    this.drag = null;
    if (e.pointerType !== 'mouse' && this.hover) { this.hover = null; this.drawOverlay(); } // no stale crosshair after a touch drag
  };
}

function niceStep(minUsd: number) {
  const steps = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
  return steps.find((s) => s >= minUsd) || 20000;
}
