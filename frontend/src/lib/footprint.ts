// Pure footprint computations in the browser (unit-tested in footprint.test.ts).
import type { CandleFootprint } from '../api/types';

/** Re-bin a base-bin footprint (levels ascending) to a coarser bin: floor(level / bin) * bin. */
export function rebin(f: CandleFootprint, bin: number): CandleFootprint {
  const r: CandleFootprint = { lv: [], b: [], s: [] };
  for (let i = 0; i < f.lv.length; i++) {
    const L = Math.floor(f.lv[i] / bin) * bin, k = r.lv.length - 1;
    if (k >= 0 && r.lv[k] === L) { r.b[k] += f.b[i]; r.s[k] += f.s[i]; }
    else { r.lv.push(L); r.b.push(f.b[i]); r.s.push(f.s[i]); }
  }
  return r;
}

export interface ImbalanceParams {
  ratio: number; // e.g. 3 = 300 %
  minUsd: number; // aggressive side must have at least this much at the level
  stackMin: number; // consecutive levels forming a stacked imbalance
}

export interface Imbalances {
  buy: boolean[]; // per level index of the footprint
  sell: boolean[];
  /** stacked runs: [first level index, last level index] */
  buyStacks: [number, number][];
  sellStacks: [number, number][];
}

/**
 * Diagonal imbalance (same rule as backend/fp/metrics.py, at any bin):
 * buy imbalance at L  if buy(L)  >= ratio * sell(L - bin) and buy(L)  >= minUsd,
 * sell imbalance at L if sell(L) >= ratio * buy(L + bin)  and sell(L) >= minUsd
 * (a missing neighbouring level counts as 0). Stacked = at least stackMin consecutive levels.
 */
export function imbalances(f: CandleFootprint, bin: number, p: ImbalanceParams): Imbalances {
  const n = f.lv.length, idx = new Map<number, number>();
  for (let k = 0; k < n; k++) idx.set(f.lv[k], k);
  const buy = new Array<boolean>(n), sell = new Array<boolean>(n);
  for (let k = 0; k < n; k++) {
    const below = idx.get(f.lv[k] - bin), above = idx.get(f.lv[k] + bin);
    const sBelow = below === undefined ? 0 : f.s[below];
    const bAbove = above === undefined ? 0 : f.b[above];
    buy[k] = f.b[k] >= p.minUsd && f.b[k] >= p.ratio * sBelow;
    sell[k] = f.s[k] >= p.minUsd && f.s[k] >= p.ratio * bAbove;
  }
  const runs = (flags: boolean[]) => {
    const out: [number, number][] = [];
    let start = -1;
    for (let k = 0; k <= n; k++) {
      const on = k < n && flags[k] && (start < 0 || f.lv[k] === f.lv[k - 1] + bin);
      if (on && start < 0) start = k;
      if (!on && start >= 0) {
        if (k - start >= p.stackMin) out.push([start, k - 1]);
        start = k < n && flags[k] ? k : -1;   // a gap in levels ends the run; a flagged level starts a new one
      }
    }
    return out;
  };
  return { buy, sell, buyStacks: runs(buy), sellStacks: runs(sell) };
}

/**
 * Running VWAP per candle, reset when `segment(i)` changes (e.g. the local day).
 * volume_usd / volume of a candle is its exact average price (Σ price·qty / Σ qty), so the cumulative
 * ratio is the exact VWAP of all trades since the segment start. Returns NaN where the segment's
 * first candle is the first loaded one and `complete(i)` is false (start of the segment not loaded).
 */
export function vwap(cs: { volume: number; volume_usd: number }[], segment: (i: number) => number,
                     completeFirst: boolean): Float64Array {
  const out = new Float64Array(cs.length);
  let seg = NaN, sv = 0, sq = 0, valid = completeFirst;
  for (let i = 0; i < cs.length; i++) {
    const s = segment(i);
    if (s !== seg) { if (i > 0) valid = true; seg = s; sv = 0; sq = 0; }
    sv += cs[i].volume_usd; sq += cs[i].volume;
    out[i] = valid && sq > 0 ? sv / sq : NaN;
  }
  return out;
}

/** q-quantile of values (sorts in place); 1 for an empty list (used as an intensity scale). */
export function percentile(arr: number[], q: number): number {
  if (!arr.length) return 1;
  arr.sort((a, b) => a - b);
  return arr[Math.min(arr.length - 1, Math.floor(q * (arr.length - 1)))] || 1;
}
