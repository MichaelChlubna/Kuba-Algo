import type { Columnar, Job, Meta, PeriodsResponse, ProfileResponse } from './types';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    let msg = await r.text();
    try { msg = JSON.parse(msg).detail ?? msg; } catch { /* plain text */ }
    throw new ApiError(r.status, `${r.status} ${msg}`);
  }
  return r.json() as Promise<T>;
}

/** Columnar JSON -> array of row objects. */
export function toRows<T>(js: Columnar<T>): T[] {
  const cols = js.cols as Record<string, unknown[]>;
  const keys = Object.keys(cols);
  const out = new Array<T>(js.n);
  for (let i = 0; i < js.n; i++) {
    const o: Record<string, unknown> = {};
    for (const k of keys) o[k] = cols[k][i];
    out[i] = o as T;
  }
  return out;
}

const q = (o: Record<string, string | number | boolean>) =>
  Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

export const api = {
  meta: () => fetchJson<Meta>('/api/meta'),
  candles: <T>(agg: string, start: number, end: number) => fetchJson<Columnar<T>>(`/api/candles?${q({ agg, start, end })}`),
  candle: <T>(agg: string, cid: number, start_ts: number) => fetchJson<Columnar<T>>(`/api/candle?${q({ agg, cid, start_ts })}`),
  footprint: <T>(agg: string, start: number, end: number) => fetchJson<Columnar<T>>(`/api/footprint?${q({ agg, start, end })}`),
  periods: (start: number, end: number, tz: string, bin: number) =>
    fetchJson<PeriodsResponse>(`/api/periods?${q({ start, end, tz, bin })}`),
  profile: (start: number, end: number, bin: number) => fetchJson<ProfileResponse>(`/api/profile?${q({ start, end, bin })}`),
  buildVolume: (unit: string, value: number) =>
    fetchJson<Job & { agg: string }>(`/api/volume?${q({ unit, value })}`, { method: 'POST' }),
  jobs: () => fetchJson<Record<string, Job>>('/api/jobs'),
};
