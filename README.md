# Ônibus RJ - Ao Vivo

Acompanhe os ônibus do município do Rio de Janeiro em tempo real, no mapa.

**App ao vivo: https://kbrianps.com/tools/onibus-rj-ao-vivo/**

[Português](#português) · [English](#english)

---

## Português

Web app mobile-first (PWA) que mostra a posição em tempo real dos ônibus da SPPO (Secretaria Municipal de Transportes do Rio de Janeiro). O usuário escolhe a linha e vê os veículos se movendo pelo mapa, com a rota oficial sobreposta.

### Motivação

- **Quem não tem espaço no celular**: o app abre direto no navegador (~50 KB) e pode ser instalado como PWA depois, sem precisar baixar 50–100 MB de Play Store.
- **Quem precisa de algo rápido**: autocomplete de linha + cache do PWA fazem o app abrir em segundos e responder instantâneo nas visitas seguintes.
- **Quem tem dificuldade com aplicativos**: interface enxuta — uma busca de endereço no topo, uma busca de linha embaixo, e o mapa. Sem menus, sem login, sem pop-up.
- **Quem se irrita com anúncios**: zero anúncios. Concorrentes inserem ads em pop-up, banners e até áudio em momentos inoportunos (esperando o ônibus, com pouco sinal). Aqui o foco é o ônibus.
- **Quem precisa saber o que está acontecendo**: indicador "Próxima atualização em Xs" com pulso "Atualizando…" quando a busca acontece. Sem ansiedade nem dúvida se o app travou.

### Stack

- **Frontend**: TypeScript + Vite + Leaflet (vanilla, sem framework). Bundle ~50 KB gzip.
- **Proxy/API**: Cloudflare Worker (cache do snapshot SPPO, geocoding, dados de rotas).
- **Tiles**: CartoDB Light All (OpenStreetMap).
- **Geocoding**: Nominatim/OSM (busca de endereço, reverse geocode do GPS).
- **Rotas**: GTFS oficial do Rio (do data.rio, via TUMI Datahub), simplificado com Ramer-Douglas-Peucker.
- **Limite do município**: GeoJSON do IBGE.
- **PWA**: vite-plugin-pwa (instalação no celular, cache de tiles offline).

### Funcionalidades

- Mapa interativo focado no município do Rio (máscara branca esmaecida nas áreas vizinhas).
- Polling adaptativo (5–20s) baseado no timestamp do snapshot SPPO — busca o próximo dado logo após a API atualizar, sem desperdiçar requests.
- Marcador animado dos ônibus (anima posição entre polls).
- Pin azul (frescos) ou cinza (sem update há mais de 2 minutos).
- Polilinha da rota oficial (GTFS) sobreposta ao mapa.
- Busca de endereço/bairro com sugestões (Nominatim).
- Geolocalização do usuário com pin vermelho; preenchimento automático da busca via reverse geocode.
- Persistência da última linha e localização escolhida (localStorage).
- Sugestões de linha ao digitar (autocomplete).
- Estados visuais no botão de busca: lupa (idle) → spinner (loading) → check (success).
- PWA instalável.

### Estrutura

```
onibus-rj-ao-vivo/
├── package.json              # frontend (vite, leaflet, vite-plugin-pwa)
├── vite.config.ts            # PWA + proxy /api -> :8787
├── index.html
├── src/
│   ├── main.ts               # bootstrap, polling, geolocation, glue
│   ├── map.ts                # Leaflet, marcadores, polyline, máscara
│   ├── api.ts                # fetchBuses, fetchLines, fetchRoute
│   ├── geocode.ts            # searchPlaces, reverseGeocode
│   ├── ui.ts                 # busca, autocomplete, estados do botão
│   ├── geo.ts                # wrappers de navigator.geolocation
│   ├── storage.ts            # localStorage helpers
│   ├── types.ts              # Bus, bearingDeg
│   ├── styles.css
│   └── rio-boundary.json     # polígono do município (IBGE, 3.8 KB)
└── worker/
    ├── wrangler.toml
    ├── src/index.ts          # endpoints /sppo /lines /route /geocode /reverse /health
    └── data/
        └── routes.json       # shapes GTFS por linha (1.77 MB raw / 340 KB gzip)
```

### Endpoints (Worker)

| Path | Método | Descrição |
|---|---|---|
| `/sppo?line=X` | GET | Posições atuais dos ônibus da linha X (filtra do snapshot SPPO, dedup por veículo) |
| `/sppo?bbox=minLat,minLng,maxLat,maxLng` | GET | Posições dentro de uma área |
| `/lines` | GET | Lista de todas as linhas distintas no snapshot atual |
| `/route?line=X` | GET | Polilinhas da rota oficial (GTFS) |
| `/geocode?q=X` | GET | Busca de endereço/local (Nominatim, viewbox Rio) |
| `/reverse?lat=Y&lng=X` | GET | Reverse geocode (coords → endereço) |
| `/health` | GET | Health check |

Cache: snapshot SPPO 15s, geocoding 24h, rotas 7d.

### Desenvolvimento local

Rodar dois processos em paralelo:

```bash
# terminal 1 — proxy
cd worker && npm install && npm run dev      # http://localhost:8787

# terminal 2 — frontend (faz proxy /api -> :8787)
npm install && npm run dev                    # http://localhost:5173
```

Smoke tests do worker:

```bash
curl 'http://localhost:8787/health'
curl 'http://localhost:8787/sppo?line=104' | jq 'length'
curl 'http://localhost:8787/lines' | jq 'length'
curl 'http://localhost:8787/route?line=485' | jq '.shapes | length'
curl 'http://localhost:8787/geocode?q=Maracana' | jq '.[0]'
```

### Deploy (Cloudflare)

```bash
# Worker
cd worker && npx wrangler deploy

# Frontend
npm run build
npx wrangler pages deploy dist --project-name onibus-rj-ao-vivo
```

Antes do deploy de produção, ajustar `BASE` em `src/api.ts` pra apontar para o domínio do worker em produção (`https://onibus-rj-ao-vivo-proxy.<conta>.workers.dev`).

### Atualizar dados de rotas

O GTFS muda raramente (a prefeitura publica eventualmente). Pra atualizar:

```bash
# 1. Baixar zip atualizado
curl -L -o /tmp/gtfs-rio.zip "https://hub.tumidata.org/dataset/d0978152-4bbc-4162-810b-7478c9f2b0f7/resource/f1b70820-9c4a-4295-bc98-c9beb04ba457/download/rdj.zip"

# 2. Extrair
cd /tmp && unzip -o gtfs-rio.zip routes.txt trips.txt shapes.txt

# 3. Rodar o script Python (extrai shapes + simplifica com RDP)
# Ver script em https://github.com/kbrianps/onibus-rj-ao-vivo/blob/main/scripts/build-routes.py
# (gera worker/data/routes.json)

# 4. Upload pro R2 + re-deploy
cd worker
npx wrangler r2 object put onibus-rj-routes/routes.json --file=data/routes.json --content-type=application/json --remote
npx wrangler deploy
```

### Limitações conhecidas

- **API SPPO cobre apenas o município do Rio** (capital). Não inclui ônibus intermunicipais (Niterói, S. Gonçalo, etc — esses são da DETRO/RJ), BRT (API separada da MobilidadeRio), nem vans.
- **OSM brasileiro não tem números de casa**: a busca de endereço encontra a rua mas não o número exato. O número digitado é descartado antes de mandar pro Nominatim.
- **Direção da seta dos ônibus é aproximada**: calculada pelo bearing entre 2 polls consecutivos. Em ruas curvas ou com GPS ruidoso pode dar diagonal estranha. A correção definitiva (snap-to-polyline da rota GTFS) está planejada — ver Roadmap.
- **`wrangler dev` (modo local) tem vazamento de file descriptors** em sessões longas. Sintoma: depois de horas com poll de 15s, o worker para de responder. Solução em dev: `pkill -9 workerd && npx wrangler dev`. Em produção CF não acontece.

### Modo debug

Adicione `?debug=1` na URL (ou `localStorage.setItem('onibus-rj:debug', '1')`) para ligar o HUD de métricas. Ele mostra, em tempo real:

- Heap JS (usado/limite/%) e FPS.
- Contagem e tempo médio/último de cada endpoint (`/sppo`, `/lines`, `/route`, `/geocode`, `/reverse`, tiles).
- Status HTTP e tamanho da última resposta por endpoint, com contador de erros.
- Tiles carregados + tempo médio.
- Snap-to-route: total de chamadas + média em microssegundos.
- Console errors + últimos 5 erros (mensagem truncada).
- Online/offline, uptime da sessão, user-agent.

Botão `copy json` exporta um snapshot completo pra colar em issue/PR. Botão `×` desliga e remove a flag do localStorage.

O HUD é **carregado sob demanda** (dynamic import), então não pesa nada no bundle padrão — só o stub de ~150 bytes vai pra produção. Use pra investigar lentidão, regressão de tamanho de payload ou para abrir issues com dados concretos.

### CI/CD

- **CI** ([.github/workflows/ci.yml](.github/workflows/ci.yml)): rodada em todo push/PR — typecheck + vitest + build.
- **Deploy** ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)): em push pra `main`, faz build e roda `wrangler deploy` pelo `cloudflare/wrangler-action@v3`. Requer 2 secrets no repo: `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID`.

### Proteção da API

A API (`/api/*`) é destinada apenas ao próprio app. Camadas implementadas:

1. **Origin/Referer check** (Worker, no código): só aceita requests com `Origin` ou `Referer` em `ALLOWED_ORIGINS`. Configurado via var no `wrangler.toml`:
   - Prod: `https://kbrianps.com`, `https://www.kbrianps.com`
   - Dev (env `dev`): adiciona `localhost:5173` e `127.0.0.1:5173`
   - `/health` é o único endpoint exposto sem checagem (pra monitoramento)
2. **CORS restritivo** (Worker): `Access-Control-Allow-Origin` só ecoa o origin da request quando ele está na lista permitida. Browsers bloqueiam outros sites de chamar nossa API.
3. **Rate limit** (Workers Rate Limiting binding): 30 req/min/IP. Cobre uso normal (1 usuário, 1-2 abas, ~4-8 req/min) com folga de 3-7x. Mata abuso/scrapping.

Camadas adicionais (configuráveis no Cloudflare Dashboard, sem código):

4. **Bot Fight Mode** (gratuito): `Security → Bots → Bot Fight Mode = On`. Bloqueia bots conhecidos automaticamente.
5. **WAF Rate Limit Rules** (gratuito até 10k req/mês): mais granular que o binding nativo, dá pra setar por path/método/etc.
6. **Turnstile** (gratuito, próximo passo): widget invisível que valida humano vs bot. Adiciona um token na request, validado no Worker. Implementação não está nesta versão.

Realismo: API consumida por JS no browser nunca é 100% privada — o JS é aberto, qualquer um pode replicar requests com headers spoofados. As camadas acima cobrem 95-99% dos casos comuns sem prejudicar o usuário legítimo.

### Roadmap

- [x] Mapa, polling SPPO, marcadores animados, máscara do município
- [x] Busca de endereço + reverse geocode no GPS
- [x] Autocomplete de linhas
- [x] Persistência de linha e local
- [x] Polilinha da rota oficial (GTFS)
- [x] Snap-to-polyline pra direção correta da seta (bearing do segmento da rota mais próximo do ônibus, fallback pra bearing entre polls quando off-route)
- [ ] **Fase 3**: cores ida/volta distintas, ETA estimado, highlight do trecho próximo do usuário
- [ ] Compressão polyline encoding (~80% menor que JSON puro)
- [ ] Lazy-loading de rotas via R2 (Worker bundle vira trivial)
- [ ] Integrar BRT (API separada)
- [ ] Build nativo via Capacitor (Android/iOS)

### Atribuição de dados

Este projeto consome dados públicos de:

- **Posição dos ônibus**: API SPPO da [Mobilidade Rio](https://dados.mobilidade.rio) (Prefeitura do Rio de Janeiro).
- **Rotas (GTFS)**: [TUMI Datahub](https://hub.tumidata.org/dataset/gtfs-rio-de-janeiro), com base no [GTFS publicado pela Prefeitura do Rio](https://www.data.rio/datasets/gtfs-do-rio-de-janeiro).
- **Limites do município**: [API de malhas do IBGE](https://servicodados.ibge.gov.br/api/docs/malhas).
- **Geocoding**: [Nominatim/OpenStreetMap](https://nominatim.org).
- **Tiles do mapa**: [CartoDB Basemaps](https://carto.com/basemaps) (OpenStreetMap).

### Licença

GPLv3 — ver [LICENSE](LICENSE). Resumindo: você pode usar, modificar e redistribuir, desde que mantenha o código aberto e a mesma licença.

---

## English

Mobile-first PWA that shows real-time positions of buses operating in the city of Rio de Janeiro, Brazil, using the official SPPO (Municipal Transportation Department) API. Pick a line, watch the buses move on the map, with the official GTFS route overlaid.

### Why

- **No room on your phone**: the app opens straight in the browser (~50 KB) and can be installed as a PWA later. No need to download a 50–100 MB native app from the Play Store.
- **You need it fast**: line autocomplete + PWA caching make the app load in seconds and feel instant on subsequent visits.
- **You're not tech-savvy**: lean UI — one address search on top, one line search at the bottom, the map in between. No menus, no login, no pop-ups.
- **You hate ads**: zero ads. Competing apps push ads in pop-ups, banners and even audio at the worst times (while waiting for the bus, on a flaky signal). Here the focus is the bus.
- **You need to know what's happening**: a "Next update in Xs" indicator with a pulsing "Updating…" badge while a fetch is in flight. No anxiety, no wondering whether the app froze.

### Stack

- **Frontend**: TypeScript + Vite + Leaflet (vanilla, no framework). Bundle ~50 KB gzip.
- **Proxy/API**: Cloudflare Worker (SPPO snapshot caching, geocoding, route data).
- **Tiles**: CartoDB Light All (OpenStreetMap).
- **Geocoding**: Nominatim/OSM (address search and reverse geocoding).
- **Routes**: Official GTFS feed for Rio (data.rio, via TUMI Datahub), simplified with Ramer-Douglas-Peucker.
- **City boundary**: GeoJSON from IBGE (Brazilian census bureau).
- **PWA**: vite-plugin-pwa (installable, offline tile cache).

### Features

- Interactive map focused on the Rio municipality (faded white mask over neighbouring areas).
- Adaptive polling (5–20s) based on the SPPO snapshot server timestamp — fetches just after the upstream API refreshes, never wasting requests.
- Animated bus markers (interpolates between poll positions).
- Blue pins (fresh) or grey (no update for 2+ minutes).
- Official route polyline (GTFS) overlaid on the map.
- Address/neighbourhood search with autocomplete (Nominatim).
- User geolocation with red pin; auto-fills the search box via reverse geocode.
- Persists last selected line and location (localStorage).
- Line autocomplete as you type.
- Visual states on the search button: magnifier (idle) → spinner (loading) → check (success).
- Installable PWA.

### Project layout

```
onibus-rj-ao-vivo/
├── package.json              # frontend (vite, leaflet, vite-plugin-pwa)
├── vite.config.ts            # PWA + proxy /api -> :8787
├── index.html
├── src/
│   ├── main.ts               # bootstrap, polling, geolocation, glue code
│   ├── map.ts                # Leaflet, markers, polyline, mask
│   ├── api.ts                # fetchBuses, fetchLines, fetchRoute
│   ├── geocode.ts            # searchPlaces, reverseGeocode
│   ├── ui.ts                 # search input, autocomplete, button states
│   ├── geo.ts                # navigator.geolocation wrappers
│   ├── storage.ts            # localStorage helpers
│   ├── types.ts              # Bus, bearingDeg
│   ├── styles.css
│   └── rio-boundary.json     # municipality polygon (IBGE, 3.8 KB)
└── worker/
    ├── wrangler.toml
    ├── src/index.ts          # endpoints /sppo /lines /route /geocode /reverse /health
    └── data/
        └── routes.json       # GTFS shapes per line (1.77 MB raw / 340 KB gzip)
```

### Worker endpoints

| Path | Method | Description |
|---|---|---|
| `/sppo?line=X` | GET | Current bus positions for line X (filtered from SPPO snapshot, dedup'd by vehicle) |
| `/sppo?bbox=minLat,minLng,maxLat,maxLng` | GET | Positions within a bounding box |
| `/lines` | GET | All distinct lines in the current snapshot |
| `/route?line=X` | GET | Official route polylines (GTFS) |
| `/geocode?q=X` | GET | Address/place search (Nominatim, Rio viewbox) |
| `/reverse?lat=Y&lng=X` | GET | Reverse geocoding (coords → address) |
| `/health` | GET | Health check |

Caching: SPPO snapshot 15s, geocoding 24h, routes 7d.

### Local development

Run two processes in parallel:

```bash
# terminal 1 — proxy
cd worker && npm install && npm run dev      # http://localhost:8787

# terminal 2 — frontend (proxies /api -> :8787)
npm install && npm run dev                    # http://localhost:5173
```

Worker smoke tests:

```bash
curl 'http://localhost:8787/health'
curl 'http://localhost:8787/sppo?line=104' | jq 'length'
curl 'http://localhost:8787/lines' | jq 'length'
curl 'http://localhost:8787/route?line=485' | jq '.shapes | length'
curl 'http://localhost:8787/geocode?q=Maracana' | jq '.[0]'
```

### Deploy (Cloudflare)

```bash
# Worker
cd worker && npx wrangler deploy

# Frontend
npm run build
npx wrangler pages deploy dist --project-name onibus-rj-ao-vivo
```

Before deploying to production, change `BASE` in `src/api.ts` to point to the production worker URL (`https://onibus-rj-ao-vivo-proxy.<account>.workers.dev`).

### Updating route data

GTFS rarely changes (the city publishes new versions occasionally). To refresh:

```bash
# 1. Download new zip
curl -L -o /tmp/gtfs-rio.zip "https://hub.tumidata.org/dataset/d0978152-4bbc-4162-810b-7478c9f2b0f7/resource/f1b70820-9c4a-4295-bc98-c9beb04ba457/download/rdj.zip"

# 2. Extract
cd /tmp && unzip -o gtfs-rio.zip routes.txt trips.txt shapes.txt

# 3. Run the Python script (extracts shapes + simplifies with RDP)
# See scripts/build-routes.py
# (generates worker/data/routes.json)

# 4. Upload to R2 + redeploy
cd worker
npx wrangler r2 object put onibus-rj-routes/routes.json --file=data/routes.json --content-type=application/json --remote
npx wrangler deploy
```

### Known limitations

- **The SPPO API only covers buses operated within the Rio municipality** (capital). Intercity buses (Niterói, S. Gonçalo, etc, run by DETRO/RJ), BRT (separate MobilidadeRio API), and vans are not included.
- **Brazilian OSM data lacks house numbers**: address search finds the street but not the exact number. Trailing numbers are stripped from the query before being sent to Nominatim.
- **Bus arrow direction is approximate**: computed by bearing between two consecutive polls. On curvy streets or with noisy GPS it may point oddly. A proper fix (snap-to-polyline using the GTFS route) is planned — see Roadmap.
- **`wrangler dev` (local mode) leaks file descriptors** during long sessions. Symptom: after hours of 15s polling, the worker stops responding. Dev workaround: `pkill -9 workerd && npx wrangler dev`. Does not happen on production Cloudflare Workers.

### Debug mode

Append `?debug=1` to the URL (or `localStorage.setItem('onibus-rj:debug', '1')`) to toggle the live metrics HUD. It shows, in real time:

- JS heap (used/limit/%) and FPS.
- Per-endpoint count + avg/last time (`/sppo`, `/lines`, `/route`, `/geocode`, `/reverse`, tiles).
- Last HTTP status and response size per endpoint, with an error counter.
- Tiles loaded + average load time.
- Snap-to-route: total calls + average in microseconds.
- Console error count + last 5 messages (truncated).
- Online/offline, session uptime, user-agent.

A `copy json` button exports a full snapshot you can paste into issues/PRs. The `×` button disables the HUD and clears the localStorage flag.

The HUD is **lazy-loaded** (dynamic import), so it adds nothing to the default bundle — only a ~150-byte stub ships in production. Use it to investigate slowdowns, payload-size regressions, or to file actionable bug reports.

### API protection

The API (`/api/*`) is meant for the app itself. Layers in place:

1. **Origin/Referer check** (Worker, code): rejects requests whose `Origin`/`Referer` is not in `ALLOWED_ORIGINS`. Configured via `wrangler.toml` var:
   - Prod: `https://kbrianps.com`, `https://www.kbrianps.com`
   - Dev env: adds `localhost:5173` / `127.0.0.1:5173`
   - `/health` is the only endpoint exposed without checks (for monitoring)
2. **Restrictive CORS** (Worker): `Access-Control-Allow-Origin` only echoes the request origin if it's in the allowed list. Browsers block other sites from calling the API.
3. **Rate limit** (Workers Rate Limiting binding): 30 req/min/IP. Covers normal use (1 user, 1-2 tabs, ~4-8 req/min) with 3-7x headroom. Kills scraping/abuse.

Additional layers (Cloudflare Dashboard, no code):

4. **Bot Fight Mode** (free): `Security → Bots → Bot Fight Mode = On`. Auto-blocks known bots.
5. **WAF Rate Limit Rules** (free up to 10k req/month): more granular than the native binding (per path/method/etc).
6. **Turnstile** (free, next step): invisible widget that validates human vs bot. Adds a token to each request, validated by the Worker. Not implemented yet.

Honest take: an API consumed by browser JS can never be 100% private — JS is open, anyone can replay requests with spoofed headers. The layers above cover 95-99% of common abuse without hurting real users.

### Roadmap

- [x] Map, SPPO polling, animated markers, municipality mask
- [x] Address search + GPS reverse geocode
- [x] Line autocomplete
- [x] Persisted line + location
- [x] Official route polyline (GTFS)
- [x] Snap-to-polyline for correct arrow direction (bearing from the closest route segment, falling back to inter-poll bearing when off-route)
- [ ] **Phase 3**: distinct colours for outbound/inbound, ETA estimation, highlight nearby route segment
- [ ] Polyline encoding compression (~80% smaller than raw JSON)
- [ ] Lazy-load routes via R2 (worker bundle becomes trivial)
- [ ] Integrate BRT (separate API)
- [ ] Native build via Capacitor (Android/iOS)

### Data attribution

This project consumes public data from:

- **Bus positions**: SPPO API by [Mobilidade Rio](https://dados.mobilidade.rio) (City of Rio de Janeiro).
- **Routes (GTFS)**: [TUMI Datahub](https://hub.tumidata.org/dataset/gtfs-rio-de-janeiro), based on the [GTFS feed published by the City of Rio](https://www.data.rio/datasets/gtfs-do-rio-de-janeiro).
- **City boundaries**: [IBGE Malhas API](https://servicodados.ibge.gov.br/api/docs/malhas).
- **Geocoding**: [Nominatim/OpenStreetMap](https://nominatim.org).
- **Map tiles**: [CartoDB Basemaps](https://carto.com/basemaps) (OpenStreetMap).

### License

GPLv3 — see [LICENSE](LICENSE). In short: you can use, modify, and redistribute, provided you keep the source open under the same license.
