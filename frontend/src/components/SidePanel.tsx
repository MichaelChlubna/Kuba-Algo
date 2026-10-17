import type { ReactNode } from 'react';
import { useT } from '../hooks';
import { fmtDur, fmtK, fmtNum, fmtPrice, isTimeAgg } from '../lib/format';
import { fmtTs } from '../lib/time';
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';

type V = number | boolean | null | undefined;
const n = (v: V) => (typeof v === 'number' ? v : null);
const sgn = (v: V) => { const x = n(v); return x === null ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : ''; };
const Signed = ({ v, children }: { v: V; children: ReactNode }) => <span className={sgn(v)}>{children}</span>;

function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <table className="kv"><tbody>
      {rows.map(([a, b], i) => <tr key={i}><td>{a}</td><td>{b}</td></tr>)}
    </tbody></table>
  );
}

/** Detail of the selected candle: features, wick components and intra-candle metrics (docs/metodika.md). */
export function SidePanel({ overlay = false }: { overlay?: boolean }) {
  const t = useT();
  const c = useUi((s) => s.selected);
  const meta = useUi((s) => s.meta);
  const agg = useSettings((s) => s.agg);
  const tz = useSettings((s) => s.tz) || meta?.timezone || 'America/New_York';
  const setLayout = useSettings((s) => s.setLayout);
  const close = () => (overlay ? useUi.getState().set({ selected: null }) : setLayout({ side: false }));

  let body: ReactNode;
  if (!c) body = <span className="text-dim">{t('click_candle')}</span>;
  else if (!c._full) body = <span className="text-dim">{t('loading_detail')}</span>;
  else {
    const g = (k: string) => c[k] as V;
    const vol = !isTimeAgg(agg), fc = meta?.features ?? {}, mc = meta?.metrics;
    const f3 = (v: V) => fmtNum(n(v), 3);
    const pct = (v: V) => (n(v) === null ? '—' : `${(n(v)! * 100).toFixed(0)} %`);
    const x = (v: V, d = 2) => (n(v) === null ? '—' : `${n(v)!.toFixed(d)}×`);
    const num = (v: V, d = 1) => (n(v) === null ? '—' : n(v)!.toFixed(d));
    const usd = (v: V) => (n(v) === null ? '—' : fmtK(n(v), false));
    const sd = (v: V) => <Signed v={v}>{fmtK(n(v))}</Signed>;
    const auction = (b: V, s: V, unf: V) => <>{usd(b)} / {usd(s)} · {unf ? t('unfinished') : <b>{t('finished')}</b>}</>;
    const zTxt = n(g('z')) === null ? t('short_history') : n(g('z'))!.toFixed(3);
    const vs = n(g('vspeed'));
    const zLabel = vol ? `${t('z_speed', fc.vol_window || 10)}${vs !== null ? ` (${fmtDur(Math.exp(-vs))})` : ''}` : `z(ln Vol_USD), N=${fc.n || 30}`;
    const dOi = n(c.d_oi);
    const oiTxt = dOi === null ? t('oi_no_boundary') : <Signed v={dOi}>{dOi >= 0 ? '+' : '−'}{Math.abs(dOi).toFixed(1)} BTC / {fmtK(c.d_oi_usd)}</Signed>;
    const color = n(g('color'));
    const colorTxt = color! > 0 ? <span className="pos">{t('green')}</span> : color! < 0 ? <span className="neg">{t('red')}</span> : 'doji';
    const wick = (p: 'lw' | 'uw') => (
      <KV rows={[
        ['Vol(K)', `${fmtK(n(g(`${p}_vol_usd`)), false)} · ${fmtNum(n(g(`${p}_vol`)), 2)} BTC`],
        ['Buy(K) / Sell(K)', `${fmtK(n(g(`${p}_buy_usd`)), false)} / ${fmtK(n(g(`${p}_sell_usd`)), false)}`],
        [t('vol_share'), f3(g(`${p}_share`))], [t('range_share'), f3(g(`${p}_range`))], [t('conc'), fmtNum(n(g(`${p}_conc`)), 2)],
        ['Δ(K) · Δ(K)/Vol(K)', <>{sd(g(`${p}_delta_usd`))} · {fmtNum(n(g(`${p}_delta_ratio`)), 3)}</>],
        p === 'lw' ? [t('sell_in_wick'), f3(g('lw_sell_share'))] : [t('buy_in_wick'), f3(g('uw_buy_share'))],
      ]} />
    );
    const oiv = n(g('oi_vol_ratio'));
    const minUsd = n(g('dpath_min_usd')), maxUsd = n(g('dpath_max_usd')), volUsd = c.volume_usd;
    const lu = (a: string, b: string) => [g(a), g(b)] as const;
    const three: [ReactNode, ReactNode, ReactNode][] = [
      [`imbalance buy (stack) ≥${mc?.imbalance_ratio}:1`, `${g('lw_buy_imb')} (${g('lw_buy_stack')})`, `${g('uw_buy_imb')} (${g('uw_buy_stack')})`],
      ['imbalance sell (stack)', `${g('lw_sell_imb')} (${g('lw_sell_stack')})`, `${g('uw_sell_imb')} (${g('uw_sell_stack')})`],
      [t('effort'), ...lu('lw_effort', 'uw_effort').map(usd)] as [string, string, string],
      [t('vs_body'), x(g('lw_effort_ratio')), x(g('uw_effort_ratio'))],
      [t('big_trades', mc?.big_trade_btc ?? 5), `${pct(g('lw_big_share'))} (${g('lw_big_count')})`, `${pct(g('uw_big_share'))} (${g('uw_big_count')})`],
      [t('big_against'), `sell ${pct(g('lw_big_sell_share'))}`, `buy ${pct(g('uw_big_buy_share'))}`],
      [t('avg_trade'), usd(g('lw_avg_trade_usd')), usd(g('uw_avg_trade_usd'))],
      [t('vs_body'), x(g('lw_size_ratio')), x(g('uw_size_ratio'))],
      [t('trade_rate'), num(g('lw_rate')), num(g('uw_rate'))],
      [t('vs_body'), x(g('lw_rate_ratio')), x(g('uw_rate_ratio'))],
      [t('time_in_wick'), pct(g('lw_time_frac')), pct(g('uw_time_frac'))],
    ];
    body = (
      <>
        <div>{vol ? `${fmtTs(c.start_ts, tz, true)} → ${fmtTs(c.last_ts, tz, true)}` : fmtTs(c.start_ts, tz)}</div>
        <h3>{t('candle')}</h3>
        <KV rows={[
          ['O / H', `${fmtPrice(c.open)} / ${fmtPrice(c.high)}`], ['L / C', `${fmtPrice(c.low)} / ${fmtPrice(c.close)}`],
          ['Volume', `${fmtK(c.volume_usd, false)} · ${c.volume.toFixed(2)} BTC`],
          ['Buy / Sell', `${fmtK(n(g('buy_usd')), false)} / ${fmtK(n(g('sell_usd')), false)}`],
          ['Delta', <><Signed v={c.delta_usd}>{fmtK(c.delta_usd)}</Signed> · {fmtNum(n(g('delta_ratio')), 3)} vol</>],
          ['CVD', <Signed v={c.cvd_usd}>{fmtK(c.cvd_usd)}</Signed>],
          [t('color_close'), <>{colorTxt} · {fmtNum(n(g('close_pos')), 3)}</>],
          ['Trades', c.trades.toLocaleString('en-US')], ['Duration', fmtDur(c.duration_ms)],
          ['ΔOI', oiTxt],
          [t('rel_tod'), n(g('rel_tod')) === null ? t('short_history_dash') : n(g('rel_tod'))!.toFixed(2) + '×'],
          [zLabel, zTxt],
        ]} />
        <h3>{t('lower_wick')}</h3>{wick('lw')}
        <h3>{t('upper_wick')}</h3>{wick('uw')}
        <h3>{t('delta_path')}</h3>
        <KV rows={[
          [t('cum_delta'), <>{sd(minUsd)} / {sd(maxUsd)}</>],
          // ratio only when the extreme is material (>= 1 % of the candle volume), otherwise it explodes
          [t('recov_long'), `${usd(g('d_recov_l_usd'))} · ${minUsd !== null && -minUsd >= 0.01 * volUsd ? pct(g('d_recov_l_ratio')) : '—'}`],
          [t('recov_short'), `${usd(g('d_recov_s_usd'))} · ${maxUsd !== null && maxUsd >= 0.01 * volUsd ? pct(g('d_recov_s_ratio')) : '—'}`],
          [t('t_lowhigh'), `${pct(g('t_low_frac'))} / ${pct(g('t_high_frac'))}`],
          [t('t_dminmax'), `${pct(g('t_dmin_frac'))} / ${pct(g('t_dmax_frac'))}`],
        ]} />
        <h3>{t('extremes', meta?.base_bin ?? 5)}</h3>
        <KV rows={[
          [t('auction_low'), auction(g('low_buy_usd'), g('low_sell_usd'), g('unfinished_low'))],
          [t('auction_high'), auction(g('high_buy_usd'), g('high_sell_usd'), g('unfinished_high'))],
          [t('exh_low'), `${x(g('exh_low'))} / ${x(g('exh_low2'))}`],
          [t('exh_high'), `${x(g('exh_high'))} / ${x(g('exh_high2'))}`],
        ]} />
        <h3>{t('wicks')}</h3>
        <table className="kv"><tbody>
          <tr className="hd"><td /><td>{t('lower')}</td><td>{t('upper')}</td></tr>
          {three.map(([a, l, h], i) => <tr key={i}><td>{a}</td><td>{l}</td><td>{h}</td></tr>)}
        </tbody></table>
        <div className="mt-1.5 text-[11px] text-dim">{t('body_line', usd(g('body_avg_trade_usd')), num(g('body_rate')), usd(g('body_effort')))}</div>
        <h3>Open interest</h3>
        <KV rows={[['ΔOI / volume', oiv === null ? '—' : <><Signed v={oiv}>{(oiv * 100).toFixed(1)} %</Signed> {t('of_volume')} · {oiv < 0 ? t('oi_falling') : t('oi_rising')}</>]]} />
      </>
    );
  }

  return (
    <aside className="side absolute inset-y-0 right-0 z-20 w-[330px] max-w-[90vw] flex-none overflow-y-auto border-l border-line bg-panel px-3 py-2 shadow-xl lg:static lg:shadow-none">
      <div className="mb-2 mt-1.5 flex items-center justify-between">
        <h2 className="text-[13px] uppercase tracking-wider text-dim">{t('candle')}</h2>
        <button className="px-2 py-0 text-dim" title={t('detail_hide')} onClick={close}>×</button>
      </div>
      {body}
    </aside>
  );
}
