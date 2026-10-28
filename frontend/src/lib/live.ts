// Merging live candle updates (WebSocket /api/live) into the loaded candles.

export interface Keyed { cid: number; start_ts: number }

/**
 * Upsert `rows` (sorted by cid) into `candles` (sorted by cid), in place. A row replaces the candle with
 * the same cid (the open candle grows) or is appended after the last one (a new candle). Rows older than
 * the last candle that are not loaded are ignored, so a partially loaded history never gets holes.
 * `acceptDay(day)` decides whether a row that starts a not yet loaded UTC day may be appended.
 */
export function mergeLive<T extends Keyed>(candles: T[], rows: T[], lastDay: number, acceptDay: (day: number) => boolean) {
  let appended = 0, replaced = 0;
  for (const r of rows) {
    const n = candles.length;
    const last = n ? candles[n - 1].cid : -Infinity;
    if (r.cid > last) {
      const day = Math.floor(r.start_ts / 86_400_000);
      if (day > lastDay && !acceptDay(day)) continue;
      candles.push(r); appended++;
      continue;
    }
    for (let i = n - 1; i >= 0 && candles[i].cid >= r.cid; i--) {
      if (candles[i].cid === r.cid) { candles[i] = r; replaced++; break; }
    }
  }
  return { appended, replaced };
}

/**
 * Copy the detail columns (fetched per candle from /api/candle) from `src` onto `dst`, another row of the
 * same candle, so a live update of the open candle keeps the loaded detail. Columns the live feed sends
 * (`liveKeys`) keep their value in `dst`; internal `_` flags are not copied.
 */
export function carryDetail(dst: object, src: object, liveKeys: ReadonlySet<string>) {
  const d = dst as Record<string, unknown>;
  for (const [k, v] of Object.entries(src)) if (!liveKeys.has(k) && !k.startsWith('_')) d[k] = v;
}
