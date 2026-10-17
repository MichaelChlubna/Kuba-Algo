# Úkol: BTCUSDT perp – data pipeline, footprint viewer a detektor absorpčních svíček

## Kontext

Stavím daytradingovou strategii na BTCUSDT perpetual (Binance USD-M). Krok 1 je spolehlivě najít svíčky s výrazně nadprůměrným objemem, u kterých většina objemu i agresivních obchodů proti směru proběhla v knotu (absorpce). Potřebuju:

1. pipeline na stažení a zpracování historických dat,
2. footprint graf v prohlížeči (popis níže; pokud máš k dispozici přiložený screenshot reference, řiď se jím vizuálně),
3. detektor, který tyhle svíčky v grafu označí.

Se mnou komunikuj česky. Kód, identifikátory a komentáře piš anglicky.

## 1. Data

Zdroj: veřejné denní dumpy Binance na https://data.binance.vision (bez API klíče). Instrument BTCUSDT, USD-M futures (`um`).

| Dataset | Účel | Očekávaná cesta |
|---|---|---|
| aggTrades | všechno (svíčky, footprint, detektor) | `data/futures/um/daily/aggTrades/BTCUSDT/BTCUSDT-aggTrades-YYYY-MM-DD.zip` |
| metrics | open interest (5min snapshoty) | `data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-YYYY-MM-DD.zip` |
| klines 1m a 5m | jen validace | `data/futures/um/daily/klines/BTCUSDT/5m/BTCUSDT-5m-YYYY-MM-DD.zip` (analogicky 1m) |

Požadavky:

- Cesty a názvy sloupců jsou očekávané, ne ověřené. Před implementací je ověř na reálných souborech (výpis adresáře na data.binance.vision, hlavička CSV). Starší soubory nemusí mít hlavičku, řeš obojí. Ověř jednotky timestampů (ms vs. µs).
- Ke každému zipu existuje `.CHECKSUM` (SHA256), ověřuj ho.
- Downloader musí být idempotentní: přeskočí hotové dny, umí navázat, rozsah dat bere z CLI nebo configu.
- Denní soubory jsou dostupné až následující den.
- Raw CSV převeď do parquetu po dnech. Data jsou velká (miliony řádků denně), použij polars nebo DuckDB.
- Vývojový rozsah: 2026-10-01 až 2026-10-08. Kód musí zvládnout i 3 a více měsíců.

Sémantika aggTrades:

- `is_buyer_maker = true` znamená, že agresor (taker) byl prodávající.
- Jeden řádek může obsahovat víc obchodů (stejná cena, stejná taker strana, do 100 ms). Počet obchodů = `last_trade_id − first_trade_id + 1`.
- Řaď podle `agg_trade_id`.

## 2. Agregace

**Časové svíčky:** M1, M5 (default), M15. Čas svíčky = open time, interně vše v UTC.

**Objemové svíčky:** svíčka se uzavře po dosažení prahu objemu. Práh v USD notional (default 100M USD) nebo v BTC (default 1000 BTC), obojí volitelné, plus vlastní hodnota. aggTrade, který práh překročí, rozděl (stejná cena a strana) a zbytek přesuň do další svíčky. Stav pokračuje přes hranice dnů.

**Pro každou svíčku** (všechny typy agregace):

- open/high/low/close z cen obchodů,
- volume, buy, sell (taker) v BTC i v USD (USD = Σ price·qty), delta = buy − sell,
- CVD s volitelným resetem (žádný / denně 00:00 UTC; default denně),
- trades count, start a end timestamp, duration,
- ΔOI (viz sekce 3),
- features detektoru (viz sekce 4).

**Footprint:** pro každou svíčku a cenovou úroveň buy, sell (BTC i USD), delta a total. Úroveň = `floor(price / bin) · bin`. Předpočítej v základním binu (default 5 USD). UI ho re-agreguje na 10/25/50/100 USD (default 25).

## 3. Open interest

Z metrics použij `sum_open_interest` (BTC) a `sum_open_interest_value` (USD), snapshoty po 5 minutách. Ověř, k jakému okamžiku se snapshot vztahuje (`create_time`), a zdokumentuj to v README.

- ΔOI svíčky = OI(poslední snapshot ≤ konec svíčky) − OI(poslední snapshot ≤ začátek svíčky).
- M5 a M15 sedí přímo. U M1 a objemových svíček je rozlišení jen 5 minut. V UI to jasně označ: ΔOI zobraz jen u svíček, do kterých spadá hranice snapshotu, ostatní nech prázdné. Nic neinterpoluj.
- Historické likvidace pro USD-M nejsou spolehlivě dostupné. Řádek „Liq Δ“ z reference nahraď řádkem „OI Δ“.

## 4. Detektor (krok 1 strategie)

**Long (spodní knot).** Knot K = obchody s cenou striktně pod min(O, C). Počítej z jednotlivých aggTrades, NE z footprint binů.

- **V1:** z = (ln Vol_USD − průměr) / směrodatná odchylka ln Vol_USD z N = 30 předchozích svíček (bez aktuální) ≥ 2
- **V2:** Vol(K) / Vol ≥ 0,5
- **D1:** Δ(K) < 0
- **D2:** SellVol(K) / SellVol ≥ 0,5

**Short zrcadlově:** horní knot (cena striktně nad max(O, C)), Δ(K) > 0, BuyVol(K) / BuyVol ≥ 0,5.

**Objemové svíčky:** všechny mají stejný objem, takže V1 nedává smysl. Nahraď ho rychlostí vzniku: z-score z −ln(duration) přes N předchozích svíček ≥ 2. Označ to jako experimentální.

**Features.** Barvu svíčky nefiltruj. Ke každé svíčce (nejen k signálům) ulož:

- z (V1),
- podíl objemu v knotu,
- podíl knotu na range = (min(O,C) − L) / (H − L),
- koncentrace = podíl objemu v knotu / podíl knotu na range,
- Δ(K) a Δ(K) / Vol(K),
- podíl sell (u shortu buy) v knotu,
- celková delta a delta / volume,
- barva svíčky a pozice close = (C − L) / (H − L),
- trades count, duration, ΔOI,
- objem relativně k mediánu stejného času dne za předchozích 20 dní (jen u časových svíček a jen pokud je dost historie).

Ulož i surové složky pro oba knoty: Vol(K), Buy(K), Sell(K). Prahy se pak dají přepočítat v prohlížeči.

**Okrajové případy:**

- nulový knot → podíl 0, podmínka nesplněna,
- SellVol = 0 → D2 nesplněna,
- H = L → svíčku přeskočit.

**Parametry** (N, práh z, V2, D2) jsou v configu a dají se měnit v UI za běhu. Detektor se pak přepočítá v prohlížeči z uložených features. Backend proto vrací i N svíček před levým okrajem viditelného rozsahu, aby šlo spočítat rolling z-score.

## 5. Validace

- Postav M1 a M5 z aggTrades a porovnej je s oficiálními klines pro celý vývojový rozsah: open, high, low, close, volume, quote volume, taker buy volume, trades count.
  - Ceny musí sedět přesně, objemy na zaokrouhlovací chybu.
  - Neshody vypiš a vysvětli, nic netiše neupravuj.
- Známé případy z 2026-10-08. Hodnoty jsem odečetl z reference, jsou v USD a jen orientační (±5 %). Časové pásmo screenshotu neznám, takže svíčky najdi podle těchto hodnot a vypiš jejich čas v UTC:
  - **Svíčka A (M5):** objem ≈ 464M USD, delta ≈ −100M USD, low ≈ 81 830, high ≈ 82 400. Očekávám long signál.
  - **Tři svíčky po A:** delta ≈ +10M, −1,6M, +13M. Slouží jako kontrola znaménka delty.
  - **Svíčka B (M5), 50 minut po A:** objem ≈ 374M USD, delta ≈ −47M USD, low ≈ 81 710. Vypiš, zda detektor spustí, a hodnoty všech podmínek.
- Unit testy (pytest) na syntetických obchodech:
  - časové svíčky,
  - dělení obchodu u objemových svíček,
  - zařazení obchodů do knotu včetně hraničních cen,
  - detektor.

## 6. Footprint viewer v prohlížeči

Lokální aplikace: `python -m fp serve` → http://localhost:8000.

- Backend (FastAPI nebo podobný) servíruje data podle rozsahu a agregace z parquetu nebo DuckDB.
- Data načítej líně podle viditelného rozsahu. Tři měsíce M1 footprintu do prohlížeče najednou nenačítej.
- Frontend: vanilla JS + Canvas 2D, bez build kroku.

**Vzhled** podle reference: tmavé pozadí, hustý, ale čitelný. Priorita je čitelnost čísel, ne dekorace.

- **Hlavní panel:** každá svíčka = sloupec, řádky = cenové úrovně.
  - V buňce je hodnota delty ve formátu K/M (např. +2.4M, −530K).
  - Pozadí buňky je zelené nebo červené podle znaménka, intenzita podle |delta| vůči percentilu ve viditelném rozsahu. Malé hodnoty jsou bez výplně.
- **Svíčka u sloupce:** vlevo u každého sloupce tenká svíčka (knot tenká čára, tělo silnější, zelená/červená).
- **Osy:** cenová vpravo, časová dole. Default časové pásmo Europe/Prague, přepínač na UTC.
- **Tabulka pod footprintem** po svíčkách: Volume, CVD, Delta, Trades, OI Δ, barevně podle znaménka.
- **Panel ΔOI** pod tabulkou: histogram (zelená/červená, nulová linie), jednotky BTC s přepínačem na USD.
- **Režimy buňky:** delta (default) / sell × buy / volume.
- **Zoom:** při oddálení, kdy se text nevejde, skryj text a nech jen barevné buňky. Při dalším oddálení jen svíčky.
- **Ovládání:**
  - přepínač agregace (M1 / M5 / M15 / Vol 100M USD / Vol 1000 BTC / vlastní práh),
  - velikost binu (5/10/25/50/100),
  - skok na datum,
  - zoom kolečkem (horizontálně, s modifikátorem vertikálně), posun tažením, dvojklik = reset.
- **Crosshair a tooltip:** OHLC, objem, delta, trades, duration, ΔOI.

**Markery detektoru:**

- Long signál: zelený trojúhelník pod svíčkou. Short: červený nad ní.
- Klik na libovolnou svíčku (i bez signálu) otevře boční panel s hodnotami všech features a s podmínkami V1/V2/D1/D2, u každé splněno/nesplněno i s čísly. Potřebuju vidět i „proč ne“.
- U vybrané svíčky zvýrazni hranici knotu vodorovnou čárou na min(O,C), u shortu na max(O,C).
- Panel nastavení detektoru:
  - N, práh z, V2, D2, long/short zapnout/vypnout,
  - počet signálů v načteném rozsahu,
  - export signálů s features do CSV.

## 7. Struktura a postup

- **Stack:** Python 3.11+, polars nebo DuckDB, pyarrow, FastAPI + uvicorn, pytest.
- **Konfigurace** v `config.yaml`.
- **CLI:** `download`, `build`, `validate`, `serve`.
- **README** česky, s návodem ke spuštění.

Postupuj po krocích. Po krocích 1 a 3 se zastav a ukaž mi výsledek.

1. Stáhni 2026-10-08 (aggTrades, metrics, klines). Ověř cesty, hlavičky a jednotky, ukaž mi ukázkové řádky a velikosti souborů.
2. Postav časové svíčky M1/M5/M15 a proveď validaci proti klines.
3. Detektor a známé případy A a B → report (čas v UTC, hodnoty všech podmínek).
4. Footprint a OI.
5. Viewer.
6. Objemové svíčky.
7. Rozšíření na celý vývojový rozsah, potom na 3 měsíce.

Kde je něco nejasné (sémantika sloupce, zarovnání OI snapshotu apod.), ověř to na datech a předpoklad zapiš do README. Nehádej.

**Teď mimo rozsah** (přijde později): ruční štítkování signálů, kontext z vyšších timeframů (fibo, FVG, value areas), další instrumenty, živá data a jemnější OI.

## Hotovo, když

- `validate` hlásí shodu s oficiálními klines, nebo jsou neshody vysvětlené,
- svíčka A je nalezena a označena jako long signál,
- viewer běží lokálně a přepínání agregace a binu je plynulé,
- testy procházejí.
