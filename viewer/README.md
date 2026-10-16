# BTCUSDT perp – footprint pipeline a detektor absorpce

> Hotové kroky 1–6 (data, časové svíčky + validace, detektor, footprint + OI, viewer, objemové svíčky). Zbývá: rozšíření na 3 měsíce dat.

Podrobný systematický popis (data → zpracování → viewer → detektor a metriky s tezemi): **[metodika.md](metodika.md)**.

## Struktura složek

```
footprint/
├── viewer.bat, start.bat   spouštěče (dvojklik)
├── data/                   sdílená data (raw zipy, parquet, odvozené svíčky/footprint/series, validace)
└── viewer/                 tato fáze 1: pipeline + viewer + detektor + metriky (hotovo, neměnit)
    ├── fp/                 Python balík (download, build, validate, server) + fp/static (frontend)
    ├── tests/              pytest
    ├── config.yaml         konfigurace; cesty k datům relativně: ../data/...
    ├── README.md, metodika.md, footprint_prompt.md (původní zadání)
```

Cesty `data/...` v tomto dokumentu jsou vůči hlavní složce `footprint/`. Příkazy `python -m fp ...` se
spouštějí ve složce `viewer/` (spouštěče to dělají samy). Další fáze (kvantitativní analýza) budou
v paralelních podsložkách a čtou stejnou složku `data/`.

## Spuštění

**Nejjednodušší:** dvojklik na `start.bat` v hlavní složce → menu:
1 viewer (otevře prohlížeč), 2 aktualizace dat (stažení + build do včerejška), 3 validace, 4 testy,
5 instalace knihoven. `viewer.bat` spustí rovnou viewer (pokud už běží, jen otevře prohlížeč).

Z příkazové řádky (ve složce `viewer/`):

```bash
pip install polars pyarrow pyyaml requests fastapi uvicorn pytest
python -m fp download                          # rozsah z config.yaml
python -m fp download --start 2026-10-08 --end 2026-10-08
python -m fp download --datasets trades       # volitelné: surové obchody jen pro přesnou validaci
python -m fp build                             # parquet + svíčky M1/M5/M15 + objemové + features + signály
python -m fp build --end yesterday             # totéž do včerejška (vhodné po stažení nových dní)
python -m fp validate                          # porovnání s klines + známé případy A/B
python -m fp serve                             # viewer na http://localhost:8000
python -m pytest
```

### Datové vrstvy
| Adresář | Obsah |
|---|---|
| `data/raw/` | zipy + `.CHECKSUM` (zrcadlo data.binance.vision) |
| `data/parquet/{aggTrades,metrics,klines_1m,klines_5m,trades}/BTCUSDT/YYYY-MM-DD.parquet` | převedené CSV, normalizované názvy sloupců, časy v ms UTC |
| `data/derived/candles/{1m,5m,15m}/` | denní fáze: svíčky + složky knotů + features závislé jen na svíčce |
| `data/derived/series/{1m,5m,15m}/` | celorozsahová fáze: CVD, ΔOI, rolling z-score, objem vůči času dne, signály |
| `data/validation/` | CSV s neshodami proti klines |

`build` je idempotentní (hotové dny přeskočí, `--force` přestaví). Celorozsahová fáze se přepočítá
vždy přes všechny postavené dny (je levná), takže rolling statistiky navazují přes hranice dnů.

Downloader je idempotentní: soubor se považuje za hotový, když SHA256 sedí s `.CHECKSUM`
(výsledek se cachuje markerem `.ok`). Stahuje se atomicky přes `.part`, takže přerušený běh jde
jen znovu spustit. Konec rozsahu se ořízne na včerejšek (denní soubory vycházejí až další den,
na S3 se objevují zhruba v 7–9 h UTC). Chybějící soubor (404) se hlásí jako `missing`.

## Ověřená fakta o datech (ověřeno 2026-10-09 na souborech z 2026-10-08)

### Cesty
Všechny očekávané cesty platí (`data/futures/um/daily/{aggTrades,metrics,klines/1m,klines/5m}/BTCUSDT/...`),
ověřeno výpisem S3 bucketu `data.binance.vision`. Lokálně se zrcadlí do `data/raw/`.

### aggTrades
- Hlavička (novější soubory): `agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker`.
- **Starší soubory hlavičku nemají** (ověřeno 2021-06-01 a 2022-06-01) – pořadí sloupců je stejné.
  Converter detekuje hlavičku podle toho, zda je první pole číslo.
- `transact_time` je v **milisekundách** (13 číslic) i u souborů z 2021, 2022 a 2026.
  Converter přesto kontroluje počet číslic (≥ 16 ⇒ µs) a normalizuje na ms.
- `agg_trade_id` je souvislý a čas je v pořadí id monotónní.
- `first_trade_id`/`last_trade_id` mezi řádky **nejsou úplně souvislé** (2026-10-08: ~10,9 tis. chybějících
  trade id z 4,5 mil.). Součet `last − first + 1` přes den = 4 504 915, kdežto součet `count` z 1m klines
  = 4 503 863 (rozdíl 1 052). Objem, quote volume i taker buy volume přitom sedí přesně. Rozbor
  neshody počtu obchodů je v kroku 2 (validace).
- Cena má 1 desetinné místo (tick 0,1), minimální množství 0,001 BTC.

### klines (1m, 5m)
- Hlavička: `open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore`.
  Starší soubory bez hlavičky. Časy v ms, `open_time` = začátek svíčky (UTC).

### metrics
- Hlavička: `create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio`
  (i v roce 2022).
- `create_time` je text `YYYY-MM-DD HH:MM:SS` (UTC), 288 řádků/den po 5 min (00:00 … 23:55).
  **Řádky v souboru nejsou seřazené** – řadí se při konverzi.
- `sum_open_interest` je v BTC, `sum_open_interest_value` v USD.

### Zarovnání OI snapshotu (`create_time`)
**Snapshot s `create_time = T` popisuje OI v čase T + 5 min** (konec 5min okna, které v T začíná).
Ověřeno dvěma nezávislými způsoby:
1. Binance REST `GET /futures/data/openInterestHist?period=5m` vrací pro `timestamp = 00:20 UTC`
   přesně stejné hodnoty jako řádek metrics s `create_time = 00:15`.
2. Implikovaná cena `sum_open_interest_value / sum_open_interest` (≈ mark price) porovnaná
   s cenou posledního obchodu z aggTrades přes všech 288 snapshotů dne:

   | posun od create_time | medián \|chyby\| (USD) |
   |---|---|
   | +0 s | 61,4 |
   | +240 s | 23,2 |
   | +299 s | **0,67** |
   | +300 s | 1,84 |
   | +360 s | 30,2 |

Pipeline proto používá `oi_time = create_time + 5 min`. ΔOI svíčky
= OI(poslední snapshot s `oi_time` ≤ konec svíčky) − OI(poslední snapshot s `oi_time` ≤ začátek svíčky).

## Validace proti oficiálním klines (krok 2)

`python -m fp validate` porovná M1 a M5 postavené z aggTrades s oficiálními klines (open, high, low,
close, volume, quote volume, taker buy volume, taker buy quote volume, count). Výsledek pro
2026-10-01 … 2026-10-08: **všechny neshody jsou vysvětlené, nic se neupravuje**.

| pole (M1, 11 520 svíček) | neshod | vysvětleno hranicí |
|---|---|---|
| open | 386 | 386 |
| high / low | 10 / 18 | 10 / 18 |
| close | 0 | – |
| volume | 1 195 (max 5,75 BTC) | 1 195 |
| quote volume | 1 202 (max 0,46M USD) | 1 202 |
| taker buy volume | 727 | 727 |
| count | 4 033 | viz níže |

Denní součty objemů sedí přesně. Rozdíly mají dvě příčiny, obě ověřené na surovém datasetu `trades`:

1. **Přelití přes hranici svíčky.** Jeden aggTrade sdružuje obchody za až 100 ms (ověřeno: čas
   obchodu − `transact_time` je 0 až 100 ms) a nese jen čas prvního obchodu. Klines řadí každý
   obchod podle jeho vlastního času, takže když aggTrade začne v posledních 100 ms svíčky, část
   jeho objemu patří v klines do další svíčky. Proto nesedí hlavně `open` (klines open = cena
   přelitého zbytku) a nikdy `close`. Svíčky postavené ze surových trades sedí s klines **přesně**
   ve všech polích a dnech. Validátor u každé neshody ověří, že rozdíl leží v mezích objemu/cen
   aggTrades z posledních 100 ms předchozí svíčky (včetně přelití přes půlnoc).
2. **Přeskočená trade id.** `last_trade_id − first_trade_id + 1` (počet obchodů podle zadání)
   nadhodnocuje: uvnitř rozsahů aggTrades existují id, ke kterým žádný obchod není. Součet
   přeskočených id přes 8 dní je 5 920 a přesně odpovídá celkovému rozdílu `count` (−5 920,
   ~0,02 %). Pipeline počítá obchody podle zadání (`last − first + 1`); rozdíl je zanedbatelný.

3. **Obchody chybějící v aggTrades dumpu (leden–červen 2026) – opraveno.** Z dumpu vypadly celé aggTrade
   řádky (ověřeno na surových trades: bloky po sobě jdoucích id, jedna cena a strana, ≤ 90 ms). Pro 101
   zasažených dní se ze surových trades rekonstruují a vkládají zpět (`rep` = true, svíčky `repaired_btc`),
   celkem 5 962 BTC. Po opravě: chybějící obchody 0, nevysvětlené rozdíly 0. Podrobně metodika.md, sekce 9.

Důsledek pro strategii: u M1 se může v jedné svíčce objevit až jednotky BTC posunutých do sousední
svíčky. Pro M5/M15 je efekt relativně menší. Odstranit by šel jen přechodem na dataset `trades`
(zip ~1,6× větší než aggTrades, 34 vs. 22 MB za 2026-10-08).

## Open interest a ΔOI
- `oi_time = create_time + 5 min` (viz ověření výše).
- ΔOI svíčky = OI(poslední snapshot ≤ konec) − OI(poslední snapshot ≤ začátek); pokud mezi tím žádný
  snapshot není, ΔOI je prázdné (null), nic se neinterpoluje. U M1 tak má hodnotu jen každá pátá
  svíčka (ta, která končí na hranici 5 min); M5 a M15 mají hodnotu vždy.

## Detektor (krok 3)

Knot se počítá z jednotlivých aggTrades (ne z footprint binů): spodní knot = cena **striktně pod**
min(O, C), horní = **striktně nad** max(O, C). Všechny podíly jsou v USD notional.

| podmínka | long | short |
|---|---|---|
| V1 | z = (ln Vol_USD − průměr) / std z N=30 předchozích svíček (bez aktuální) ≥ 2 | stejné |
| V2 | Vol(K)/Vol ≥ 0,5 | totéž pro horní knot |
| D1 | Δ(K) < 0 | Δ(K) > 0 |
| D2 | SellVol(K)/SellVol ≥ 0,5 | BuyVol(K)/BuyVol ≥ 0,5 |

Další podmínky (volitelné, defaultně vypnuté):

| podmínka | long | short |
|---|---|---|
| P1 | volume POC bucket `[vpoc, vpoc + bin)` leží **celý** pod min(O, C) | bucket celý nad max(O, C) (`vpoc > max(O,C)`) |
| P2 | delta POC = úroveň s **nejzápornější** deltou, bucket celý v knotu (`dpoc + bin ≤ min(O,C)`) | nejkladnější delta, `dpoc > max(O,C)` |

- POC se počítá z footprintu v USD notional pro biny 5/10/25/50/100 (`vpoc_<b>`, `dpoc_neg_<b>`, `dpoc_pos_<b>`
  ve svíčkách); bin pro detektor se volí v UI (default 25 = default zobrazení, `detector.poc_bin`).
  Při shodě objemu rozhoduje nižší úroveň. Když svíčka nemá žádnou úroveň se zápornou (kladnou) deltou,
  P2 pro long (short) nesplněna.
- Signál = svíčka je platná a z **zapnutých** podmínek (zaškrtávátka V1 V2 D1 D2 P1 P2) je splněno aspoň
  „min. splněných“ (`detector.conditions`, `detector.min_true`, null = všechny). Default V1–D2, všechny →
  stejné signály jako dřív. Panel svíčky ukazuje u každé podmínky ✔/✘ s čísly a „x/y zapnutých, potřeba k“;
  nezapnuté podmínky jsou zašedlé, ale vyhodnocené.

Okrajové případy: nulový knot → podíl 0, nesplněno; SellVol = 0 (BuyVol = 0) → D2 nesplněna;
H = L → svíčka se přeskočí (`valid = false`); dokud není N předchozích svíček, z = null → V1 nesplněna.
Rolling okno běží přes hranice dnů. `rel_tod` (objem / medián objemu ve stejném UTC čase za
předchozích 20 dní) je null, dokud neexistuje všech 20 předchozích hodnot.

Uložené sloupce (`data/derived/series`): OHLC, volume/buy/sell v BTC i USD, delta, CVD, trades,
start/end/duration, `d_oi`, `d_oi_usd`, `z`, `rel_tod`, `color`, `close_pos`, `delta_ratio`,
surové složky obou knotů `{lw,uw}_{vol,buy,sell}[_usd]`, `lw_share`, `lw_range`, `lw_conc`,
`lw_delta_usd`, `lw_delta_ratio`, `lw_sell_share` (zrcadlově `uw_*`, `uw_buy_share`), podmínky
`L_V1…L_D2`, `S_V1…S_D2` a `long_signal`, `short_signal`.

### Známé případy 2026-10-08 (M5)
- **Svíčka A = 12:50 UTC** (08:50 New York EDT, 14:50 Praha): O 82 204,2 H 82 384,9 L 81 849,2 C 82 267,3,
  objem 462,0M USD, delta −99,2M. **Long signál**: z = 4,35, V2 = 0,768, Δ(K) = −123,0M, D2 = 0,852.
- Tři svíčky po A: delta +10,3M, −1,5M, +12,9M (znaménka sedí s referencí).
- **Svíčka B = 13:40 UTC** (09:40 New York): objem 370,9M, delta −47,0M, low 81 715,0. **Detektor spouští long**:
  z = 2,83, V2 = 0,783, Δ(K) = −54,4M, D2 = 0,825.
- Časové pásmo screenshotu nelze z dat ověřit (screenshot není k dispozici); svíčky jsou nalezené
  podle hodnot, ne podle času.

## Časová pásma
- Interně je vše v UTC (epoch ms); denní soubory jsou UTC dny.
- Zobrazení: `server.timezone: America/New_York` (přepínač na UTC v UI). Převod jde přes IANA pásmo,
  takže letní/zimní čas se řeší automaticky. V roce 2026: EDT (UTC−4) od 8. 3., EST (UTC−5) od 1. 11.
  Pozor: Evropa přechází jindy (25. 10.), rozdíl NY–Praha je proto týden v roce 5 h místo 6 h.
- Zarovnání svíček (M1/M5/M15) se DST nemění, posun NY je vždy celé hodiny.
- `rel_tod` (objem vůči stejnému času dne) porovnává **lokální NY čas** (`detector.tod_timezone`),
  aby US session zůstávala na stejném místě i přes přechod času. V den přechodu na zimní čas
  existuje hodina 01:00–02:00 dvakrát; obě svíčky se porovnávají se stejnou historií.
- Reset CVD je podle zadání v 00:00 UTC; lze přepnout `aggregation.cvd_reset_timezone: America/New_York`.

## Footprint (krok 4)
- `data/derived/footprint/{1m,5m,15m}/YYYY-MM-DD.parquet`: `start_ts, level, buy, sell, buy_usd,
  sell_usd, delta, total, delta_usd, total_usd` pro každou svíčku a cenovou úroveň.
- Úroveň = `floor(price / bin) · bin` (dolní hrana binu), počítáno v celých ticích (0,1 USD), aby
  cena přesně na hraně binu nespadla kvůli float zaokrouhlení do nižšího binu.
- Předpočítáno v základním binu 5 USD. Re-agregace na 10/25/50/100 je prostý součet
  (`floor(level/b)·b`), ověřeno proti přímému výpočtu. Součty footprintu = objemy svíčky.
- Velikost: ~0,6 MB/den pro M1 → ~55 MB za 3 měsíce.

## Viewer (krok 5)

`python -m fp serve` → http://localhost:8000. Backend FastAPI čte `data/derived/series` a `data/derived/footprint`
(per-day parquet s LRU cache v paměti), odpovědi jsou sloupcové JSON s gzipem. Frontend je vanilla JS + Canvas 2D
bez build kroku (`fp/static/`).

API:
| endpoint | popis |
|---|---|
| `GET /api/meta` | dostupné agregace a rozsah dnů, parametry detektoru, časové pásmo, biny |
| `GET /api/candles?agg=5m&start=ms&end=ms&pad=N[&full=1]` | svíčky se `start_ts` v [start, end) + `pad` svíček před `start`; default lehké sloupce (graf + detektor), `full=1` všechny |
| `GET /api/candle?agg&cid&start_ts` | všechny sloupce jedné svíčky (detail v panelu) |
| `GET /api/periods?start&end&tz&bin` | sessions a dny v rozsahu: high/low, volume a delta profil (z 5m dat) |
| `POST /api/export` | signály z prohlížeče → CSV se všemi features ze serveru |
| `GET /api/footprint?agg=5m&start=ms&end=ms` | footprint v základním binu 5 USD; prohlížeč re-agreguje na 10/25/50/100 |

Líné načítání: prohlížeč stahuje svíčky po UTC dnech podle viditelného rozsahu a vždy drží aspoň N + 20 svíček
vlevo od okraje (z-score se počítá v prohlížeči). Footprint se stahuje jen pro viditelné dny a jen když je
přiblížení dost velké na buňky; dny dál než 3 dny od pohledu se z paměti uvolní.

Ovládání:
- kolečko = zoom času (kolem kurzoru), Ctrl/Shift/Alt + kolečko nebo kolečko nad cenovou osou = zoom ceny,
  tažení = posun (svislý posun vypne automatické měřítko ceny), dvojklik = reset zoomu,
- tažení za osu: cenová osa nahoru/dolů = přiblížení/oddálení ceny (kolem středu panelu), časová osa
  doprava/doleva = širší/užší svíčky (ukotveno vpravo); dvojklik na ose resetuje jen tu osu,
- **Profil** (tlačítko v liště, On/Off, pamatuje si stav v prohlížeči): u každé svíčky přes buňky vykreslí
  vyhlazenou křivku rozložení celkového objemu (buy + sell) po cenových úrovních aktuálního binu, normovanou
  na maximum svíčky; tečka = POC (úroveň s největším objemem). Zobrazuje se v režimu buněk (při dostatečném
  přiblížení), ve všech režimech buňky (delta / sell × buy / volume),
- **☀ Světlý / ☾ Tmavý**: přepínač režimu celého rozhraní (pamatuje si ho prohlížeč). Světlý režim má krémové
  pozadí `#f8f4e4` a vlastní paletu: tmavší zelená/červená, volume profil tmavě oranžový (žlutá by na světlém
  pozadí zanikla), delta profil sytě fialový, slabší výplně buněk a tmavý text,
- **Δ Profil** (vlastní tlačítko On/Off, fialová): u každé svíčky křivka delty (buy − sell) po cenových
  úrovních kolem svislé nulové osy uprostřed buňky – doprava převaha nákupů, doleva prodejů – normovaná na
  max |delta| svíčky; tečka = úroveň s největší |delta|. Lze zapnout samostatně i spolu s volume profilem.
- klik na svíčku = boční panel se všemi features a podmínkami V1/V2/D1/D2 (✔/✘ s čísly) a čárkované hranice
  knotu na min(O,C) (L, zelená) a max(O,C) (S, červená) se štítky na cenové ose,
- režimy buňky: delta (default), sell × buy (levá půlka sell, pravá buy), volume,
- úrovně detailu: buňky s čísly → při oddálení jen barevné buňky → jen svíčky,
- barva buňky: intenzita podle |hodnoty| vůči 95. percentilu viditelných buněk, hodnoty pod 12 % bez výplně,
- čas: default America/New_York (DST přes Intl/IANA), přepínač UTC,
- **Vrstvy ▾**: on/off pásy sessions, high/low, volume a delta profil sessions a dnů (sessions v `config.yaml`,
  default NY čas Asia 18–03, London 03–08, New York 08–17; den = kalendářní den ve zvoleném pásmu),
- rozsah „Od – Do“ + **Načíst** (dny ve zvoleném pásmu) / **Vše** (celý dataset): načte všechny svíčky rozsahu
  a zobrazí ho celý; signály a export pak platí pro celý rozsah. Limit 150 000 svíček (celý rok M5, M15 a
  objemové svíčky ano, M1 max ~100 dní). Při velkém oddálení se svíčky slučují po pixelech,
- tabulka pod footprintem: Volume, CVD, Delta (USD), Trades, OI Δ; panel ΔOI s přepínačem BTC/USD.
  ΔOI je prázdné u svíček bez hranice 5min snapshotu (M1, objemové svíčky),
- detektor: N, práh z, V2, D2, long/short; přepočet v prohlížeči z uložených features, počet signálů v načteném
  rozsahu a export signálů s features do CSV.

Server posílá UI soubory s `Cache-Control: no-cache` (prohlížeč se vždy zeptá, nezměněné soubory jdou jako
304), takže po aktualizaci kódu stačí obyčejné obnovení stránky.

Výkon (Chrome, 1600×900): vykreslení snímku ~1–3 ms, přepnutí binu bez dotazu na server, přepnutí agregace
< 0,2 s včetně stažení dat.

## Objemové svíčky (krok 6)

- Svíčka se uzavře, jakmile objem dosáhne prahu: `vusd_<práh>` v USD notional (default 100M) nebo
  `vbtc_<práh>` v BTC (default 1000). Prahy v `config.yaml` (`aggregation.volume_usd`, `volume_btc`).
- aggTrade, který práh překročí, se rozdělí (stejná cena i strana), zbytek jde do další svíčky; jeden velký
  obchod může vytvořit i několik svíček. Počítá se v celých jednotkách (0,001 BTC; 0,0001 USD), takže
  objem se zachová přesně (ověřeno: Σ svíček + otevřená svíčka = Σ obchodů; každá svíčka má přesně práh).
- Stav (rozpracovaná svíčka) pokračuje přes hranice dnů: po každém dni se ukládá do
  `data/derived/vstate/<agg>/YYYY-MM-DD.{json,parquet}`, další build navazuje. Přestavba dne vynutí přestavbu
  všech následujících. Svíčky se ukládají do souboru dne, ve kterém se **uzavřou** (footprint), resp. dne
  otevření (series); poslední rozpracovaná svíčka se nezobrazuje, dokud se neuzavře.
- Čas svíčky = první obchod (open), konec = poslední obchod, duration = konec − začátek.
- Počet obchodů rozděleného aggTrade se připíše svíčce s jeho první částí (nedělí se).
- `cid` = pořadové číslo svíčky (u časových svíček `cid = start_ts`); je to unikátní klíč, protože
  dvě objemové svíčky mohou začínat stejným obchodem.
- ΔOI: jen u svíček, do jejichž intervalu (první, poslední obchod] spadá hranice 5min snapshotu.
- **Detektor (experimentální):** V1 = zrychlení toku objemu: −ln(čas posledních W svíček,
  od uzavření t−W do uzavření t) jako z-score vůči N dřívějším stejně dlouhým oknům, která skončila před
  začátkem aktuálního okna (W = `detector.vol_window`, default 10). Reaguje se zpožděním – viz metodika.md.
  V2/D1/D2 beze změny.
- **Vlastní práh z UI** („Vlastní práh…“): server spočítá svíčky na pozadí přes všechny dny (UI ukazuje
  průběh, ~0,2 s/den) a uloží je na disk; další otevření je okamžité a `fp build` je pak udržuje
  aktuální spolu s ostatními. Povolený rozsah: 1M–100B USD, 10–1M BTC.

## Metodika

Shrnutí definic a rozhodnutí, která ovlivňují výsledky. Parametry jsou v `config.yaml`.

### Data a čas
- Zdroj: aggTrades Binance USD-M. Agresor = taker; `is_buyer_maker = true` ⇒ agresivní prodej.
  Počet obchodů = `last_trade_id − first_trade_id + 1` (nadhodnocuje o ~0,02 %, viz validace).
- aggTrade nese čas prvního obchodu, ostatní mohou být až o 100 ms později ⇒ na hranicích svíček se
  část objemu může přiřadit do předchozí svíčky (rozdíl proti klines je zdokumentovaný, neopravuje se).
  Časové metriky uvnitř svíčky mají stejnou nepřesnost (≤ 100 ms).
- Interně UTC, zobrazení America/New_York (DST). OI snapshot `create_time = T` platí pro T + 5 min.

### Knot a detektor
- Spodní knot = obchody s cenou **striktně pod** min(O, C), horní = striktně nad max(O, C); počítá se
  z jednotlivých aggTrades, ne z footprint binů. Podíly v USD notional.
- V1: z-score ln(Vol_USD) přes N předchozích svíček (bez aktuální, výběrová std). Objemové svíčky:
  rychlost okna posledních W svíček vs N dřívějších nepřekrývajících se oken, **experimentální**. Rolling okno běží přes hranice dnů; v prohlížeči slouží
  prvních N načtených svíček jako rozjezd.
- P1 („volume POC v knotu“) je **přísná**: celý POC bucket musí ležet v knotu (`vpoc + bin ≤ min(O,C)`,
  u shortu `vpoc > max(O,C)`). Volnější varianta (jen střed bucketu) by dávala víc signálů.
- P2: **delta POC je stranově specifický** – pro long úroveň s nejzápornější deltou (kde prodávající
  tlačili nejvíc), pro short s nejkladnější – a jeho bucket musí ležet celý v knotu (bez vazby na volume
  POC). Δ profil ve vieweru ukazuje oba delta POC (červená / zelená tečka).
- **POC bin** je volitelný (5/10/25/50/100, default 25) – P1/P2 se mohou mezi biny lišit. Shoda objemu ⇒
  nižší úroveň.
- Signál = platná svíčka (H > L) a z zapnutých podmínek je splněno aspoň „min. splněných“.

### Metriky uvnitř svíčky (`fp/metrics.py`, sekce v panelu svíčky, sloupce v exportu)
| metrika | definice | proč (absorpce) |
|---|---|---|
| průběh delty | kumulativní delta (USD) obchod po obchodu; `dpath_min/max`, návrat od minima `delta − min` a jeho poměr k \|min\| (long), pokles od maxima (short); kdy během svíčky vzniklo low/high a min/max delty (podíl trvání) | velká záporná delta do low, která se otočí = prodeje pohlceny |
| aukce na extrému | v nejnižším/nejvyšším 5USD bucketu buy i sell > 0 ⇒ **nedokončená**, jedna strana nulová ⇒ **dokončená** | dokončená aukce = vyčerpání, nedokončená = trh se může vrátit |
| vyčerpání | objem nejnižšího (1 a 2) bucketu / objem POC bucketu (5 USD) | malý objem na samém extrému = nikdo už netlačí |
| imbalance | diagonální v 5USD binu: buy(L) ≥ 3 × sell(L − 5) a buy(L) ≥ 50K USD (sell zrcadlově proti buy(L + 5)); počítají se úrovně celé v knotu; stack = nejdelší řada po sobě jdoucích úrovní | buy imbalance ve spodním knotu = kupující přebírají; řada sell imbalancí = agresivní prodej, který cenu neposunul |
| úsilí vs výsledek | USD objemu v knotu / délka knotu (USD na 1 USD pohybu), totéž pro tělo, poměr knot/tělo | hodně objemu, malý pohyb = absorpce |
| velké obchody | aggTrade ≥ 5 BTC (u objemových svíček velikost původního obchodu): podíl na objemu knotu, počet, podíl velkých na sell (long) / buy (short) v knotu | velcí agresoři pohlceni limitními příkazy |
| intenzita | průměrná velikost obchodu a obchody/s v knotu vs v těle | zrychlení a zvětšení obchodů v knotu = boj o úroveň |
| čas v knotu | podíl trvání svíčky, kdy byla poslední cena v knotu (cena platí do dalšího obchodu) | rychlé odmítnutí vs dlouhé testování |
| ΔOI / volume | ΔOI (BTC) / objem svíčky (BTC), jen kde je hranice 5min snapshotu | OI ↓ = zavírání pozic / likvidace, OI ↑ = nové pozice (u longu potenciálně chycení shorti) |

Parametry: `metrics.imbalance_ratio` (3), `imbalance_min_usd` (50 000), `stack_min` (3, zatím jen
informativní), `big_trade_btc` (5). Imbalance a extrémy se počítají v základním 5USD binu, nezávisle na
binu zobrazení. Poměry s nulovým jmenovatelem (bez knotu, bez těla) jsou prázdné. Poměr návratu delty se
v panelu zobrazuje jen, když je extrém delty aspoň 1 % objemu svíčky.
