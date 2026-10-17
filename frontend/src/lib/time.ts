// Time zones via Intl / IANA (DST handled by the browser). All timestamps are UTC epoch ms.
export const DAY = 86_400_000;

export interface Parts { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: string; tzn: string }

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', timeZoneName: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function parts(ts: number, tz: string): Parts {
  const o: Record<string, string> = {};
  for (const p of dtf(tz).formatToParts(new Date(ts))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, wd: o.weekday, tzn: o.timeZoneName };
}

const p2 = (n: number) => String(n).padStart(2, '0');

export function fmtTs(ts: number, tz: string, withSec = false): string {
  const p = parts(ts, tz);
  const t = `${p2(p.h)}:${p2(p.mi)}` + (withSec ? `:${p2(p.s)}` : '');
  return `${p.y}-${p2(p.mo)}-${p2(p.d)} ${t} ${tz === 'UTC' ? 'UTC' : p.tzn}`;
}

/** Local wall time in tz -> UTC ms (iterates the offset, DST-safe). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let guess = naive;
  for (let k = 0; k < 3; k++) {
    const p = parts(guess, tz);
    const off = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - guess;
    guess = naive - off;
  }
  return guess;
}

export interface LocalInfo {
  tz: string;
  mod: number; // minute of day
  hm: string;
  hms: string;
  date: string; // "Mon 05.10."
  dkey: number; // local day key
  dshort: string;
  dnum: number; // local day number (days since epoch of the local date)
  ym: number; // year * 12 + month
  mlabel: string;
}

const liCache = new WeakMap<object, LocalInfo>();
/** Local time info of a candle start, cached per candle object and tz. */
export function localInfo(c: { start_ts: number }, tz: string): LocalInfo {
  const hit = liCache.get(c);
  if (hit && hit.tz === tz) return hit;
  const p = parts(c.start_ts, tz);
  const hm = `${p2(p.h)}:${p2(p.mi)}`;
  const li: LocalInfo = {
    tz, mod: p.h * 60 + p.mi, hm, hms: `${hm}:${p2(p.s)}`,
    date: `${p.wd} ${p2(p.d)}.${p2(p.mo)}.`, dkey: p.y * 400 + p.mo * 32 + p.d,
    dshort: `${p2(p.d)}.${p2(p.mo)}.${p.mo === 1 && p.d <= 7 ? ` ${p.y}` : ''}`,
    dnum: Math.floor(Date.UTC(p.y, p.mo - 1, p.d) / DAY), ym: p.y * 12 + p.mo - 1, mlabel: `${p.mo}/${p.y}`,
  };
  liCache.set(c, li);
  return li;
}

export const dayNum = (iso: string) => Math.floor(Date.parse(iso + 'T00:00:00Z') / DAY);
export const isoDay = (dn: number) => new Date(dn * DAY).toISOString().slice(0, 10);
