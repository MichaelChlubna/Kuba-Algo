# Datové struktury API

Jediné místo, kde jsou popsané struktury sdílené backendem (`backend/fp/server.py`) a frontendem
(`frontend/src/api/types.ts`). Při změně upravte oba soubory.

Konvence:

- časy jsou **UTC epoch milisekundy**, intervaly jsou polootevřené `[start, end)`,
- ceny v USD, objemy v BTC (`volume`, `buy`, `sell`, `delta`) nebo v USD (`*_usd`),
- tabulky se posílají **sloupcově**: `{"n": počet řádků, "cols": {"sloupec": [hodnoty…]}}` (typ `Columnar<T>`),
  odpovědi jsou komprimované gzipem,
- agregace (`agg`) jsou `1m`, `5m`, `15m` (časové), `vusd_<N>` / `vbtc_<N>` (objemové, práh v USD / BTC)
  a `vtick_<N>` (N aggTrades na svíčku).

## Endpointy

| metoda a cesta | parametry | odpověď |
|---|---|---|
| `GET /api/health` | – | `{status, aggregations, sample}`, vždy bez přihlášení |
| `GET /api/meta` | – | `Meta`: symbol, tick ceny, seznam agregací s rozsahem dní, biny, nastavení metrik a session |
| `GET /api/candles` | `agg, start, end, pad=0, full=false` | `Columnar<Candle>`; `pad` = počet svíček před `start` (pro klouzavé výpočty) |
| `GET /api/candle` | `agg, cid, start_ts` | `CandleFull`: všechny sloupce jedné svíčky (features a metriky, viz `metodika.md`), 404 když neexistuje |
| `GET /api/footprint` | `agg, start, end` | `Columnar<FootprintRow>` v základním binu 5 USD; prohlížeč si přebinuje |
| `GET /api/periods` | `start, end, tz, bin=25` | `PeriodsResponse`: dny a session s high/low a profilem objemu |
| `GET /api/profile` | `start, end, bin=25` | `ProfileResponse`: profil objemu rozsahu, POC a 70 % value area; rozsah max. 400 dní (jinak 413) |
| `POST /api/volume` | `unit=usd\|btc\|tick, value` | `Job`: dopočítá vlastní objemové / tick svíčky na pozadí; 429 když běží jiná úloha |
| `GET /api/jobs` | – | stav úloh `{agg: Job}` |

## Typy

### Candle (lehké sloupce `/api/candles`)

| sloupec | význam |
|---|---|
| `cid` | klíč svíčky: `start_ts` u časových, pořadové číslo u objemových / tick svíček |
| `start_ts`, `end_ts`, `last_ts`, `duration_ms` | začátek, konec (exkluzivní), čas posledního obchodu, délka |
| `open`, `high`, `low`, `close` | OHLC |
| `volume`, `volume_usd` | objem v BTC / USD |
| `delta`, `delta_usd` | taker buy − taker sell |
| `cvd_usd` | kumulativní delta |
| `trades` | počet obchodů |
| `d_oi`, `d_oi_usd` | změna open interest; `null` = ve svíčce není hranice 5min snímku OI |
| `vpoc_<b>`, `dpoc_neg_<b>`, `dpoc_pos_<b>` | POC objemu a záporné / kladné delty pro bin b ∈ {5, 10, 25, 50, 100} (spodní hrana úrovně) |

### FootprintRow

`cid, start_ts, level` (spodní hrana binu), `buy_usd, sell_usd, buy, sell`.

### Period (dny a session)

`id` (`kind|name|key`), `kind` (`day` / `session`), `name`, `key` (místní datum), `start_ts, end_ts, high, low,
volume_usd, delta_usd`. K nim `levels`: `id, level, buy_usd, sell_usd`.

### ProfileResponse

`levels` (`level, buy_usd, sell_usd`), `poc` (úroveň s největším objemem, při shodě nejnižší), `val` / `vah`
(spodní a horní hrana value area: od POC se přidává větší sousední úroveň, při shodě ta vyšší, dokud není
70 % objemu), `volume_usd`, `delta_usd`.

### Job

`status` (`running` / `done` / `error`), `done`, `total`, `error`.

## Výpočty ve frontendu

Imbalance, stacked imbalance a VWAP se počítají v prohlížeči (`frontend/src/lib/footprint.ts`), aby šel práh
měnit bez dotazu na server:

- **imbalance nákupů** na úrovni L: `buy(L) ≥ poměr × sell(L − bin)` a `buy(L) ≥ min. USD`; prodejů zrcadlově
  `sell(L) ≥ poměr × buy(L + bin)`; chybějící sousední úroveň se počítá jako 0. Stejně jako metriky backendu
  (ověřeno testem proti golden datům),
- **stacked imbalance**: alespoň `stackMin` po sobě jdoucích imbalance úrovní stejného směru,
- **VWAP**: kumulativní `volume_usd / volume` od začátku místního dne (zvolené časové pásmo).
