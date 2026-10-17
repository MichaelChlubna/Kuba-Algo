import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChartEngine } from '../chart/engine';
import { useT } from '../hooks';
import { aggLabel, TF_MIN } from '../lib/format';
import { useSettings, type CellMode, type Layers } from '../store/settings';
import { useUi } from '../store/ui';
import { SettingsPanel } from './SettingsPanel';

/** Popover that closes on an outside click. */
function Pop({ label, title, active, children, align = 'left' }: { label: ReactNode; title?: string; active?: boolean; children: ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <span ref={ref} className="relative inline-block">
      <button title={title} className={active ? 'btn-on' : ''} onClick={() => setOpen(!open)}>{label}</button>
      {open && <div className={`pop ${align === 'right' ? 'right-0' : 'left-0'}`}>{children}</div>}
    </span>
  );
}

function Seg<T extends string>({ value, options, onChange, title }: { value: T; options: [T, string][]; onChange: (v: T) => void; title?: string }) {
  return (
    <span className="seg" title={title}>
      {options.map(([v, label]) => <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>{label}</button>)}
    </span>
  );
}

export function Toolbar({ engine }: { engine: ChartEngine | null }) {
  const t = useT();
  const s = useSettings();
  const meta = useUi((u) => u.meta);
  const status = useUi((u) => u.status);
  const rangeFrom = useUi((u) => u.rangeFrom), rangeTo = useUi((u) => u.rangeTo);
  const setUi = useUi((u) => u.set);
  const [custom, setCustom] = useState(false);
  const [cv, setCv] = useState('');
  const [cu, setCu] = useState<'usd' | 'btc' | 'tick'>('usd');
  const [more, setMore] = useState(false); // narrow screens: secondary controls folded away
  const tz = s.tz || meta?.timezone || 'America/New_York';
  const bin = s.bin || meta?.default_bin || 25;

  const aggs = meta ? Object.keys(meta.aggregations).sort((a, b) => (TF_MIN[a] ?? 1e6) - (TF_MIN[b] ?? 1e6) || a.localeCompare(b)) : [];
  const layer = (k: keyof Layers, label: string) => (
    <label className="chk"><input type="checkbox" checked={s.layers[k]} onChange={(e) => s.setLayer(k, e.target.checked)} /> {label}</label>
  );
  const anyLayer = Object.values(s.layers).some(Boolean);
  const sd = meta?.sessions;
  const go = () => engine?.loadRange(rangeFrom, rangeTo);
  const runCustom = async () => {
    const agg = await engine?.customAgg(cu, +cv);
    if (agg) setCustom(false);
  };

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-panel px-2.5 py-1.5">
      <span className="mr-1 font-semibold text-strong">{meta?.symbol ?? 'BTCUSDT'} perp</span>
      {meta?.sample && <span className="rounded border border-line px-1.5 text-[11px] text-dim" title={t('sample_tt')}>{t('sample_badge')}</span>}
      <label className="inline-flex items-center gap-1.5 text-dim">{t('agg')}
        <select value={custom ? '__custom' : s.agg} onChange={(e) => {
          if (e.target.value === '__custom') { setCustom(true); return; }
          setCustom(false); s.set({ agg: e.target.value });
        }}>
          {aggs.map((a) => <option key={a} value={a}>{aggLabel(a, t('ticks'))}</option>)}
          <option value="__custom">{t('custom_threshold')}</option>
        </select>
      </label>
      {custom && (
        <span className="inline-flex items-center gap-1">
          <input className="w-24" type="number" min={1} step="any" placeholder={t('threshold')} value={cv}
                 onChange={(e) => setCv(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runCustom()} />
          <select value={cu} onChange={(e) => setCu(e.target.value as typeof cu)} title={cu === 'tick' ? t('custom_tick_note') : undefined}>
            <option value="usd">USD</option><option value="btc">BTC</option><option value="tick">{t('unit_tick')}</option>
          </select>
          <button onClick={runCustom}>OK</button>
        </span>
      )}
      <label className="inline-flex items-center gap-1.5 text-dim">Bin
        <select value={bin} onChange={(e) => s.set({ bin: +e.target.value })}>
          {(meta?.bins ?? [5, 10, 25, 50, 100]).map((b) => <option key={b} value={b}>{b} USD</option>)}
        </select>
      </label>
      <button className={`md:hidden ${more ? 'btn-on' : ''}`} onClick={() => setMore(!more)} aria-label="menu">☰</button>
      <div className={more ? 'contents' : 'hidden md:contents'}>
      <label className="inline-flex items-center gap-1.5 text-dim">{t('cell')}
        <select value={s.mode} onChange={(e) => s.set({ mode: e.target.value as CellMode })}>
          <option value="delta">delta</option><option value="sellbuy">sell × buy</option><option value="volume">volume</option>
        </select>
      </label>
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <label className="inline-flex items-center gap-1.5 text-dim">{t('from')}
          <input type="date" value={rangeFrom} onChange={(e) => setUi({ rangeFrom: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && go()} />
        </label>
        <label className="inline-flex items-center gap-1.5 text-dim">{t('to')}
          <input type="date" value={rangeTo} onChange={(e) => setUi({ rangeTo: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && go()} />
        </label>
        <button title={t('load_tt')} onClick={go}>{t('load')}</button>
        <button title={t('all_tt')} onClick={() => engine?.loadAll()}>{t('all')}</button>
      </span>
      <Pop label={t('layers')} title={t('layers_tt')} active={anyLayer}>
        <div className="pop-h">Sessions <span className="text-[11px] font-normal text-dim">
          ({sd?.list.map((x) => `${x.name} ${x.start}–${x.end}`).join(', ')}, {sd?.timezone === 'America/New_York' ? 'NY' : sd?.timezone})</span></div>
        {layer('sess', t('sess_bands'))}{layer('sessHL', 'high / low')}{layer('sessVP', t('vprofile'))}{layer('sessDP', t('dprofile'))}
        <div className="pop-h">{t('days')} <span className="text-[11px] font-normal text-dim">{t('day_def')}</span></div>
        {layer('dayHL', 'high / low')}{layer('dayVP', t('vprofile'))}{layer('dayDP', t('dprofile'))}
        <div className="text-[11px] text-dim">{t('layers_note')}</div>
        <div className="pop-h">{t('overlays')}</div>
        {layer('vwap', t('vwap_day'))}{layer('rangeVP', t('rvp') + ' (POC, VAH/VAL 70 %)')}
      </Pop>
      <button className={`toggle-vp ${s.profile ? 'on' : ''}`} title={t('profile_tt')} onClick={() => s.set({ profile: !s.profile })}>{t('profile')}</button>
      <button className={`toggle-dp ${s.dprofile ? 'on' : ''}`} title={t('dprofile_tt')} onClick={() => s.set({ dprofile: !s.dprofile })}>{t('dprofile_btn')}</button>
      <button className={s.imbalance.show ? 'btn-on' : ''} title={t('imb_tt')} onClick={() => s.setImbalance({ show: !s.imbalance.show })}>
        {t('imb')} {s.imbalance.ratioPct}%
      </button>
      <Seg value={tz === 'UTC' ? 'UTC' : 'America/New_York'} options={[['America/New_York', 'NY'], ['UTC', 'UTC']]} onChange={(v) => s.set({ tz: v })} />
      <Seg value={s.oiUnit} options={[['btc', 'ΔOI BTC'], ['usd', 'USD']]} onChange={(v) => s.set({ oiUnit: v })} title={t('oi_tt')} />
      <button title={t('theme_tt')} onClick={() => s.set({ theme: s.theme === 'dark' ? 'light' : 'dark' })}>
        {s.theme === 'dark' ? t('theme_light') : t('theme_dark')}
      </button>
      <Seg value={s.lang} options={[['cs', 'CZ'], ['en', 'EN']]} onChange={(v) => s.set({ lang: v })} title={t('lang_tt')} />
      <Pop label={`⚙ ${t('settings')}`} title={t('settings_tt')} align="right"><SettingsPanel /></Pop>
      {!s.layout.side && <button onClick={() => s.setLayout({ side: true })}>{t('detail_show')}</button>}
      </div>
      <span className="ml-auto font-mono text-xs text-dim">{status}</span>
    </header>
  );
}
