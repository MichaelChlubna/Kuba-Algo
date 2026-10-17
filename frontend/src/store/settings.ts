// Settings remembered in the browser (localStorage 'fp.settings'): view choices, colors, thresholds, layout.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ColorKey } from '../chart/themes';
import type { Lang } from '../i18n';

export type CellMode = 'delta' | 'sellbuy' | 'volume';
export type ThemeName = 'dark' | 'light';

export interface Layers {
  sess: boolean; sessHL: boolean; sessVP: boolean; sessDP: boolean;
  dayHL: boolean; dayVP: boolean; dayDP: boolean;
  vwap: boolean; rangeVP: boolean;
}

export interface ImbalanceSettings {
  show: boolean;
  ratioPct: number; // 300 = buy >= 3 x sell one level away
  minUsd: number;
  stackMin: number;
}

export interface Settings {
  lang: Lang;
  theme: ThemeName;
  agg: string;
  bin: number | null; // null = server default
  mode: CellMode;
  tz: string | null; // null = server default (America/New_York)
  oiUnit: 'btc' | 'usd';
  profile: boolean;
  dprofile: boolean;
  layers: Layers;
  imbalance: ImbalanceSettings;
  colors: Record<ThemeName, Partial<Record<ColorKey, string>>>;
  layout: { side: boolean; table: boolean; oi: boolean };
}

export const DEFAULT_SETTINGS: Settings = {
  lang: 'cs', theme: 'dark', agg: '5m', bin: null, mode: 'delta', tz: null, oiUnit: 'btc',
  profile: false, dprofile: false,
  layers: { sess: false, sessHL: false, sessVP: false, sessDP: false, dayHL: false, dayVP: false, dayDP: false, vwap: false, rangeVP: false },
  imbalance: { show: true, ratioPct: 300, minUsd: 50_000, stackMin: 3 },
  colors: { dark: {}, light: {} },
  layout: { side: true, table: true, oi: true },
};

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void;
  setLayer: (k: keyof Layers, v: boolean) => void;
  setImbalance: (patch: Partial<ImbalanceSettings>) => void;
  setColor: (k: ColorKey, hex: string | null) => void;
  setLayout: (patch: Partial<Settings['layout']>) => void;
  resetAppearance: () => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      set: (patch) => set(patch),
      setLayer: (k, v) => set((s) => ({ layers: { ...s.layers, [k]: v } })),
      setImbalance: (patch) => set((s) => ({ imbalance: { ...s.imbalance, ...patch } })),
      setColor: (k, hex) => set((s) => {
        const cur = { ...s.colors[s.theme] };
        if (hex) cur[k] = hex; else delete cur[k];
        return { colors: { ...s.colors, [s.theme]: cur } };
      }),
      setLayout: (patch) => set((s) => ({ layout: { ...s.layout, ...patch } })),
      resetAppearance: () => set({ colors: DEFAULT_SETTINGS.colors, imbalance: DEFAULT_SETTINGS.imbalance, layout: DEFAULT_SETTINGS.layout }),
    }),
    {
      name: 'fp.settings',
      version: 1,
      // keep defaults for keys added in later versions
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Settings>;
        return { ...current, ...p, layers: { ...current.layers, ...p.layers }, imbalance: { ...current.imbalance, ...p.imbalance },
                 colors: { ...current.colors, ...p.colors }, layout: { ...current.layout, ...p.layout } };
      },
    },
  ),
);
