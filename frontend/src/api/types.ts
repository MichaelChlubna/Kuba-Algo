/**
 * Shared data structures of the API (backend/fp/server.py). Documented in docs/datove-struktury.md;
 * keep both in sync. All timestamps are UTC epoch milliseconds, prices in USD, volumes in BTC or USD.
 */

/** Columnar JSON as returned by the API: `n` rows, one array per column. */
export interface Columnar<T> {
  n: number;
  cols: { [K in keyof T]: T[K][] };
}

/** One aggregation (time, volume or tick candles) available on the server. */
export interface AggregationMeta {
  first_day: string; // ISO date (UTC day)
  last_day: string;
  candles: number;
  per_day: number;
}

export interface SessionDef {
  name: string;
  start: string; // "HH:MM" in sessions.timezone, end exclusive, may wrap midnight
  end: string;
}

export interface Meta {
  symbol: string;
  price_tick: number;
  sample: boolean; // synthetic sample data (fp sample), not real Binance data
  aggregations: Record<string, AggregationMeta>; // "1m" | "5m" | "15m" | "vusd_<N>" | "vbtc_<N>" | "vtick_<N>"
  timezone: string; // default display timezone (IANA)
  base_bin: number; // footprint base bin (USD), 5
  bins: number[]; // display bins, multiples of base_bin
  default_bin: number;
  volume_usd: number[];
  volume_btc: number[];
  features: { n?: number; vol_window?: number; tod_days?: number; tod_timezone?: string };
  metrics: { imbalance_ratio: number; imbalance_min_usd: number; stack_min: number; big_trade_btc: number };
  metric_cols: string[];
  sessions: { timezone: string; list: SessionDef[] };
  max_light_candles: number;
  live: LiveStatus | null; // null = live data off on the server (FP_LIVE)
}

/** State of the live Binance feed (GET /api/meta `live`, WebSocket /api/live `status`). */
export interface LiveStatus {
  state: 'waiting' | 'starting' | 'backfill' | 'live' | 'reconnecting' | 'off'; // waiting: no real data built yet
  last_ts: number | null; // time of the last live trade
  lag_ms: number | null;
  base_day: string | null; // last day built from the daily dumps; live candles start the day after
  backfill_from?: number | null; // aggTrade id the REST backfill is at
  error?: string | null;
}

/** Message of WebSocket /api/live?agg=: the open candle and candles closed since the last message. */
export interface LiveMessage {
  agg: string;
  status: LiveStatus;
  candles?: Columnar<Candle>;
  fp?: Columnar<FootprintRow>;
}

/** Candle with the light columns of GET /api/candles (enough for chart, table, tooltip, POC markers). */
export interface Candle {
  cid: number; // unique key: start_ts for time candles, sequence number for volume / tick candles
  start_ts: number;
  end_ts: number;
  last_ts: number;
  duration_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // BTC
  volume_usd: number;
  delta: number; // taker buy - taker sell, BTC
  delta_usd: number;
  cvd_usd: number;
  trades: number;
  d_oi: number | null; // null = no 5-min OI snapshot boundary inside the candle
  d_oi_usd: number | null;
  /** POC levels (lower bucket edge) per bin b in {5,10,25,50,100}: vpoc_b, dpoc_neg_b, dpoc_pos_b */
  [poc: `${'vpoc' | 'dpoc_neg' | 'dpoc_pos'}_${number}`]: number | null;
}

/** All columns of one candle (GET /api/candle): features and intra-candle metrics, see docs/metodika.md. */
export type CandleFull = Candle & Record<string, number | boolean | null>;

/** Footprint row of GET /api/footprint: one candle and price level in the base bin. */
export interface FootprintRow {
  cid: number;
  start_ts: number;
  level: number; // lower edge of the bin, USD
  buy_usd: number; // taker buy notional at the level
  sell_usd: number;
  buy: number; // BTC
  sell: number;
}

/** Footprint of one candle in the browser: parallel arrays sorted by level. */
export interface CandleFootprint {
  lv: number[];
  b: number[]; // buy USD
  s: number[]; // sell USD
}

/** Session or day of GET /api/periods. */
export interface Period {
  id: string; // "kind|name|key"
  kind: 'day' | 'session';
  name: string;
  key: string; // local date the period belongs to
  start_ts: number;
  end_ts: number;
  high: number;
  low: number;
  volume_usd: number;
  delta_usd: number;
}

export interface PeriodsResponse {
  periods: Columnar<Period>;
  levels: Columnar<{ id: string; level: number; buy_usd: number; sell_usd: number }>;
}

/** GET /api/profile: volume profile of a time range with POC and 70 % value area. */
export interface ProfileResponse {
  levels: Columnar<{ level: number; buy_usd: number; sell_usd: number }>;
  poc: number | null;
  vah: number | null; // upper edge of the value area
  val: number | null; // lower edge
  volume_usd: number;
  delta_usd: number;
}

export interface Job {
  status: 'running' | 'done' | 'error';
  done?: number;
  total?: number;
  error?: string;
}
