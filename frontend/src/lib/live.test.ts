import { describe, expect, it } from 'vitest';
import { carryDetail, mergeLive } from './live';

const D = 86_400_000;
const c = (cid: number, v = 0) => ({ cid, start_ts: cid, v });

describe('mergeLive', () => {
  it('replaces the open candle and appends new ones', () => {
    const cs = [c(D), c(D + 60_000, 1)];
    const r = mergeLive(cs, [c(D + 60_000, 2), c(D + 120_000, 3)], 1, () => false);
    expect(r).toEqual({ appended: 1, replaced: 1 });
    expect(cs.map((x) => x.v)).toEqual([0, 2, 3]);
  });

  it('ignores candles that are not loaded and new days unless accepted', () => {
    const cs = [c(D), c(D + 60_000)];
    expect(mergeLive(cs, [c(D + 30_000)], 1, () => true).appended).toBe(0);
    expect(mergeLive(cs, [c(2 * D)], 1, () => false).appended).toBe(0);
    expect(mergeLive(cs, [c(2 * D)], 1, (d) => d === 2).appended).toBe(1);
    expect(cs.length).toBe(3);
  });
});

describe('carryDetail', () => {
  it('keeps the loaded detail on a fresher live row without touching live columns or flags', () => {
    const live = { cid: 1, close: 101, volume: 7 } as Record<string, unknown>;
    carryDetail(live, { cid: 1, close: 100, volume: 5, lw_share: 0.3, _full: true, _loading: false }, new Set(['cid', 'close', 'volume']));
    expect(live).toEqual({ cid: 1, close: 101, volume: 7, lw_share: 0.3 });
  });
});
