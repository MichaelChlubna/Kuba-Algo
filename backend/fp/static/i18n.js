'use strict';
// UI strings (cs / en). t(key, ...args): plain strings, or functions taking the interpolated values.
// Static HTML uses data-i18n (text), data-i18n-title (tooltip) and data-i18n-ph (placeholder).

const I18N = {
  cs: {
    // toolbar, layers, help (static HTML)
    agg: 'Agregace', threshold: 'práh', cell: 'Buňka', from: 'Od', to: 'Do',
    load: 'Načíst', load_tt: 'Načíst celý rozsah (dny v zobrazeném časovém pásmu) a zobrazit ho celý',
    all: 'Vše', all_tt: 'Načíst celý dostupný dataset',
    layers: 'Vrstvy ▾', layers_tt: 'Sessions a dny: pásy, high/low, volume a delta profil',
    sess_bands: 'pásy sessions', vprofile: 'volume profil', dprofile: 'delta profil', days: 'Dny',
    layers_note: 'Profily v aktuálním binu; volume profil od začátku období, delta profil u jeho konce.',
    profile: 'Profil', profile_tt: 'Volume profile každé svíčky (On/Off)',
    dprofile_btn: 'Δ Profil', dprofile_tt: 'Delta profile každé svíčky (On/Off)',
    oi_tt: 'Jednotky ΔOI', theme_tt: 'Přepnout tmavý / světlý režim', lang_tt: 'Jazyk',
    help: 'kolečko = zoom čas · Ctrl/Shift + kolečko = zoom cena · tažení osy = škálování (cenová ↕, časová ↔) · tažení = posun · dvojklik = reset (na ose jen té osy) · klik = detail svíčky',
    candle: 'Svíčka', click_candle: 'Klikni na svíčku.',
    // dynamic
    theme_light: '☀ Světlý', theme_dark: '☾ Tmavý', custom_threshold: 'Vlastní práh…',
    day_def: '(kalendářní den ve zvoleném pásmu)',
    loading: 'Načítám…', loading_detail: 'Načítám detail…',
    err: 'Chyba: ', err_load: 'Chyba načítání: ', err_fp: 'Chyba footprintu: ', err_periods: 'Chyba sessions/dnů: ',
    err_detail: 'Chyba detailu: ', err_build: (agg, e) => `Chyba výpočtu ${agg}: ${e}`,
    no_data: 'Žádná data – spusť python -m fp build',
    computing: (agg, done, total) => `Počítám ${agg}: ${done}/${total} dní…`,
    mode_text: 'buňky + čísla', mode_cells: 'buňky', mode_candles: 'jen svíčky',
    range_too_big: (agg, est, lim, maxDays) => `Rozsah je pro ${agg} moc velký (~${est} svíček, limit ${lim}); zvol max ~${maxDays} dní nebo hrubší agregaci.`,
    range_too_big_agg: (from, to, agg, est, lim) => `Rozsah ${from} … ${to} je pro ${agg} moc velký (~${est} svíček, limit ${lim}) – zobrazen výřez kolem středu, další data se dočítají při posunu.`,
    loading_range: (agg, from, to, done, total) => `Načítám ${agg} ${from} … ${to}: ${done}/${total}`,
    // tooltip + candle detail
    no_snapshot: '— (bez snapshotu)', oi_no_boundary: '— (žádná hranice 5min snapshotu)',
    short_history: 'n/a (málo historie)', short_history_dash: '— (málo historie)',
    z_speed: (w) => `z rychlosti ${w} svíček`,
    green: 'zelená', red: 'červená', color_close: 'Barva · close pos', rel_tod: 'Vol / medián času dne',
    lower_wick: 'Spodní knot (long)', upper_wick: 'Horní knot (short)',
    vol_share: 'podíl objemu', range_share: 'podíl na range', conc: 'koncentrace',
    sell_in_wick: 'sell v knotu / sell', buy_in_wick: 'buy v knotu / buy',
    // intra-candle metrics
    delta_path: 'Průběh delty uvnitř svíčky', cum_delta: 'min / max kum. delta',
    recov_long: 'návrat od min (long)', recov_short: 'pokles od max (short)',
    t_lowhigh: 'low / high v čase', t_dminmax: 'min / max delty v čase',
    extremes: (b) => `Extrémy (${b} USD bucket)`,
    auction_low: 'aukce low: buy / sell', auction_high: 'aukce high: buy / sell',
    finished: 'dokončená', unfinished: 'nedokončená',
    exh_low: 'vyčerpání low: 1 / 2 buckety vs POC', exh_high: 'vyčerpání high: 1 / 2 buckety vs POC',
    wicks: 'Knoty', lower: 'spodní', upper: 'horní',
    effort: 'úsilí: USD / 1 USD pohybu', vs_body: '… vs tělo',
    big_trades: (b) => `velké obchody ≥${b} BTC`, big_against: '… velké proti směru',
    avg_trade: 'prům. obchod', trade_rate: 'obchody / s', time_in_wick: 'čas v knotu',
    body_line: (avg, rate, eff) => `tělo: prům. obchod ${avg}, ${rate} obchodů/s, úsilí ${eff}`,
    of_volume: 'objemu', oi_falling: 'OI klesá: zavírání pozic / likvidace', oi_rising: 'OI roste: otevírání nových pozic',
  },
  en: {
    agg: 'Aggregation', threshold: 'threshold', cell: 'Cell', from: 'From', to: 'To',
    load: 'Load', load_tt: 'Load the whole range (days in the displayed time zone) and fit it to the view',
    all: 'All', all_tt: 'Load the whole available dataset',
    layers: 'Layers ▾', layers_tt: 'Sessions and days: bands, high/low, volume and delta profile',
    sess_bands: 'session bands', vprofile: 'volume profile', dprofile: 'delta profile', days: 'Days',
    layers_note: 'Profiles at the current bin; volume profile from the period start, delta profile at its end.',
    profile: 'Profile', profile_tt: 'Volume profile of each candle (On/Off)',
    dprofile_btn: 'Δ Profile', dprofile_tt: 'Delta profile of each candle (On/Off)',
    oi_tt: 'ΔOI units', theme_tt: 'Toggle dark / light mode', lang_tt: 'Language',
    help: 'wheel = zoom time · Ctrl/Shift + wheel = zoom price · drag an axis = scale (price ↕, time ↔) · drag = pan · double-click = reset (on an axis: that axis only) · click = candle detail',
    candle: 'Candle', click_candle: 'Click a candle.',
    theme_light: '☀ Light', theme_dark: '☾ Dark', custom_threshold: 'Custom threshold…',
    day_def: '(calendar day in the selected time zone)',
    loading: 'Loading…', loading_detail: 'Loading detail…',
    err: 'Error: ', err_load: 'Loading error: ', err_fp: 'Footprint error: ', err_periods: 'Sessions/days error: ',
    err_detail: 'Detail error: ', err_build: (agg, e) => `Building ${agg} failed: ${e}`,
    no_data: 'No data – run python -m fp build',
    computing: (agg, done, total) => `Computing ${agg}: ${done}/${total} days…`,
    mode_text: 'cells + numbers', mode_cells: 'cells', mode_candles: 'candles only',
    range_too_big: (agg, est, lim, maxDays) => `Range is too large for ${agg} (~${est} candles, limit ${lim}); pick at most ~${maxDays} days or a coarser aggregation.`,
    range_too_big_agg: (from, to, agg, est, lim) => `Range ${from} … ${to} is too large for ${agg} (~${est} candles, limit ${lim}) – showing a window around the centre, more data loads as you pan.`,
    loading_range: (agg, from, to, done, total) => `Loading ${agg} ${from} … ${to}: ${done}/${total}`,
    no_snapshot: '— (no snapshot)', oi_no_boundary: '— (no 5-min snapshot boundary)',
    short_history: 'n/a (not enough history)', short_history_dash: '— (not enough history)',
    z_speed: (w) => `z of speed of ${w} candles`,
    green: 'green', red: 'red', color_close: 'Color · close pos', rel_tod: 'Vol / time-of-day median',
    lower_wick: 'Lower wick (long)', upper_wick: 'Upper wick (short)',
    vol_share: 'volume share', range_share: 'share of range', conc: 'concentration',
    sell_in_wick: 'sell in wick / sell', buy_in_wick: 'buy in wick / buy',
    delta_path: 'Delta path within the candle', cum_delta: 'min / max cum. delta',
    recov_long: 'recovery from min (long)', recov_short: 'pullback from max (short)',
    t_lowhigh: 'low / high in time', t_dminmax: 'delta min / max in time',
    extremes: (b) => `Extremes (${b} USD bucket)`,
    auction_low: 'low auction: buy / sell', auction_high: 'high auction: buy / sell',
    finished: 'finished', unfinished: 'unfinished',
    exh_low: 'low exhaustion: 1 / 2 buckets vs POC', exh_high: 'high exhaustion: 1 / 2 buckets vs POC',
    wicks: 'Wicks', lower: 'lower', upper: 'upper',
    effort: 'effort: USD per 1 USD move', vs_body: '… vs body',
    big_trades: (b) => `large trades ≥${b} BTC`, big_against: '… large against direction',
    avg_trade: 'avg trade', trade_rate: 'trades / s', time_in_wick: 'time in wick',
    body_line: (avg, rate, eff) => `body: avg trade ${avg}, ${rate} trades/s, effort ${eff}`,
    of_volume: 'of volume', oi_falling: 'OI falling: positions closing / liquidations', oi_rising: 'OI rising: new positions opening',
  },
};

let LANG = 'cs';
function t(key, ...args) {
  const v = key in I18N[LANG] ? I18N[LANG][key] : I18N.cs[key];
  return typeof v === 'function' ? v(...args) : v;
}
const numLocale = () => (LANG === 'cs' ? 'cs-CZ' : 'en-US');

function applyStaticI18n() {
  document.documentElement.lang = LANG;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
}
