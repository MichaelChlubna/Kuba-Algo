# BTCUSDT perp – výzkum order flow

| složka / soubor | obsah |
|---|---|
| `viewer.bat` | spustí footprint viewer (http://localhost:8000) |
| `start.bat` | menu: viewer, aktualizace dat (stažení + build do včerejška), validace, testy, instalace knihoven |
| `data/` | sdílená data pro všechny fáze: `raw/` (zipy Binance), `parquet/` (aggTrades, metrics, klines po dnech), `derived/` (svíčky s features a metrikami, footprint, series), `validation/` |
| `viewer/` | **fáze 1 (hotovo):** pipeline, footprint viewer (CZ / EN), features knotů, metriky uvnitř svíček – viz [viewer/README.md](viewer/README.md) a [viewer/metodika.md](viewer/metodika.md) |

Pro navazující analýzy: hotové svíčky se všemi features, podmínkami a metrikami jsou v
`data/derived/series/<agg>/YYYY-MM-DD.parquet` (agg = `1m`, `5m`, `15m`, `vusd_<práh>`, `vbtc_<práh>`),
slovník sloupců je v `viewer/metodika.md`, příloha 15.
