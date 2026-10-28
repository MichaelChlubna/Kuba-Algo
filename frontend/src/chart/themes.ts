// Canvas palettes; the HTML parts use the matching CSS variables (index.css, [data-theme]).
export type RGB = [number, number, number];

export interface Theme {
  bg: string; grid: string; axis: string; text: string; dim: string;
  green: RGB; red: RGB; blue: RGB; neutral: RGB;
  cellText: string; fillMax: number; selFill: string; selStroke: string;
  sep: string; daySep: string; rowA: string; rowB: string; oiBg: string; oiLine: RGB; zero: string;
  cross: string; crossBg: string; tagText: string;
  vprof: RGB; dprof: RGB; vwap: RGB;
  sess: RGB[]; dayLine: RGB;
}

export const THEMES: Record<'dark' | 'light', Theme> = {
  dark: {
    bg: '#0e1015', grid: '#1a1e27', axis: '#7a8292', text: '#c9ced8', dim: '#5d6575',
    green: [38, 166, 91], red: [224, 72, 72], blue: [76, 141, 255], neutral: [138, 143, 153],
    cellText: '#eef0f4', fillMax: 0.85, selFill: 'rgba(255,255,255,0.05)', selStroke: 'rgba(255,255,255,0.35)',
    sep: '#232835', daySep: '#2b3140', rowA: '#151922', rowB: '#12151c', oiBg: '#11141b', oiLine: [222, 226, 236], zero: '#3a4150',
    cross: 'rgba(200,205,215,0.35)', crossBg: '#2a3550', tagText: '#ffffff',
    vprof: [240, 180, 41], dprof: [192, 132, 252], vwap: [64, 200, 230],
    sess: [[0, 170, 170], [90, 140, 255], [230, 100, 170]], dayLine: [200, 205, 215],
  },
  light: { // cream background, no pure white
    bg: '#f8f4e4', grid: '#e8e1c9', axis: '#6b6450', text: '#2b2a26', dim: '#9a927a',
    green: [24, 140, 70], red: [206, 52, 52], blue: [44, 104, 204], neutral: [120, 114, 98],
    cellText: '#1d1c19', fillMax: 0.6, selFill: 'rgba(60,50,20,0.06)', selStroke: 'rgba(60,50,20,0.45)',
    sep: '#d9d0b5', daySep: '#cfc5a6', rowA: '#f1ebd6', rowB: '#ece5cd', oiBg: '#f2ecd8', oiLine: [58, 54, 44], zero: '#b9b096',
    cross: 'rgba(70,60,35,0.4)', crossBg: '#4a5672', tagText: '#ffffff',
    vprof: [196, 98, 0], dprof: [118, 52, 214], vwap: [0, 130, 160],
    sess: [[0, 128, 128], [40, 90, 200], [190, 50, 130]], dayLine: [60, 55, 40],
  },
};

/** User-adjustable colors (Settings), stored per theme as hex. */
export const COLOR_KEYS = ['green', 'red', 'blue', 'vprof', 'dprof', 'vwap'] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];

export const hexToRgb = (h: string): RGB => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [128, 128, 128];
};
export const rgbToHex = (c: RGB) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

export function themeWith(name: 'dark' | 'light', overrides: Partial<Record<ColorKey, string>> | undefined): Theme {
  const base = THEMES[name];
  if (!overrides) return base;
  const t = { ...base };
  for (const k of COLOR_KEYS) if (overrides[k]) t[k] = hexToRgb(overrides[k]!);
  return t;
}

export const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
