# Deltaprint – BTCUSDT perp footprint (webová aplikace)

Footprint / order-flow viewer pro BTCUSDT perpetual (Binance USDⓈ-M). Backend v Pythonu stahuje denní
aggTrades a open interest z data.binance.vision, staví svíčky, footprint a metriky a servíruje je přes API.
Frontend v Reactu je kreslí na Canvas.

Umí: footprint bid × ask, delta, imbalance s nastavitelným poměrem (např. 300 %) a minimem v USD, stacked
imbalance, POC (objem i delta), profil objemu (session / den / vybraný rozsah s POC a value area), VWAP,
časové (1m / 5m / 15m), objemové (USD, BTC) a tick svíčky, plynulý posun a zoom (myš, dotyk, pinch),
kříž s tooltipem, historii (skok na datum, rozsah), nastavení (barvy, prahy, rozložení) uložené v prohlížeči.

## Rychlé spuštění (Docker Compose)

Potřeba: Docker (Docker Desktop na Windows / Macu).

```bash
cp .env.example .env              # volitelné: heslo, port, čas aktualizace
docker compose up -d --build      # web na http://localhost:8000 (produktová stránka, graf na /app/) + aktualizace dat + živá data
```

Při prvním startu je složka dat prázdná. Služba `updater` hned stáhne posledních 30 dní (pár minut,
potřebuje přístup na data.binance.vision) a pak to opakuje každý den v `FP_UPDATE_AT` (UTC, výchozí 09:30,
kdy už Binance zveřejní včerejší soubory). Data starší než `FP_RETENTION_DAYS` maže.

Bez internetu (nebo pro rychlé vyzkoušení) jdou nahrát syntetická ukázková data:

```bash
docker compose run --rm init      # 30 dní ukázkových dat, aplikace ukáže štítek „ukázková data“
```

Ukázková data se zapisují jen do prázdné složky a první úspěšná aktualizace je nahradí skutečnými.

Na Windows stačí dvojklik na `viewer.bat` (spustí compose a otevře prohlížeč) nebo `start.bat` (menu:
spuštění, aktualizace, ukázková data, testy, instalace, zastavení). Bez Dockeru spouštěče použijí lokální Python.

Užitečné příkazy:

```bash
docker compose logs -f updater                 # průběh stahování
docker compose run --rm updater update         # aktualizace hned, mimo plán
docker compose down                            # zastavení (data zůstávají ve volume fp-data)
docker compose down -v                         # zastavení a smazání dat
```

## Provoz na veřejném serveru

Na adrese `/` je produktová stránka Deltaprint (`site/index.html`), na `/manual/` uživatelský manuál
(`site/manual/`) a samotný graf na `/app/`. Vše je veřejné, bez přihlašování.

Compose ve výchozím stavu poslouchá jen na `127.0.0.1`. Pro přístup zvenku nastavte v `.env`:

```bash
FP_BIND=0.0.0.0
```

Před server patří HTTPS (reverzní proxy, např. Caddy nebo nginx s Let's Encrypt). Kdybyste přístup
někdy chtěli omezit, `FP_AUTH_USER` a `FP_AUTH_PASSWORD` zapnou HTTP Basic přihlášení pro celý web
(kromě `/api/health`).

### Coolify (VPS)

Pro [Coolify](https://coolify.io) je připravený `docker-compose.coolify.yml`: stejné služby `web` a `updater`
bez publikovaného portu (doménu a HTTPS řeší proxy Coolify) a bez `init` se vzorovými daty.

1. New Resource → Public Repository `https://github.com/MichaelChlubna/Kuba-Algo`, větev `main`,
   Build Pack **Docker Compose**, Docker Compose Location `/docker-compose.coolify.yml`.
2. U služby `web` nastavte doménu s portem kontejneru, např. `https://app.3dcap.cz:8000`.
3. Proměnné (volitelné): `FP_RETENTION_DAYS`, `FP_UPDATE_AT`, `FP_LIVE`, případně `FP_AUTH_USER`/`FP_AUTH_PASSWORD`.
4. Data zůstávají ve volume `fp-data` i při novém nasazení.

## Zdroj dat a klíče

Historie jsou veřejné denní soubory z https://data.binance.vision (aggTrades, metrics s open interest),
**API klíč není potřeba**. Stahování, kontrolu SHA256 a převod řeší `backend/fp/download.py` a `convert.py`.
Případné klíče patří jen do `.env` (backend), nikdy do frontendu ani do repozitáře. `.env` je v `.gitignore`,
vzor je `.env.example`.

## Živá data (Binance WebSocket)

V Docker Compose jsou zapnutá (`FP_LIVE=1`, vypnutí `FP_LIVE=0` v `.env`). Web se připojí na veřejný stream
aggTrades (`wss://fstream.binance.com`, bez klíče) a navazuje přesně na poslední obchod posledního
postaveného dne: chybějící obchody od půlnoci UTC (a výpadky spojení) doplní přes REST
(`fapi.binance.com`), nové obchody bere z WebSocketu. Prohlížeč dostává otevřenou svíčku i s footprintem
každou sekundu a graf se posouvá za poslední svíčkou. V liště je štítek „živě“ (zelený) nebo „doplňuji“ /
„připojuji“ (oranžový).

- Živé svíčky se počítají stejnými funkcemi jako denní build (test `backend/tests/test_live.py` to porovnává),
  objemové a tick svíčky navazují na stav posledního postaveného dne. Bez historie zůstávají jen z-score,
  objem vůči času dne a ΔOI (ty doplní až denní build).
- Po denní aktualizaci (09:30 UTC) se živá data sama přepnou na nově postavený den.
- Obchody se průběžně ukládají do `data/live/`, takže restart nemusí vše stahovat znovu.
- Živá data navazují jen na skutečnou historii: dokud updater nepostaví první dny (nebo když jsou ve složce
  ukázková data), čekají a pak se zapnou samy. Při prvním spuštění během dne doplnění od půlnoci chvíli trvá
  (REST limit Binance, zhruba 100 tisíc obchodů za minutu).
- Binance blokuje přístup z některých zemí (např. USA, odpověď 451); server pak musí běžet jinde.
- Adresy streamu a REST jsou v `backend/config.yaml`, sekce `live`.

## Vývoj

Potřeba: Python 3.12+ a Node 22+.

```bash
# backend (API na http://localhost:8000)
cd backend
pip install -r requirements.txt -r requirements-dev.txt
python -m fp sample          # nebo: python -m fp update (skutečná data)
python -m fp serve

# frontend (Vite s hot reloadem na http://localhost:5173/app/, /api se přeposílá na backend)
cd frontend
npm ci
npm run dev
```

`npm run build` sestaví frontend do `frontend/dist`, odkud ho `python -m fp serve` servíruje sám na `/app/`
(jiný backend pro dev server: `FP_BACKEND=http://host:port npm run dev`).

Testy:

```bash
cd backend && python -m pytest       # pipeline, metriky, API, golden testy
cd frontend && npm test              # imbalance, stacky, VWAP, převzorkování
cd frontend && npm run typecheck
```

Golden testy (`backend/tests/golden/`) porovnávají výstupy (svíčky, footprint, delta, POC, imbalance metriky,
odpovědi API) s výstupy původní verze aplikace na stejných ukázkových datech. Frontendový test imbalance
kontroluje, že prohlížeč počítá imbalance stejně jako backend. Po záměrné změně výpočtu se golden data
přegenerují: `cd backend && python -m tests.golden_util`.

## Architektura

```
data.binance.vision ──► fp download / convert ──► data/parquet (po dnech)
                                   │
                         fp build (svíčky, footprint v binu 5 USD, POC, metriky, objemové / tick svíčky)
                                   ▼
                        data/derived (parquet po dnech) ──► FastAPI (fp/server.py, sloupcový JSON, gzip)
                                                                   │
                                     React + Zustand + Canvas (frontend/) ◄┘
```

| složka | obsah |
|---|---|
| `backend/fp/` | pipeline (`download`, `convert`, `build`, `volume_bars`, `metrics`, `periods`), plán aktualizací (`update`), ukázková data (`sample`), API (`server`) |
| `backend/config.yaml` | konfigurace (symbol, okno 30 dní, biny, prahy objemových a tick svíček, session) |
| `frontend/src/chart/engine.ts` | vykreslování: kreslí jen viditelné svíčky, kříž na samostatné vrstvě, data se načítají po kouscích |
| `frontend/src/lib/footprint.ts` | imbalance, stacked imbalance, VWAP, převzorkování binů |
| `frontend/src/store/` | nastavení (Zustand, uložené v `localStorage`) a stav UI |
| `frontend/src/api/types.ts` | typy sdílené s backendem, popsané v [docs/datove-struktury.md](docs/datove-struktury.md) |
| `data/` | data (v Dockeru volume `fp-data`), není v repozitáři |
| `docs/` | [metodika](docs/metodika.md) (výpočty, features, metriky), [pipeline](docs/pipeline.md), původní zadání |

Proměnné prostředí backendu: `FP_DATA_DIR`, `FP_HOST`, `FP_PORT`, `FP_RETENTION_DAYS`, `FP_AUTH_USER`,
`FP_AUTH_PASSWORD`, `FP_STATIC_DIR`, `FP_SITE_DIR`, `FP_CONFIG` (`backend/fp/config.py`, `server.py`).
