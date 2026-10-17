const isNil = (v: number | null | undefined): v is null | undefined => v === null || v === undefined || Number.isNaN(v);

/** 1234567 -> "+1.2M" (sign optional), magnitudes K / M / B. */
export function fmtK(v: number | null | undefined, sign = true): string {
  if (isNil(v)) return '';
  const a = Math.abs(v);
  let s: string;
  if (a >= 1e9) s = (a / 1e9).toFixed(a >= 1e10 ? 1 : 2) + 'B';
  else if (a >= 1e6) s = (a / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
  else if (a >= 1e3) s = (a / 1e3).toFixed(0) + 'K';
  else s = a.toFixed(0);
  if (/^0(\.0)?[KMB]?$/.test(s)) return '0';
  return (v < 0 ? '−' : sign ? '+' : '') + s;
}

export const fmtNum = (v: number | null | undefined, d = 3) => (isNil(v) ? '—' : v.toFixed(d));
export const fmtPrice = (p: number) => p.toFixed(1);

export function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}:${String(r).padStart(2, '0')}`;
}

export function fmtTrades(v: number): string {
  return v >= 1e4 ? (v / 1e3).toFixed(0) + 'K' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(v);
}

/** Label of an aggregation key: 5m -> M5, vusd_100000000 -> Vol 100M USD, vtick_5000 -> 5000 ticks. */
export function aggLabel(a: string, ticksWord = 'ticks'): string {
  const tf: Record<string, string> = { '1m': 'M1', '5m': 'M5', '15m': 'M15' };
  if (a in tf) return tf[a];
  const m = /^v(usd|btc|tick)_(\d+(?:\.\d+)?)$/.exec(a);
  if (!m) return a;
  const v = +m[2];
  if (m[1] === 'tick') return `${v} ${ticksWord}`;
  if (m[1] === 'btc') return `Vol ${v} BTC`;
  const usd = v >= 1e9 ? `${+(v / 1e9).toFixed(3)}B` : v >= 1e6 ? `${+(v / 1e6).toFixed(3)}M` : `${+(v / 1e3).toFixed(3)}K`;
  return `Vol ${usd} USD`;
}

export const TF_MIN: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15 };
export const isTimeAgg = (a: string) => a in TF_MIN;
