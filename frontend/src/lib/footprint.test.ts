import { describe, expect, it } from 'vitest';
import golden from './__fixtures__/imbalance_golden.json';
import { imbalances, percentile, rebin, vwap } from './footprint';

describe('rebin', () => {
  it('sums base-bin levels into coarser bins', () => {
    const r = rebin({ lv: [100, 105, 110, 125], b: [1, 2, 3, 4], s: [5, 6, 7, 8] }, 25);
    expect(r).toEqual({ lv: [100, 125], b: [6, 4], s: [18, 8] });
  });
});

describe('imbalances', () => {
  const f = { lv: [100, 105, 110, 115, 120], b: [10, 90, 95, 100, 1], s: [30, 20, 5, 1, 50] };
  it('flags diagonal buy and sell imbalances', () => {
    const im = imbalances(f, 5, { ratio: 3, minUsd: 50, stackMin: 3 });
    // buy(105)=90 >= 3*sell(100)=90 ✓, buy(110)=95 >= 3*20 ✓, buy(115)=100 >= 3*5 ✓, buy(100) < min
    expect(im.buy).toEqual([false, true, true, true, false]);
    // sell(120)=50 >= min and buy(125) missing -> 0 ✓; sell(100)=30 < min
    expect(im.sell).toEqual([false, false, false, false, true]);
    expect(im.buyStacks).toEqual([[1, 3]]);
    expect(im.sellStacks).toEqual([]);
  });
  it('breaks stacks on missing levels', () => {
    const g = { lv: [100, 105, 115, 120, 125], b: [9, 9, 9, 9, 9], s: [0, 0, 0, 0, 0] };
    const im = imbalances(g, 5, { ratio: 3, minUsd: 1, stackMin: 2 });
    expect(im.buyStacks).toEqual([[0, 1], [2, 4]]);
  });

  it('reproduces the wick imbalance counts and stacks of the original backend (golden data)', () => {
    const fp = golden.footprint as { start_ts: number[]; level: number[]; buy_usd: number[]; sell_usd: number[] };
    let checked = 0, nonzero = 0;
    for (const c of golden.candles as Record<string, number | null>[]) {
      const idx = fp.start_ts.flatMap((t, i) => (t === c.start_ts ? [i] : []));
      const f = { lv: idx.map((i) => fp.level[i]), b: idx.map((i) => fp.buy_usd[i]), s: idx.map((i) => fp.sell_usd[i]) };
      const im = imbalances(f, 5, { ratio: 3, minUsd: 50_000, stackMin: 1 });
      const lo = Math.min(c.open!, c.close!), hi = Math.max(c.open!, c.close!);
      const inLw = f.lv.map((L) => L + 5 <= lo), inUw = f.lv.map((L) => L > hi);
      const count = (flags: boolean[], zone: boolean[]) => flags.filter((x, k) => x && zone[k]).length;
      const longest = (flags: boolean[], zone: boolean[]) => {
        let best = 0, run = 0;
        f.lv.forEach((L, k) => {
          const on = flags[k] && zone[k];
          run = on ? (k > 0 && run > 0 && f.lv[k - 1] === L - 5 ? run + 1 : 1) : 0;
          best = Math.max(best, run);
        });
        return best;
      };
      for (const [zone, z] of [[inLw, 'lw'], [inUw, 'uw']] as const) {
        for (const [flags, side] of [[im.buy, 'buy'], [im.sell, 'sell']] as const) {
          expect(count(flags, zone), `${c.start_ts} ${z}_${side}_imb`).toBe(c[`${z}_${side}_imb`]);
          expect(longest(flags, zone), `${c.start_ts} ${z}_${side}_stack`).toBe(c[`${z}_${side}_stack`] ?? 0);
          checked++;
          if (c[`${z}_${side}_imb`]) nonzero++;
        }
      }
    }
    expect(checked).toBe(48 * 4);
    expect(nonzero).toBeGreaterThan(20);
  });
});

describe('vwap', () => {
  const cs = [
    { volume: 1, volume_usd: 100 }, { volume: 3, volume_usd: 330 }, // day 1: (100 + 330) / 4
    { volume: 2, volume_usd: 400 }, { volume: 2, volume_usd: 440 }, // day 2 resets
  ];
  const day = (i: number) => (i < 2 ? 1 : 2);
  it('accumulates volume_usd / volume and resets per segment', () => {
    expect(Array.from(vwap(cs, day, true))).toEqual([100, 107.5, 200, 210]);
  });
  it('skips the first segment when its start is not loaded', () => {
    const v = vwap(cs, day, false);
    expect(Number.isNaN(v[0]) && Number.isNaN(v[1])).toBe(true);
    expect(v[2]).toBe(200);
  });
});

describe('percentile', () => {
  it('returns the q-quantile and 1 for empty input', () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([], 0.95)).toBe(1);
  });
});
