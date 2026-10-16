# Metodika – BTCUSDT perp: data, footprint, features absorpce

Stav k 2026-10-09. Dokument popisuje, co projekt aktuálně umí a jak přesně to počítá: od stažení dat
přes agregaci a validaci až po viewer, features a metriky uvnitř svíček. U features a metrik je kromě
výpočtu uvedena i **teze** (proč tam metrika je) a **co v ní chceme vidět**.

> **2026-10-16:** detektor absorpce (podmínky V1–P2, skládání signálu, `long_signal` / `short_signal`,
> export signálů) byl z pipeline i vieweru odstraněn. Features, ze kterých počítal (z-score, knoty, POC),
> se dál počítají a ukládají do series pro navazující analýzy (sekce 10).

Konvence: všechny objemy „USD“ jsou notional (Σ cena × množství). „Long“ = kandidát na obrat nahoru
po absorpci prodejů ve spodním knotu, „short“ = zrcadlově horní knot. Parametry v `config.yaml`
jsou uvedeny jako `sekce.klíč` s defaultní hodnotou.

---

## Obsah
1. [Cíl a teze](#1-cíl-a-teze)
2. [Architektura](#2-architektura)
3. [Data: zdroj, stažení, ověření](#3-data-zdroj-stažení-ověření)
4. [Zpracování a uložení](#4-zpracování-a-uložení)
5. [Svíčky](#5-svíčky)
6. [Footprint a POC](#6-footprint-a-poc)
7. [Open interest](#7-open-interest)
8. [Časová pásma](#8-časová-pásma)
9. [Validace](#9-validace)
10. [Features knotu a objemu](#10-features-knotu-a-objemu)
11. [Metriky uvnitř svíčky](#11-metriky-uvnitř-svíčky)
12. [Viewer](#12-viewer)
13. [Konfigurace, CLI, testy](#13-konfigurace-cli-testy)
14. [Známá omezení a otevřené body](#14-známá-omezení-a-otevřené-body)
15. [Příloha: slovník sloupců](#15-příloha-slovník-sloupců)

---

## 1. Cíl a teze

Krok 1 strategie: spolehlivě najít svíčky s **výrazně nadprůměrným objemem**, u kterých **většina
objemu i agresivních obchodů proti směru proběhla v knotu**.

**Teze absorpce (long):** agresivní prodávající (taker sell) tlačí cenu dolů, ale na nižších cenách
narazí na pasivní limitní nákupy, které jejich objem „pohltí“. Cena se proto vrátí a vznikne spodní
knot. Stopy v datech:
- neobvykle velký objem (někdo se aktivně účastní),
- velká část objemu a velká část agresivních prodejů proběhla v knotu (prodávalo se tam, kam se cena
  nakonec nevrátila),
- delta v knotu je záporná (agrese byla opravdu na straně prodeje), přesto cena knot opustila.

Features knotu a objemu tyto stopy kvantifikují; metriky uvnitř svíčky pak pomáhají rozlišit „skutečnou“
absorpci od náhodného knotu (vyčerpání, imbalance, intenzita, velcí hráči, průběh delty, OI).

Mimo rozsah (zatím): kontext vyšších timeframů (struktura, POI, value areas), ruční štítkování,
živá data.

---

## 2. Architektura

Struktura: hlavní složka `footprint/` obsahuje spouštěče `viewer.bat` a `start.bat`, sdílenou složku
`data/` a složku `viewer/` s celou fází 1 (balík `fp`, testy, `config.yaml`, dokumentace). Cesty
`data/...` níže jsou vůči hlavní složce; `config.yaml` je odkazuje relativně jako `../data/...`.
Navazující analýzy budou v paralelních podsložkách nad stejnými daty.


```
data.binance.vision ──download──► data/raw (zip + .CHECKSUM)
                                       │ convert (polars)
                                       ▼
                         data/parquet/{aggTrades,metrics,klines_1m,klines_5m,trades}/BTCUSDT/YYYY-MM-DD.parquet
                                       │ build: denní fáze
                                       ▼
          data/derived/candles/<agg>/DAY   (svíčky + knoty + POC + metriky)
          data/derived/footprint/<agg>/DAY (footprint v základním binu 5 USD)
          data/derived/vstate/<vol agg>/DAY (stav rozpracované objemové svíčky)
                                       │ build: celorozsahová fáze (finalize)
                                       ▼
          data/derived/series/<agg>/DAY    (+ CVD, ΔOI, z-score, rel_tod)
                                       │
                 validate ◄────────────┤
                                       ▼
                      FastAPI (fp/server.py) ──JSON──► prohlížeč (Canvas, fp/static)
```

Kód: `fp/download.py`, `convert.py`, `candles.py`, `volume_bars.py`, `footprint.py`, `features.py`,
`metrics.py`, `build.py`, `validate.py`, `server.py`, frontend `fp/static/{index.html,i18n.js,app.js,style.css}`.
Stack: Python 3.11+ (testováno na 3.14), polars, pyarrow, FastAPI + uvicorn, pytest; frontend vanilla JS +
Canvas 2D bez build kroku.

`<agg>` = `1m`, `5m`, `15m` (časové) nebo `vusd_<práh>` / `vbtc_<práh>` (objemové).

---

## 3. Data: zdroj, stažení, ověření

### 3.1 Zdroj
Veřejné denní dumpy Binance USD-M futures (bez API klíče), instrument BTCUSDT:

| dataset | cesta (pod `data/futures/um/daily/`) | použití |
|---|---|---|
| aggTrades | `aggTrades/BTCUSDT/BTCUSDT-aggTrades-YYYY-MM-DD.zip` | vše: svíčky, footprint, features, metriky |
| metrics | `metrics/BTCUSDT/BTCUSDT-metrics-YYYY-MM-DD.zip` | open interest (5min snapshoty) |
| klines 1m, 5m | `klines/BTCUSDT/{1m,5m}/BTCUSDT-{1m,5m}-YYYY-MM-DD.zip` | jen validace |
| trades (volitelné) | `trades/BTCUSDT/BTCUSDT-trades-YYYY-MM-DD.zip` | oprava dnů s chybějícími aggTrades (sekce 9) a přesná rekonciliace ve validaci |

Cesty ověřeny výpisem S3 bucketu `data.binance.vision`.

### 3.2 Ověřená fakta o formátu
- **Hlavičky:** soubory z 2026 hlavičku mají; starší aggTrades a klines (ověřeno 2021, 2022) **ne**,
  pořadí sloupců je stejné. Converter pozná hlavičku podle toho, zda první pole = název prvního sloupce.
  Metrics mají hlavičku vždy.
- **Jednotky času:** všechny timestampy v **milisekundách** (2021, 2022, 2026). Converter přesto
  normalizuje: hodnota > 10¹⁴ (≥ 16 číslic) ⇒ mikrosekundy ⇒ /1000.
- **aggTrades:** `agg_trade_id` souvislý, čas v jeho pořadí monotónní; cena 1 desetinné místo
  (tick 0,1 USD), množství krok 0,001 BTC. `is_buyer_maker = true` ⇒ agresor byl **prodávající**.
  Jeden řádek = víc obchodů za stejnou cenu a stranu do 100 ms; počet obchodů = `last − first + 1`.
- **metrics:** `create_time` jako text `YYYY-MM-DD HH:MM:SS` (UTC), 288 řádků/den, **v souboru
  neseřazené**; `sum_open_interest` v BTC, `sum_open_interest_value` v USD.

### 3.3 Downloader (`python -m fp download`)
- Rozsah z CLI (`--start/--end`, podporuje `yesterday`/`today`) nebo z `download.start/end`.
- Ke každému zipu stáhne `.CHECKSUM` a ověří **SHA256**; úspěch označí markerem `.ok`.
- Idempotentní: hotové soubory přeskočí; stahuje do `.part` a atomicky přejmenuje, takže přerušení
  nevadí. 3 pokusy (`download.retries`), 4 paralelní vlákna (`download.workers`).
- Konec rozsahu ořízne na včerejšek (denní soubory vycházejí až další den, ~7–9 h UTC); 404 hlásí
  jako `missing`.

---

## 4. Zpracování a uložení

### 4.1 Konverze do parquetu (`fp/convert.py`)
Po dnech, zstd komprese, atomický zápis. Normalizované názvy:

| dataset | sloupce |
|---|---|
| aggTrades | `id, price, qty, first_id, last_id, ts (ms), ibm, rep` (seřazeno podle `first_id`; `rep` = zrekonstruováno ze surových trades, pak `id` = null) |
| metrics | `create_time, oi_time = create_time + 5 min, oi_btc, oi_usd` (seřazeno podle `oi_time`) |
| klines | původní sloupce bez `ignore`, časy v ms |
| trades | `id, price, qty, ts, ibm` |

Velikost: aggTrades ~14 MB parquet/den (1,8 mil. řádků v rušném dni).

### 4.2 Build (`python -m fp build`)
1. **Denní fáze** (pro každý den a agregaci): svíčky, složky knotů, statické features, footprint,
   POC, metriky uvnitř svíčky. Hotové dny se přeskakují (`--force` přestaví).
2. **Celorozsahová fáze** (`finalize`, vždy přes všechny postavené dny, je levná): CVD, ΔOI,
   ΔOI/volume, rolling z-score, objem vůči času dne.
   Díky tomu rolling statistiky navazují přes hranice dnů.

Objemové svíčky se staví sekvenčně přes všechny dny se stavem (viz 5.2). Build 8 dní všech agregací
(včetně 3 objemových) ~15 s.

---

## 5. Svíčky

### 5.1 Časové svíčky (M1, M5, M15)
- Čas svíčky = **open time** (UTC), `open_time = floor(ts / perioda) · perioda`. Minuty bez obchodu
  svíčku nevytvoří.
- O/H/L/C z cen aggTrades v pořadí `agg_trade_id`.
- `start_ts = open_time`, `end_ts = open_time + perioda`, `duration_ms = perioda`.

### 5.2 Objemové svíčky (`vusd_<práh>`, `vbtc_<práh>`)
- Svíčka se uzavře, jakmile kumulativní objem dosáhne prahu: v USD notional (default 100M,
  `aggregation.volume_usd`) nebo v BTC (default 1000, `aggregation.volume_btc`), plus libovolný
  vlastní práh z UI (rozsah 1M–100B USD, 10–1M BTC).
- **Dělení obchodu:** aggTrade, který práh překročí, se rozdělí (stejná cena, strana, čas); zbytek
  jde do další svíčky. Jeden velký obchod může vytvořit i několik svíček.
- **Přesná aritmetika:** objem se počítá v celých jednotkách (BTC po 0,001; USD po 0,0001 =
  tick 0,1 × 0,001 BTC), takže se nic neztratí ani nepřibude. Ověřeno: Σ svíček + rozpracovaná
  svíčka = Σ všech obchodů; každá svíčka má přesně práh.
- **Stav přes hranice dnů:** po každém dni se uloží rozpracovaná svíčka (`vstate/<agg>/DAY.{json,parquet}`:
  akumulovaný objem, id další svíčky, její části); další den navazuje. Přestavba dne vynutí přestavbu
  všech následujících.
- Čas svíčky = první obchod, konec = poslední obchod, `duration = konec − začátek`.
- Počet obchodů rozděleného aggTrade se připíše svíčce s jeho **první** částí.
- `cid` = pořadové číslo svíčky (unikátní klíč; dvě objemové svíčky mohou začínat stejným obchodem).
  U časových svíček `cid = start_ts`.
- Uložení: footprint/candles do souboru dne, kdy se svíčka **uzavře**; series podle dne otevření.
  Poslední rozpracovaná svíčka se nezobrazí, dokud se neuzavře.

### 5.3 Sloupce každé svíčky (všechny typy)
- `open, high, low, close`
- `volume, buy, sell` (BTC), `volume_usd, buy_usd, sell_usd`; `buy/sell` = taker strana
- `delta = buy − sell` (BTC i USD), `delta_ratio = delta_usd / volume_usd`
- `cvd, cvd_usd`: kumulativní delta s resetem `aggregation.cvd_reset` (`daily` / `none`) v půlnoc pásma
  `aggregation.cvd_reset_timezone` (default UTC)
- `trades` (Σ `last − first + 1`), `agg_trades`, `first_ts, last_ts, start_ts, end_ts, duration_ms`
- `d_oi, d_oi_usd, oi_end` (sekce 7)
- features knotu a objemu (sekce 10) a metriky (sekce 11)

---

## 6. Footprint a POC

- Pro každou svíčku a cenovou úroveň: `buy, sell` (BTC), `buy_usd, sell_usd`, `delta`, `total` (BTC i USD).
- Úroveň = `floor(price / bin) · bin` (dolní hrana bucketu). Počítá se v **celých ticích**, aby cena
  přesně na hraně bucketu nespadla kvůli float zaokrouhlení do nižšího.
- Předpočítáno v **základním binu 5 USD** (`aggregation.base_bin`). Prohlížeč re-agreguje na
  10/25/50/100 prostým součtem (ověřeno proti přímému výpočtu).
- **POC** (předpočítáno pro biny 5/10/25/50/100):
  - `vpoc_<b>` – úroveň s největším celkovým objemem (USD); při shodě nižší úroveň,
  - `dpoc_neg_<b>` – úroveň s nejzápornější deltou (null, když žádná úroveň nemá deltu < 0),
  - `dpoc_pos_<b>` – úroveň s nejkladnější deltou (null, když žádná nemá deltu > 0).
- Ověřeno: Σ footprintu = objemy svíčky; low i high padnou do krajních bucketů.
- Velikost: M1 ~0,6 MB/den.

---

## 7. Open interest

- Zdroj: `metrics.sum_open_interest` (BTC), `sum_open_interest_value` (USD), snapshoty po 5 min.
- **Zarovnání:** snapshot s `create_time = T` popisuje OI v **T + 5 min**. Ověřeno dvakrát:
  1. REST `openInterestHist` vrací pro `timestamp = 00:20` přesně hodnoty řádku `create_time = 00:15`.
  2. Implikovaná cena `value / OI` (≈ mark price) vs cena posledního obchodu přes 288 snapshotů dne:
     medián chyby 61,4 USD při +0 s, **0,67 USD při +299 s**, 1,84 USD při +300 s.
- **ΔOI svíčky** = OI(poslední snapshot ≤ konec) − OI(poslední snapshot ≤ začátek). Pokud mezi začátkem
  a koncem žádný snapshot není, ΔOI = null (nic se neinterpoluje). M5/M15 mají hodnotu vždy, M1 jen
  svíčky končící na hranici 5 min (každá pátá), objemové svíčky jen když hranice spadá do
  (první obchod, poslední obchod].
- Historické likvidace pro USD-M nejsou spolehlivě dostupné ⇒ místo „Liq Δ“ se zobrazuje „OI Δ“.

---

## 8. Časová pásma

- Interně vše v UTC (epoch ms); denní soubory = UTC dny.
- Zobrazení default **America/New_York** (`server.timezone`), přepínač UTC. Převod přes IANA pásmo
  (prohlížeč `Intl`, backend polars/zoneinfo) ⇒ letní/zimní čas automaticky (2026: EDT od 8. 3.,
  EST od 1. 11.; Evropa přechází 25. 10.).
- Zarovnání svíček se DST nemění (posun NY vždy celé hodiny).
- `rel_tod` porovnává **lokální NY čas** (`features.tod_timezone`), aby US session zůstávala na stejném
  místě i přes přechod času.
- Reset CVD: 00:00 UTC (lze přepnout na NY).

---

## 9. Validace

`python -m fp validate` porovná M1 a M5 z aggTrades s oficiálními klines (open, high, low, close,
volume, quote volume, taker buy volume, taker buy quote volume, count) a vyhodnotí známé případy.
Neshody se **klasifikují, nic se neupravuje**.

Výsledek 2026-01-01 … 10-08 po opravě (281 dní; M1 404 640 svíček): žádná svíčka nechybí; close
0 neshod; open/high/low/volume/taker buy neshody jen z přelití (volume 45 035 svíček), count z přelití a
přeskočených id – **chybějící obchody 0, nevysvětlené 0** (M1 i M5). Příčiny (ověřeno na surovém
datasetu `trades`, stažený pro 101 opravených dní a 2026-10-01 … 10-08):

1. **Přelití přes hranici svíčky.** aggTrade sdružuje obchody za až 100 ms a nese čas prvního; klines
   řadí každý obchod podle jeho času. Když aggTrade začne v posledních 100 ms svíčky, část objemu
   patří v klines do další svíčky (proto nesedí open, nikdy close). Svíčky ze surových trades sedí
   s klines **přesně** ve všech polích. Validátor ověří, že každý rozdíl leží v mezích aggTrades
   z posledních 100 ms předchozí svíčky (včetně přes půlnoc).
2. **Přeskočená trade id.** Uvnitř rozsahů `first..last` existují id bez obchodu ⇒ `last − first + 1`
   nadhodnocuje; součet přeskočených id za 8 dní (5 920) přesně odpovídá rozdílu `count` (~0,02 %).

3. **Obchody chybějící v aggTrades dumpu (leden–červen 2026) – opraveno.** V některých dnech aggTrades
   soubory neobsahují část obchodů, které klines i surové `trades` mají; `agg_trade_id` přitom jde
   souvisle. Z dumpu vypadly **celé aggTrade řádky**: chybějící obchody tvoří bloky po sobě jdoucích
   trade id, každý blok má jedinou cenu, jedinou stranu a trvá ≤ 90 ms (ověřeno na 2026-06-04:
   9 793 obchodů v 1 279 blocích, 1 065,8 BTC). Příčinu z dat určit nelze.
   - výskyt: 2026-01-06 … 2026-06-09, od července nic; ne souvislé období, ale ~1 200 krátkých výpadků
     (jen 7 delších než 5 min, nejdelší 2026-06-04 02:01–02:12), soustředěných do nejrušnějších minut
     (medián 87. percentil objemu); 50 nejhorších minut drží 61 % chybějícího objemu,
   - **oprava** (`fp/convert.py`, `repair_aggtrades`): pro dny, kde je stažený surový `trades` dump, se
     obchody nepokryté žádným aggTrade (včetně posledního aggTrade předchozího dne, který může přesahovat
     půlnoc) seskupí podle pravidel Binance (po sobě jdoucí id, stejná cena a strana, ≤ 100 ms od
     prvního obchodu) a vloží jako zrekonstruované aggTrades (`id` = null, `rep` = true). Pořadí obchodů
     se pak určuje podle `first_id` (id prvního obchodu). Výsledek je totožný s kompletním dumpem.
   - opraveno 101 dní (seznam `data/logs/repair_days.txt`), 4 408 zrekonstruovaných aggTrades,
     5 962 BTC (0,013 % objemu), 1 766 svíček M1 (max 345,7 BTC v jedné svíčce); ve svíčkách sloupec
     `repaired_btc` = kolik objemu bylo doplněno,
   - po opravě validace 2026-01-01 … 10-08: chybějící obchody 0, nevysvětlené rozdíly 0 (M1 i M5),
   - validátor dál hlídá kategorii „agg gap“ (klines mají víc objemu / obchodů, než může vysvětlit
     přelití). U nových dat: objeví-li se agg gap, stáhnout pro ten den `trades`
     (`python -m fp download --start D --end D --datasets trades`) a den přestavět (`build --force`
     pro den; u objemových svíček je nutné přestavět i následující dny).

Rozhodnutí: zůstáváme u aggTrades (podle zadání); rozdíly 1 a 2 jsou jen zdokumentované, chybějící
obchody (bod 3) jsou doplněné ze surových trades.

**Známé případy 2026-10-08 (M5)** – hledány podle hodnot z reference, ne podle času:
- **A = 12:50 UTC (08:50 NY)**: objem 462,0M, delta −99,2M, L 81 849, H 82 385
  (z 4,35; podíl objemu v knotu 0,768; Δ(K) −123M; sell v knotu / sell 0,852; vPOC i Δ− POC v knotu).
- tři svíčky po A: delta +10,3M / −1,5M / +12,9M (znaménka sedí),
- **B = 13:40 UTC (09:40 NY)**: objem 370,9M, delta −47,0M, L 81 715
  (z 2,83; podíl objemu v knotu 0,783; Δ(K) −54,4M; sell v knotu / sell 0,825).

---

## 10. Features knotu a objemu

Features se počítají v buildu (`fp/features.py`, `fp/footprint.py`) a ukládají ke každé svíčce do series.
Prohlížeč je jen zobrazuje v detailu svíčky, nic nepřepočítává. (Do 2026-10-16 z nich detektor skládal
podmínky V1–P2 a signály long/short; ten byl odstraněn.)

### 10.1 Definice knotu
- **Spodní knot K** = obchody s cenou **striktně pod** min(O, C); **horní knot** = striktně nad max(O, C).
- Počítá se **z jednotlivých aggTrades**, ne z footprint binů (bin by do knotu zahrnul i ceny těla).
  U objemových svíček z rozdělených částí obchodů.
- Barva svíčky se nefiltruje – kandidát na long může být i červená svíčka s dlouhým spodním knotem.

### 10.2 Features
Všechny podíly v USD notional. Short je vždy zrcadlový (horní knot, opačné znaménko, buy místo sell).

#### Neobvyklý objem – `z`
- **Výpočet:** `z = (ln Vol_USD − mean) / std`, mean a std (výběrová, ddof = 1) z ln Vol_USD
  **N = 30 předchozích svíček bez aktuální** (`features.n`).
- **Proč logaritmus:** objem je silně pravostranně rozdělený; v logu je rozdělení blíž normálnímu a
  z-score smysluplnější.
- **Teze:** absorpce vyžaduje velkou účast; bez neobvyklého objemu jde spíš o běžný šum.
- **Co chceme vidět:** z výrazně nad 2 (A: 4,35).
- **Okraj:** dokud není N předchozích svíček, z = null. Rolling okno běží přes hranice dnů.

#### `z` u objemových svíček – zrychlení toku objemu (EXPERIMENTÁLNÍ)
- **Proč jinak:** všechny objemové svíčky mají stejný objem, objemové z-score nedává smysl. Měří se
  proto **rychlost, jakou objem přichází**. Nehodnotí se jedna svíčka (tu může vytvořit jediný
  výbuch nebo jeden velký obchod), ale **plovoucí okno posledních W svíček**: „posledních W svíček
  vzniklo rychleji, než je obvyklé“.
- **Výpočet:**
  - `span_W(t) = end_ts(t) − end_ts(t − W)` = čas od uzavření svíčky t−W do uzavření svíčky t, tj. jak
    dlouho trvalo nasbírat W × práh objemu včetně aktuální svíčky (mezery mezi svíčkami se započítají,
    je to skutečný čas); `vspeed = x(t) = −ln span_W(t)`,
  - baseline: N hodnot `x(t−W), x(t−W−1), …, x(t−W−N+1)` – stejně dlouhá okna, která **skončila
    před začátkem aktuálního okna**, takže se s ním nepřekrývají a aktuální výbuch neovlivní vlastní
    srovnání,
  - `z = (x(t) − mean) / std` (výběrová std),
  - W = `features.vol_window` (default 10), N = `features.n`.
- **Teze:** absorpce na objemových svíčkách se projeví zhuštěním obchodování – během krátké doby
  proteče násobek obvyklého objemu (agresivní prodeje + pasivní limitní strana, stopy, likvidace).
- **Co chceme vidět:** vysoké z u svíčky s absorpčním knotem, tj. knot vznikl uprostřed zrychlení.
- **Vlastnosti a pozor:**
  - okno **reaguje se zpožděním**: první svíčky výbuchu mají v okně ještě pomalé starší svíčky, takže
    jejich z je nízké; vysoké z mají až svíčky později ve výbuchu (2026-10-08 08:50:15 NY, začátek
    flushe, Vol 100M: okno 10 svíček = 1 h 35 min, z = 0,32). Menší W reaguje rychleji, ale víc šumí,
  - zrychlení trvá několik svíček ⇒ vysoké z mívá série po sobě jdoucích svíček,
  - potřebuje 2W + N − 1 svíček historie (W pro první okno, N oken baseline, odstup W).

#### Objem v knotu – `lw_share`
- **Výpočet:** `Vol(K) / Vol`. Nulový knot ⇒ 0.
- **Teze:** většina obchodování proběhla na cenách, které trh odmítl.
- **Co chceme vidět:** vysoký podíl (A: 0,768).

#### Směr agrese v knotu – `lw_delta_usd`, `lw_delta_ratio`
- **Výpočet:** `Δ(K) = Buy(K) − Sell(K)` a `Δ(K) / Vol(K)`.
- **Teze:** v knotu musí převažovat agrese **proti** výslednému pohybu – jinak by knot vznikl pasivně
  (např. jen díky chybějící likviditě), ne pohlcením.
- **Co chceme vidět (long):** výrazně záporná Δ(K) (A: −123M), ideálně i v poměru k Vol(K).

#### Kde proběhla agrese – `lw_sell_share`
- **Výpočet:** `Sell(K) / Sell` (short: `uw_buy_share = Buy(K) / Buy`). Sell = 0 ⇒ null.
- **Teze:** většina agresivních prodejů celé svíčky se odehrála v knotu, tj. prodávající „vystřelili“
  na úrovni, kterou cena nedokázala udržet.
- **Co chceme vidět:** vysoký podíl (A: 0,852).

#### Volume POC a delta POC – `vpoc_<b>`, `dpoc_neg_<b>`, `dpoc_pos_<b>`
- **Výpočet:** z footprintu v USD notional pro biny b = 5/10/25/50/100: `vpoc` = dolní hrana bucketu
  s největším objemem, `dpoc_neg` = bucket s **nejzápornější** deltou (nejsilnější agresivní prodej),
  `dpoc_pos` = s **nejkladnější** deltou (nejsilnější agresivní nákup). Při shodě rozhoduje nižší
  úroveň; bez záporné (kladné) delty je `dpoc_neg` (`dpoc_pos`) null.
- **„Celý v knotu“** (jak to dřív vyhodnocovaly P1/P2): long `poc + b ≤ min(O,C)`, short `poc > max(O,C)`.
  Přísná varianta – celý bucket musí ležet v knotu; volnější (jen střed bucketu) by vyhověla častěji.
- **Teze:** cena s největším objemem (místo, kde se „bojovalo“) a místo nejsilnější agrese proti směru
  leží v odmítnuté zóně – hlavní souboj se odehrál v knotu a cena z něj odešla. Delta POC je stranově
  specifický: pro long rozhoduje jen nejzápornější úroveň, takže velká **kladná** delta jinde ve svíčce
  ho neovlivní.
- **Co chceme vidět (long):** POC i `dpoc_neg` hluboko v knotu (A: vPOC 81 950, Δ− 81 875, tělo od 82 204).
- **Pozor:** výsledek závisí na binu (5 vs 25 USD může dát jinou odpověď).
- **Ve vieweru:** fialový Δ profil má dvě tečky – červenou na nejzápornější a zelenou na nejkladnější
  úrovni (v binu zobrazení); u vybrané svíčky jsou v binu zobrazení orámované buckety vPOC (žlutý /
  oranžový), Δ− (červený) a Δ+ (zelený) se štítky na cenové ose.

### 10.3 Uložené features (ke každé svíčce)
| feature | výpočet |
|---|---|
| `valid` | H > L (svíčka má range) |
| `z` | z-score objemu (viz výše) |
| `vspeed` | jen objemové svíčky: −ln(čas posledních W svíček v ms), vstup do `z` |
| `lw_share` / `uw_share` | podíl objemu v knotu |
| `lw_range` / `uw_range` | délka knotu / range = (min(O,C) − L) / (H − L) |
| `lw_conc` / `uw_conc` | koncentrace = podíl objemu v knotu / podíl knotu na range (> 1 = v knotu se obchodovalo hustěji než v průměru svíčky) |
| `lw_delta_usd`, `lw_delta_ratio` | Δ(K) a Δ(K) / Vol(K) |
| `lw_sell_share` / `uw_buy_share` | podíl sell (buy) objemu svíčky, který proběhl v knotu |
| `delta_usd`, `delta_ratio` | celková delta a delta / volume |
| `color`, `close_pos` | barva (+1/−1/0), pozice close = (C − L) / (H − L) |
| `trades`, `duration_ms`, `d_oi` | počet obchodů, trvání, ΔOI |
| `rel_tod` | objem / medián objemu ve stejném NY čase dne za předchozích 20 dní (`features.tod_days`); jen časové svíčky a jen s plnou historií |
| surové složky | `{lw,uw}_{vol,buy,sell}[_usd]` – z nich lze podíly přepočítat |
| POC | `vpoc_<b>`, `dpoc_neg_<b>`, `dpoc_pos_<b>` pro b = 5/10/25/50/100 |

---

## 11. Metriky uvnitř svíčky

Informativní metriky počítané v denní fázi buildu (`fp/metrics.py`), uložené v series a zobrazené
v panelu svíčky. Rozlišují „kvalitní“ absorpci od náhodného knotu.
Parametry: `metrics.imbalance_ratio` 3, `imbalance_min_usd` 50 000, `stack_min` 3 (zatím jen
informativní), `big_trade_btc` 5.

### 11.1 Průběh delty uvnitř svíčky
- **Výpočet:** kumulativní delta (USD) obchod po obchodu v pořadí `id`, start 0.
  - `dpath_min_usd = min(0, min cum)`, `dpath_max_usd = max(0, max cum)`,
  - long: návrat od minima `d_recov_l_usd = delta − dpath_min`, poměr `d_recov_l_ratio = návrat / |min|`,
  - short: pokles od maxima `d_recov_s_usd = dpath_max − delta`, poměr vůči max,
  - `t_low_frac`, `t_high_frac`: kdy byl poprvé dosažen low/high (podíl trvání svíčky),
  - `t_dmin_frac`, `t_dmax_frac`: kdy nastalo minimum/maximum kumulativní delty.
- **Teze:** absorpce má typický „podpis“: agresivní prodej stlačí kumulativní deltu hluboko (do low),
  pak prodeje ustanou nebo převládnou nákupy a delta se vrací. Konečná delta svíčky tento průběh skrývá.
- **Co chceme vidět (long):** hluboké minimum delty zhruba ve stejné chvíli jako low (`t_dmin ≈ t_low`),
  následně výrazný návrat; low spíš v první části svíčky (zbytek svíčky = odmítnutí).
  A: low v 5 % trvání, min delty v 10 %, min −126M, návrat 21 %.
- **Pozor:** poměr návratu nedává smysl, když je extrém delty malý – panel ho skryje, je-li extrém
  < 1 % objemu svíčky.

### 11.2 Aukce na extrému
- **Výpočet:** v nejnižším (nejvyšším) 5USD bucketu svíčky `low_buy_usd`, `low_sell_usd`
  (`high_*`). Obě strany > 0 ⇒ **nedokončená aukce** (`unfinished_low = true`), jedna strana nulová ⇒
  **dokončená**.
- **Teze (auction market theory):** dokončená aukce na low = na extrému už nebyla protistrana
  (prodávající došli), pohyb je „vyčerpaný“. Nedokončená aukce = trh má tendenci se k extrému vrátit
  a „dokončit“ ho.
- **Co chceme vidět (long):** dokončená aukce na low (typicky jen sell, žádné buy), A: 0 / 155K → dokončená.
- **Pozor:** závisí na velikosti bucketu (5 USD); v 25USD bucketu bývají obě strany téměř vždy.

### 11.3 Vyčerpání na extrému
- **Výpočet:** `exh_low = objem nejnižšího 5USD bucketu / objem POC bucketu (5 USD)`, `exh_low2` pro
  dva nejnižší buckety; `exh_high`, `exh_high2` zrcadlově.
- **Teze:** pokud na samém extrému proběhlo jen málo obchodů, tlak se vyčerpal ještě předtím, než
  cenu někdo musel zastavit – „tenký konec“ knotu.
- **Co chceme vidět (long):** malé `exh_low` (A: 0,01×, tj. 1 % POC). Velký objem přímo na low může
  naopak znamenat, že úroveň ještě není vyřešená.

### 11.4 Imbalance v knotu
- **Výpočet (diagonální, 5USD bin):**
  - buy imbalance na úrovni L: `buy(L) ≥ 3 × sell(L − 5)` a `buy(L) ≥ 50K USD`,
  - sell imbalance na úrovni L: `sell(L) ≥ 3 × buy(L + 5)` a `sell(L) ≥ 50K USD`,
  - chybějící sousední úroveň = 0; počítají se jen úrovně ležící **celé** v knotu,
  - `lw_buy_imb`, `lw_sell_imb` = počet úrovní, `*_stack` = nejdelší řada po sobě jdoucích úrovní.
- **Proč diagonálně:** agresivní kupec bere nabídku (ask) na L, agresivní prodávající bere poptávku
  (bid) o tick níž – srovnávají se strany, které spolu reálně soupeří.
- **Teze:**
  - řada **sell** imbalancí ve spodním knotu = prodávající byli velmi agresivní, a přesto cenu neudrželi
    ⇒ silná absorpce (pasivní kupci je pohltili),
  - **buy** imbalance ve spodním knotu = kupující převzali iniciativu přímo v knotu ⇒ obrat.
- **Co chceme vidět (long):** stack sell imbalancí v knotu a/nebo buy imbalance u low. A: 29 sell
  imbalancí, nejdelší řada 10.
- **Pozor:** práh 50K USD filtruje šum na tenkých úrovních; při jiném binu by vycházely jiné počty.

### 11.5 Úsilí vs výsledek
- **Výpočet:** `lw_effort = Vol(K)_USD / (min(O,C) − L)` = kolik USD se zobchodovalo na 1 USD
  pohybu ceny v knotu; `body_effort = objem těla / |C − O|`; `lw_effort_ratio = lw_effort / body_effort`.
- **Teze (Wyckoff, effort vs result):** velké úsilí (objem) s malým výsledkem (pohybem) = někdo stojí
  proti; v knotu to znamená, že prodeje narážely na pasivní poptávku.
- **Co chceme vidět (long):** poměr knot/tělo výrazně > 1 (A: 2,58×).
- **Pozor:** krátké tělo (doji) dává obří `body_effort` ⇒ poměr malý; svíčka bez těla ⇒ null.

### 11.6 Velké obchody
- **Výpočet:** aggTrade ≥ 5 BTC (u objemových svíček rozhoduje velikost **původního** obchodu, ne
  rozdělené části): `lw_big_buy_usd`, `lw_big_sell_usd`, `lw_big_count`, `lw_big_share` = podíl velkých
  na objemu knotu, `lw_big_sell_share` = podíl velkých na sell objemu knotu (short: buy v horním knotu).
- **Teze:** absorpce je nejsilnější, když pohltí i agresi velkých hráčů (pasivní limitní strana je
  ještě větší). Vysoký podíl velkých agresivních prodejů v knotu, po kterých cena nepokračovala, je
  znak, že jejich protistrana je silná.
- **Co chceme vidět (long):** vyšší podíl velkých sell v knotu než obvykle. A: 22 % objemu knotu,
  110 velkých obchodů, 24 % sell objemu knotu.
- **Pozor:** aggTrade = víc obchodů od více účastníků se stejnou cenou do 100 ms, takže „velký
  aggTrade“ nemusí být jeden hráč. Práh 5 BTC (~400K USD) je potřeba kalibrovat na distribuci.

### 11.7 Intenzita
- **Výpočet:** průměrná velikost obchodu `lw_avg_trade_usd = Vol(K) / trades(K)` vs tělo
  (`lw_size_ratio`); rychlost `lw_rate = trades(K) / čas v knotu (s)` vs tělo (`lw_rate_ratio`).
- **Teze:** boj o úroveň se projeví zrychlením obchodování a většími obchody v knotu (stop-lossy,
  likvidace, agresivní vstupy narážející na limity).
- **Co chceme vidět (long):** knot rychlejší a s většími obchody než tělo. A: obchod 2,07× větší,
  rychlost 4,94×.

### 11.8 Čas v knotu
- **Výpočet:** cena platí od obchodu do dalšího (poslední obchod do konce svíčky; u objemových svíček
  do posledního obchodu). `lw_time_ms` = součet časů s cenou < min(O,C); `lw_time_frac` = podíl trvání.
- **Teze:** rychlé odmítnutí (krátký čas v knotu, velký objem) = silná reakce; dlouhé setrvání =
  testování / akumulace.
- **Co chceme vidět:** zatím otevřené – obě varianty mají výklad; metrika slouží k rozlišení typů
  knotů. A: 29 % času ve spodním knotu.
- **Pozor:** přesnost ≤ 100 ms (časy aggTrades).

### 11.9 ΔOI / volume
- **Výpočet:** `oi_vol_ratio = ΔOI (BTC) / objem svíčky (BTC)`, jen kde je ΔOI (viz sekce 7).
- **Teze:** odlišuje, kdo v knotu obchodoval:
  - **OI ↓** při prodejích do knotu = zavírání longů / likvidace (nucený prodej, který typicky rychle
    vyprchá) ⇒ podporuje obrat,
  - **OI ↑** = otevírání nových pozic; u longu to mohou být noví shorti prodávající do low, kteří
    jsou při návratu ceny v pasti (palivo pro pohyb nahoru).
- **Co chceme vidět:** zatím obě varianty sledovat zvlášť. A: −12,7 % objemu (zavírání pozic).
- **Pozor:** rozlišení OI jen 5 min ⇒ u M1 a objemových svíček většinou null.

---

## 12. Viewer

### 12.1 Spuštění
- `start.bat` (dvojklik, hlavní složka) – menu: 1 viewer, 2 aktualizace dat (stažení + build do včerejška),
  3 validace, 4 testy, 5 instalace knihoven, 0 konec. Prázdná volba nic nespouští; po spuštění vieweru
  se menu ukončí.
- `viewer.bat` (hlavní složka) – spustí server a otevře http://localhost:8000 (pokud už běží, jen otevře prohlížeč).
- Ručně: `python -m fp serve` ve složce `viewer/`.

### 12.2 Rozložení
- **Lišta:** agregace (M1 / M5 / M15 / Vol 100M USD / Vol 1000 BTC / další cachované / Vlastní práh…),
  bin (5/10/25/50/100), režim buňky, **rozsah Od – Do + Načíst / Vše**, **Profil**, **Δ Profil**, NY/UTC, ΔOI BTC/USD,
  **☀ Světlý / ☾ Tmavý**, **CZ / EN**, stavový řádek.
- **Hlavní panel (footprint):** sloupec = svíčka, řádky = cenové úrovně; vlevo u sloupce tenká svíčka.
  Buňka: hodnota ve formátu K/M a barva podle režimu; intenzita podle |hodnoty| vůči 95. percentilu
  viditelných buněk, hodnoty pod 12 % bez výplně.
- **Osy:** cenová vpravo, časová dole (NY nebo UTC, oddělovače dnů).
- **Tabulka pod footprintem:** Volume, CVD, Delta (USD), Trades, OI Δ, barevně podle znaménka.
- **Panel ΔOI:** histogram s nulovou linií, BTC/USD; prázdné u svíček bez hranice snapshotu.
- **Boční panel:** detail vybrané svíčky.

### 12.3 Režimy buňky a úrovně detailu
- **delta** (default): text +2.4M / −530K, zelená/červená,
- **sell × buy**: levá půlka sell (červená), pravá buy (zelená),
- **volume**: celkový objem, modrá.
- Při oddálení: buňky s čísly → jen barevné buňky → jen svíčky.

### 12.4 Profily (On/Off, pamatuje si prohlížeč)
- **Profil** (žlutý v tmavém, tmavě oranžový ve světlém režimu): vyhlazená křivka rozložení celkového
  objemu po úrovních aktuálního binu, normovaná na maximum svíčky, tečka = POC.
- **Δ Profil** (fialový): křivka delty kolem svislé nulové osy uprostřed buňky (doprava nákupy,
  doleva prodeje), normovaná na max |delta|; červená tečka = úroveň s nejzápornější deltou, zelená =
  s nejkladnější (dva delta POC, v binu zobrazení).
- Zobrazují se v režimu buněk, ve všech režimech buňky; lze kombinovat.

### 12.4a Vrstvy: sessions a dny (tlačítko „Vrstvy ▾“)
Každá vrstva má vlastní on/off přepínač (stav si pamatuje prohlížeč):
- **Sessions – pásy:** barevné pozadí přes čas session + název u spodního okraje.
- **Sessions – high / low:** tečkované čáry přes celou session s popiskem (např. „London H 84273.3“).
- **Sessions – volume / delta profil**, **Dny – high / low / volume / delta profil**: volume profil je
  histogram celkového objemu po úrovních aktuálního binu, ukotvený na začátek období a rostoucí doprava
  (POC zvýrazněn); delta profil má nulovou osu u konce období, nákupy doprava (zelené), prodeje doleva
  (červené). Šířka profilu je úměrná délce období (max 220 px); při velkém oddálení se profily skryjí.
- **Definice:** sessions v `config.yaml` (`sessions`), default v NY čase (DST): Asia 18:00–03:00,
  London 03:00–08:00, New York 08:00–17:00 (17:00–18:00 mezera); session přes půlnoc patří dni, ve kterém
  končí. Den = kalendářní den ve zvoleném pásmu vieweru (NY / UTC).
- **Výpočet** (`fp/periods.py`, `GET /api/periods?start&end&tz&bin`): high/low přesně z 5m svíček,
  profily z 5m footprintu (základní bin 5 USD, re-agregace na bin zobrazení); rozsah se načítá
  s přesahem jednoho dne, takže každé období je úplné. Prohlížeč stahuje po týdenních blocích podle
  viditelného rozsahu; vrstvy fungují nad všemi agregacemi (i objemovými svíčkami).

### 12.5 Ovládání
- kolečko = zoom času kolem kurzoru; Ctrl/Shift/Alt + kolečko (nebo kolečko nad cenovou osou) = zoom ceny,
- tažení grafu = posun (svislý posun vypne automatické měřítko ceny),
- **tažení cenové osy** nahoru/dolů = přiblížení/oddálení ceny; **tažení časové osy** doprava/doleva =
  širší/užší svíčky,
- dvojklik = reset zoomu; dvojklik na ose = reset jen té osy,
- crosshair + tooltip: OHLC, objem (USD a BTC), delta, trades, duration, ΔOI,
- klik na svíčku = detail v bočním panelu + čárkované hranice knotu na min(O,C) (L, zelená) a
  max(O,C) (S, červená) a orámované POC buckety v binu zobrazení (vPOC, Δ−, Δ+); všechny se štítky na
  cenové ose, které se skládají pod sebe, aby se nepřekrývaly.

### 12.6 Detail svíčky
- OHLC, objemy, delta, CVD, barva, close pos, trades, duration, ΔOI, rel_tod, z; složky obou knotů;
  sekce metrik (průběh delty, extrémy, tabulka knotů spodní/horní, OI). Stáhne se při kliknutí
  (`/api/candle`).

### 12.6a Načtení rozsahu dat
- „Od“ a „Do“ jsou dny ve zvoleném časovém pásmu (NY / UTC); **Načíst** stáhne všechny svíčky rozsahu a
  zobrazí celý rozsah na šířku grafu, **Vše** načte celý dostupný dataset dané agregace.
- Při přepnutí agregace se rozsah zachová, pokud se vejde do limitu; jinak se ukáže výřez kolem středu
  a hláška o limitu.
- Limit **150 000 svíček** na rozsah (paměť prohlížeče): celý dataset jde pro M5, M15 a objemové svíčky;
  M1 max ~100 dní.
- Doba načtení: celý rok M5 ~6,5 s (20denní dávky, 3 souběžně).
- Při posunu za okraj rozsahu se další dny dál dočítají líně, jako dřív.

### 12.7 Vzhled a jazyk
- Tmavý režim a světlý s krémovým pozadím `#f8f4e4` (žádná čistá bílá); vlastní paleta pro každý
  režim (tmavší zelená/červená, slabší výplně a tmavý text ve světlém).
- **Jazyk CZ / EN:** přepínač v liště, volbu si pamatuje prohlížeč. Všechny texty rozhraní jsou ve slovníku
  `fp/static/i18n.js` (`I18N.cs`, `I18N.en`); statické HTML se překládá přes atributy `data-i18n`,
  `data-i18n-title` a `data-i18n-ph`.

### 12.8 Technika
- Backend FastAPI: `GET /api/meta` (včetně počtu svíček a průměru na den pro každou agregaci),
  `GET /api/candles?agg&start&end&pad[&full=1]`, `GET /api/candle?agg&cid&start_ts` (všechny sloupce jedné
  svíčky),
  `GET /api/periods?start&end&tz&bin` (sessions a dny: high/low, volume/delta profil),
  `GET /api/footprint?agg&start&end`, `POST /api/volume?unit&value` (výpočet vlastního prahu na pozadí,
  cache na disku), `GET /api/jobs`. Sloupcový JSON s gzipem; UI soubory s `Cache-Control: no-cache`.
- **Lehké sloupce:** `/api/candles` posílá jen ~30 sloupců potřebných pro graf, tabulku, tooltip a
  POC značky vybrané svíčky (OHLC, objemy, delta, CVD, trades, ΔOI, POC), zaokrouhlené; detail svíčky
  (features, metriky, složky knotů) se stáhne až při kliknutí. Díky tomu se vejde celý rok M5.
- **Sloučené vykreslení:** když připadá méně než 1,5 px na svíčku, svíčky se slučují po pixelových
  sloupcích (high/low skupiny, barva podle open první a close poslední svíčky; v tabulce součty objemu,
  delty, obchodů a ΔOI, CVD poslední hodnota); časová osa přejde na dny / týdny / měsíce. Celý rok M5
  se vykreslí za ~30 ms. Minimální šířka svíčky 0,005 px.
- Líné načítání po UTC dnech podle viditelného rozsahu; footprint jen pro viditelné dny a jen při
  dostatečném přiblížení; dny dál než 3 od pohledu se uvolní z paměti.
- Výkon: vykreslení snímku ~1–3 ms (běžné přiblížení), ~30 ms (celý rok), přepnutí binu bez serveru,
  přepnutí agregace < 0,2 s (výřez) / ~2–7 s (celý rok).

---

## 13. Konfigurace, CLI, testy

### 13.1 `config.yaml`
| sekce | klíče (default) |
|---|---|
| `download` | `start`, `end`, `datasets` [aggTrades, metrics, klines_1m, klines_5m], `workers` 4, `retries` 3 |
| `aggregation` | `timeframes` [1m, 5m, 15m], `volume_usd` [1e8], `volume_btc` [1000], `base_bin` 5, `cvd_reset` daily, `cvd_reset_timezone` UTC |
| `features` | `n` 30, `vol_window` 10, `tod_days` 20, `tod_timezone` America/New_York |
| `metrics` | `imbalance_ratio` 3, `imbalance_min_usd` 50 000, `stack_min` 3, `big_trade_btc` 5 |
| `sessions` | `timezone` America/New_York, `list`: Asia 18:00–03:00, London 03:00–08:00, New York 08:00–17:00 |
| `server` | `host` 127.0.0.1, `port` 8000, `timezone` America/New_York |

### 13.2 CLI
```
python -m fp download [--start D] [--end D|yesterday] [--datasets ...]
python -m fp build    [--start D] [--end D|yesterday] [--force]
python -m fp validate [--start D] [--end D]
python -m fp serve    [--host H] [--port P]
python -m pytest
```

### 13.3 Testy (pytest, 47)
Syntetické obchody: časové svíčky a CVD, dělení obchodu u objemových svíček (včetně stavu přes dny a
obchodu přes víc svíček, okenní z-score rychlosti), zařazení do knotu včetně hraničních cen, features knotu
(okrajové případy, z-score), POC úrovně, footprint a re-binning, časová pásma a DST, ΔOI, metriky uvnitř svíčky
(ručně spočítané hodnoty), oprava chybějících aggTrades ze surových trades (včetně přesahu přes půlnoc), API serveru.

---

## 14. Známá omezení a otevřené body

- **Časy aggTrades** (první obchod skupiny, až 100 ms) ⇒ přelití objemu přes hranice svíček (u M1 až
  jednotky BTC) a nepřesnost časových metrik. Řešitelné jen přechodem na surové `trades` (~1,6× větší).
- **Počet obchodů** nadhodnocen o ~0,02 % (přeskočená trade id).
- **Chybějící obchody v aggTrades (leden–červen 2026):** doplněny ze surových trades (101 dní,
  5 962 BTC, sloupec `repaired_btc`). Nová data je potřeba hlídat validací (kategorie „agg gap“).
- **OI** jen po 5 min; likvidace nejsou k dispozici.
- **Závislost na binu:** POC, aukce, vyčerpání a imbalance se mohou lišit podle velikosti bucketu.
- **Objemové svíčky:** `z` přes rychlost okna W svíček je experimentální a reaguje se zpožděním
  (volba W); poslední rozpracovaná svíčka se nezobrazuje.
- **rel_tod** potřebuje 20 dní historie (od ~21. 1. 2026 je k dispozici).
- **Prahy metrik** (3:1, 50K USD, 5 BTC) jsou výchozí odhady – kalibrovat na delší historii.
- **Data:** k dispozici 2026-01-01 … 2026-10-08 (281 dní, ~10 GB). Další krok: kvantitativní analýza
  features a metrik v paralelní složce (které skutečně odlišují obraty); ruční štítkování a kontext
  vyšších timeframů přijdou později.

---

## 15. Příloha: slovník sloupců

Prefix `lw_` = spodní knot, `uw_` = horní knot. `_usd` = USD notional, bez přípony BTC.

| skupina | sloupce |
|---|---|
| identita a čas | `cid`, `open_time`, `start_ts`, `end_ts`, `first_ts`, `last_ts`, `duration_ms`, `first_agg_id`, `last_agg_id` |
| OHLC a objem | `open`, `high`, `low`, `close`, `volume`, `buy`, `sell`, `volume_usd`, `buy_usd`, `sell_usd`, `delta`, `delta_usd`, `cvd`, `cvd_usd`, `trades`, `agg_trades` |
| kvalita dat | `repaired_btc` (objem doplněný ze surových trades; `first_agg_id`/`last_agg_id` jsou null, pokud svíčka začíná/končí zrekonstruovaným aggTrade) |
| OI | `d_oi`, `d_oi_usd`, `oi_end`, `oi_vol_ratio` |
| statické features | `valid`, `color`, `close_pos`, `delta_ratio` |
| knoty – složky | `{lw,uw}_vol`, `_buy`, `_sell`, `_vol_usd`, `_buy_usd`, `_sell_usd` |
| knoty – features | `{lw,uw}_share`, `_range`, `_conc`, `_delta_usd`, `_delta_ratio`, `lw_sell_share`, `uw_buy_share` |
| rolling | `z`, `vspeed` (objemové svíčky), `rel_tod` |
| POC | `vpoc_<b>`, `dpoc_neg_<b>`, `dpoc_pos_<b>`, b ∈ {5, 10, 25, 50, 100} |
| průběh delty | `dpath_min_usd`, `dpath_max_usd`, `d_recov_l_usd`, `d_recov_l_ratio`, `d_recov_s_usd`, `d_recov_s_ratio`, `t_low_frac`, `t_high_frac`, `t_dmin_frac`, `t_dmax_frac` |
| extrémy | `low_buy_usd`, `low_sell_usd`, `high_buy_usd`, `high_sell_usd`, `unfinished_low`, `unfinished_high`, `exh_low`, `exh_low2`, `exh_high`, `exh_high2` |
| imbalance | `{lw,uw}_{buy,sell}_imb`, `{lw,uw}_{buy,sell}_stack` |
| úsilí | `lw_effort`, `uw_effort`, `body_effort`, `lw_effort_ratio`, `uw_effort_ratio` |
| velké obchody | `{lw,uw}_big_{buy,sell}_usd`, `{lw,uw}_big_count`, `{lw,uw}_big_share`, `lw_big_sell_share`, `uw_big_buy_share` |
| intenzita | `{lw,uw,body}_trades`, `body_vol_usd`, `{lw,uw,body}_avg_trade_usd`, `{lw,uw}_size_ratio`, `{lw,uw,body}_rate`, `{lw,uw}_rate_ratio` |
| čas v knotu | `lw_time_ms`, `uw_time_ms`, `lw_time_frac`, `uw_time_frac` |
