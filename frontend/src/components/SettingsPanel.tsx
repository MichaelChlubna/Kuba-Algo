import { COLOR_KEYS, rgbToHex, THEMES, type ColorKey } from '../chart/themes';
import { useT } from '../hooks';
import type { I18nKey } from '../i18n';
import { useSettings } from '../store/settings';

const COLOR_LABEL: Record<ColorKey, I18nKey> = { green: 'c_green', red: 'c_red', blue: 'c_blue', vprof: 'c_vprof', dprof: 'c_dprof', vwap: 'c_vwap' };

/** Colors (per theme), imbalance thresholds and layout; all remembered in the browser. */
export function SettingsPanel() {
  const t = useT();
  const s = useSettings();
  const colors = s.colors[s.theme];
  const num = (v: string, fallback: number) => (Number.isFinite(+v) && +v > 0 ? +v : fallback);
  return (
    <div className="flex w-72 max-w-full flex-col gap-1.5">
      <div className="pop-h">{t('colors')} <span className="text-[11px] font-normal text-dim">({s.theme})</span></div>
      <div className="grid grid-cols-2 gap-1.5">
        {COLOR_KEYS.map((k) => (
          <label key={k} className="chk">
            <input type="color" value={colors[k] ?? rgbToHex(THEMES[s.theme][k])} onChange={(e) => s.setColor(k, e.target.value)} />
            <span className="text-xs">{t(COLOR_LABEL[k])}</span>
          </label>
        ))}
      </div>
      <div className="pop-h">{t('imb')}</div>
      <label className="chk"><input type="checkbox" checked={s.imbalance.show} onChange={(e) => s.setImbalance({ show: e.target.checked })} /> {t('imb_show')}</label>
      <label className="flex items-center justify-between gap-2 text-xs">{t('imb_ratio')}
        <input className="w-24" type="number" min={100} step={25} value={s.imbalance.ratioPct}
               onChange={(e) => s.setImbalance({ ratioPct: num(e.target.value, 300) })} />
      </label>
      <label className="flex items-center justify-between gap-2 text-xs">{t('imb_min')}
        <input className="w-24" type="number" min={0} step={10000} value={s.imbalance.minUsd}
               onChange={(e) => s.setImbalance({ minUsd: Math.max(0, +e.target.value || 0) })} />
      </label>
      <label className="flex items-center justify-between gap-2 text-xs">{t('imb_stack')}
        <input className="w-24" type="number" min={2} step={1} value={s.imbalance.stackMin}
               onChange={(e) => s.setImbalance({ stackMin: Math.max(2, Math.round(num(e.target.value, 3))) })} />
      </label>
      <div className="text-[11px] text-dim">{t('imb_note')}</div>
      <div className="pop-h">{t('layout')}</div>
      <label className="chk"><input type="checkbox" checked={s.layout.side} onChange={(e) => s.setLayout({ side: e.target.checked })} /> {t('show_side')}</label>
      <label className="chk"><input type="checkbox" checked={s.layout.table} onChange={(e) => s.setLayout({ table: e.target.checked })} /> {t('show_table')}</label>
      <label className="chk"><input type="checkbox" checked={s.layout.oi} onChange={(e) => s.setLayout({ oi: e.target.checked })} /> {t('show_oi')}</label>
      <button className="mt-1 self-start" onClick={() => s.resetAppearance()}>{t('reset')}</button>
    </div>
  );
}
