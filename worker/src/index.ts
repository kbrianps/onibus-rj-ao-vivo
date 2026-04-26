interface RawBus {
  ordem: string;
  latitude: string;
  longitude: string;
  datahora: string;
  velocidade: string;
  linha: string;
  datahoraenvio: string;
  datahoraservidor: string;
}

interface Bus {
  vehicleId: string;
  line: string;
  lat: number;
  lng: number;
  speed: number;
  timestamp: number;
  serverTimestamp: number;
}

const SOURCE = 'https://dados.mobilidade.rio/gps/sppo';
const SNAPSHOT_TTL_S = 80;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_CACHE_KEY = new Request('https://onibus-rj-cache/snapshot', { method: 'GET' });
const UA_RE = /(Mozilla|Chrome|Safari|Firefox|Edge|Opera|OPR|SamsungBrowser|UCBrowser|Vivaldi)/i;

function getAllowedOrigins(env: Env): Set<string> {
  return new Set(
    (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function isAllowedOrigin(request: Request, env: Env): boolean {
  const allowed = getAllowedOrigins(env);
  const origin = request.headers.get('Origin');
  if (origin && allowed.has(origin)) return true;
  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      const u = new URL(referer);
      if (allowed.has(`${u.protocol}//${u.host}`)) return true;
    } catch {}
  }
  return false;
}

function looksLikeBrowser(request: Request): boolean {
  const ua = request.headers.get('User-Agent') || '';
  return UA_RE.test(ua);
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const allowed = getAllowedOrigins(env);
  const origin = request.headers.get('Origin');
  const echo = origin && allowed.has(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': echo,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function parseBus(r: RawBus): Bus | null {
  const lat = parseFloat(r.latitude.replace(',', '.'));
  const lng = parseFloat(r.longitude.replace(',', '.'));
  const timestamp = Number(r.datahora);
  const serverTimestamp = Number(r.datahoraservidor);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) return null;
  if (!Number.isFinite(timestamp)) return null;
  if (Date.now() - timestamp > MAX_AGE_MS) return null;
  return {
    vehicleId: r.ordem,
    line: (r.linha ?? '').toUpperCase(),
    lat,
    lng,
    speed: Number(r.velocidade) || 0,
    timestamp,
    serverTimestamp,
  };
}

function parseBbox(s: string | null): [number, number, number, number] | null {
  if (!s) return null;
  const parts = s.split(',').map((x) => parseFloat(x));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLat, minLng, maxLat, maxLng] = parts;
  if (minLat >= maxLat || minLng >= maxLng) return null;
  return [minLat, minLng, maxLat, maxLng];
}

async function refreshSnapshot(): Promise<Bus[]> {
  const res = await fetch(SOURCE, {
    headers: { Accept: 'application/json', 'User-Agent': 'onibus-rj-ao-vivo-proxy/0.1' },
    cf: { cacheTtl: SNAPSHOT_TTL_S, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const raw = (await res.json()) as RawBus[];
  const latest = new Map<string, Bus>();
  for (const r of raw) {
    const b = parseBus(r);
    if (!b) continue;
    const prev = latest.get(b.vehicleId);
    if (!prev || b.timestamp > prev.timestamp) latest.set(b.vehicleId, b);
  }
  const buses = Array.from(latest.values());
  const stored = new Response(JSON.stringify(buses), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${SNAPSHOT_TTL_S}`,
    },
  });
  await caches.default.put(SNAPSHOT_CACHE_KEY, stored.clone());
  return buses;
}

async function loadSnapshot(): Promise<Bus[]> {
  const hit = await caches.default.match(SNAPSHOT_CACHE_KEY);
  if (hit) return hit.json<Bus[]>();
  return refreshSnapshot();
}

function jsonResponse(body: unknown, request: Request, env: Env, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${Math.min(SNAPSHOT_TTL_S, 10)}`,
      ...corsHeaders(request, env),
    },
  });
}

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  ALLOWED_ORIGINS?: string;
  RATE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  ROUTES: R2Bucket;
  TWA_PACKAGE_NAME?: string;
  TWA_FINGERPRINTS?: string;
}

function privacyPolicyResponse(): Response {
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Política de Privacidade — Ônibus RJ - Ao Vivo</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #0f172a; background: #f8fafc; line-height: 1.55; }
  main { max-width: 720px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { margin: 0 0 0.25rem; font-size: 1.7rem; line-height: 1.2; }
  .updated { color: #64748b; font-size: 0.85rem; margin-bottom: 2rem; }
  h2 { font-size: 1.15rem; margin-top: 2rem; margin-bottom: 0.5rem; color: #0f172a; }
  p, ul { margin: 0.5rem 0; }
  ul { padding-left: 1.25rem; }
  li { margin-bottom: 0.35rem; }
  a { color: #0ea5e9; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #e2e8f0; padding: 0.05rem 0.3rem; border-radius: 4px; font-size: 0.9em; }
  .nav { font-size: 0.9rem; margin-bottom: 1rem; }
</style>
</head>
<body>
<main>
  <p class="nav"><a href="/tools/onibus-rj-ao-vivo/">← Voltar ao app</a></p>

  <h1>Política de Privacidade</h1>
  <p class="updated">Última atualização: 26 de abril de 2026</p>

  <p>O <strong>Ônibus RJ - Ao Vivo</strong> é um app que mostra a posição em tempo real dos ônibus do município do Rio de Janeiro. Nosso princípio é simples: <strong>coletamos o mínimo possível</strong>. Esta página descreve exatamente o que acontece com seus dados.</p>

  <h2>Quem somos</h2>
  <p>App pessoal mantido por Brian Pravato. Código-fonte aberto em <a href="https://github.com/kbrianps/onibus-rj-ao-vivo">github.com/kbrianps/onibus-rj-ao-vivo</a> (licença GPLv3).</p>

  <h2>O que NÃO coletamos</h2>
  <ul>
    <li>Não temos cadastro, login ou conta de usuário.</li>
    <li>Não enviamos sua localização GPS para nossos servidores. O GPS é usado apenas no seu dispositivo, para mostrar onde você está no mapa.</li>
    <li>Não usamos cookies de rastreamento.</li>
    <li>Não usamos rede de anúncios.</li>
    <li>Não vendemos nem compartilhamos dados com terceiros para fins comerciais.</li>
  </ul>

  <h2>O que é coletado e por quê</h2>
  <ul>
    <li><strong>Endereço IP e User-Agent</strong>: registrados temporariamente pelo nosso provedor de infraestrutura (Cloudflare) para proteção contra abuso (rate limit, anti-bot). Esses logs ficam apenas no servidor por curto prazo.</li>
    <li><strong>Linha selecionada e último local de busca</strong>: salvos no <code>localStorage</code> do seu navegador, no seu próprio dispositivo. Não saem dele. Você pode limpar nas configurações do navegador.</li>
    <li><strong>Texto de busca (endereço/bairro)</strong>: enviado ao nosso servidor para responder a busca. Não é vinculado a você nem armazenado para análise.</li>
  </ul>

  <h2>Serviços externos que consultamos</h2>
  <p>Para entregar o app, fazemos chamadas a serviços públicos:</p>
  <ul>
    <li><strong>SPPO / Mobilidade Rio</strong> (Prefeitura do Rio): origem dos dados de posição dos ônibus.</li>
    <li><strong>OpenStreetMap / CartoDB</strong>: tiles do mapa.</li>
    <li><strong>Nominatim (OpenStreetMap)</strong>: busca de endereço e geocodificação reversa. Recebem o texto da busca ou as coordenadas que você está consultando.</li>
    <li><strong>IBGE</strong>: limites do município (carga única).</li>
    <li><strong>Cloudflare</strong>: hospedagem e CDN. Aplica políticas próprias de log e segurança.</li>
  </ul>

  <h2>Permissões do dispositivo</h2>
  <ul>
    <li><strong>Localização</strong> (opcional): se você permitir, o app usa o GPS para centralizar o mapa em você. Pode negar e usar a busca por endereço como alternativa. A coordenada nunca é enviada aos nossos servidores.</li>
  </ul>

  <h2>Crianças</h2>
  <p>O app é de uso geral. Não direcionamos a crianças menores de 13 anos e não coletamos conscientemente dados de menores.</p>

  <h2>Seus direitos (LGPD)</h2>
  <p>Como praticamente não armazenamos dados pessoais identificáveis, não há dados a corrigir, exportar ou apagar do nosso lado. Para limpar a linha e o local salvos no seu dispositivo, basta limpar o armazenamento local do navegador (Configurações → Privacidade → Dados de sites → kbrianps.com).</p>

  <h2>Alterações</h2>
  <p>Mudanças nesta política serão publicadas nesta mesma URL com a data atualizada no topo. Mudanças relevantes podem ser anunciadas no app.</p>

  <h2>Contato</h2>
  <p>Dúvidas, pedidos ou denúncias: <a href="mailto:kbrianps@gmail.com">kbrianps@gmail.com</a> ou via <a href="https://github.com/kbrianps/onibus-rj-ao-vivo/issues">GitHub Issues</a>.</p>
</main>
</body>
</html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

function assetLinksResponse(env: Env): Response {
  const fingerprints = (env.TWA_FINGERPRINTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const body = JSON.stringify([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: env.TWA_PACKAGE_NAME ?? 'com.kbrianps.onibusrjaovivo',
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ]);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

let routesCache: Record<string, string[]> | null = null;

async function getRoutes(env: Env): Promise<Record<string, string[]>> {
  if (routesCache) return routesCache;
  const obj = await env.ROUTES.get('routes.json');
  if (!obj) throw new Error('routes.json not found in R2');
  routesCache = (await obj.json()) as Record<string, string[]>;
  return routesCache;
}

const PATH_PREFIX = '/tools/onibus-rj-ao-vivo';
const API_PREFIX = '/api';

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    const url = new URL(request.url);

    if (url.pathname === '/.well-known/assetlinks.json') {
      return assetLinksResponse(env);
    }

    if (
      url.pathname === '/tools/onibus-rj-ao-vivo/privacidade' ||
      url.pathname === '/tools/onibus-rj-ao-vivo/privacidade/'
    ) {
      return privacyPolicyResponse();
    }

    let pathname = url.pathname;
    if (pathname.startsWith(PATH_PREFIX)) {
      pathname = pathname.slice(PATH_PREFIX.length) || '/';
    }
    if (pathname.startsWith(API_PREFIX)) {
      pathname = pathname.slice(API_PREFIX.length) || '/';
    } else if (env.ASSETS) {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = pathname;
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    if (pathname === '/' || pathname === '/health') {
      return jsonResponse({ ok: true, service: 'onibus-rj-ao-vivo-proxy' }, request, env);
    }

    if (!isAllowedOrigin(request, env)) {
      return jsonResponse({ error: 'forbidden' }, request, env, 403);
    }

    if (!looksLikeBrowser(request)) {
      return jsonResponse({ error: 'forbidden' }, request, env, 403);
    }

    if (env.RATE_LIMITER) {
      try {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) {
          return jsonResponse({ error: 'rate limit exceeded' }, request, env, 429);
        }
      } catch (err) {
        console.error('rate limiter failed', err);
      }
    }

    if (pathname === '/route') {
      const line = url.searchParams.get('line')?.trim().toUpperCase();
      if (!line) return jsonResponse({ error: 'line required' }, request, env, 400);
      const cacheKey = new Request(`https://onibus-rj-cache/route?line=${line}`);
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
      const routes = await getRoutes(env);
      const shapes = routes[line];
      if (!shapes) return jsonResponse({ error: 'route not found' }, request, env, 404);
      const res = new Response(JSON.stringify({ line, shapes }), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=604800',
          ...corsHeaders(request, env),
        },
      });
      ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
      return res;
    }

    if (pathname === '/lines') {
      let snapshot: Bus[];
      try {
        snapshot = await loadSnapshot();
      } catch (err) {
        return jsonResponse({ error: 'upstream unavailable', detail: String(err) }, request, env, 502);
      }
      const set = new Set<string>();
      for (const b of snapshot) if (b.line) set.add(b.line);
      const lines = Array.from(set).sort((a, b) => {
        const na = Number(a);
        const nb = Number(b);
        const aIsNum = Number.isFinite(na);
        const bIsNum = Number.isFinite(nb);
        if (aIsNum && bIsNum) return na - nb;
        if (aIsNum) return -1;
        if (bIsNum) return 1;
        return a.localeCompare(b);
      });
      return jsonResponse(lines, request, env);
    }

    if (pathname === '/reverse') {
      const lat = parseFloat(url.searchParams.get('lat') || '');
      const lng = parseFloat(url.searchParams.get('lng') || '');
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return jsonResponse({ error: 'lat/lng required' }, request, env, 400);
      }
      const cacheKey = new Request(
        `https://onibus-rj-cache/reverse?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}`,
      );
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
      const upstream = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=pt-BR&zoom=17`,
        {
          headers: {
            'User-Agent': 'onibus-rj-ao-vivo-proxy/0.1 (https://github.com/kbrianps)',
            Accept: 'application/json',
          },
        },
      );
      if (!upstream.ok) return jsonResponse({ error: 'reverse upstream error' }, request, env, 502);
      const raw = (await upstream.json()) as {
        lat: string;
        lon: string;
        display_name: string;
        address?: Record<string, string>;
      };
      const a = raw.address ?? {};
      const street = a.road || a.pedestrian || a.cycleway || a.footway || a.path || '';
      const number = a.house_number ? `, ${a.house_number}` : '';
      const area = a.suburb || a.neighbourhood || a.city_district || a.quarter || '';
      const short = street ? `${street}${number}${area ? ` — ${area}` : ''}` : area || raw.display_name.split(',').slice(0, 2).join(',').trim();
      const result = {
        lat: parseFloat(raw.lat),
        lng: parseFloat(raw.lon),
        label: short,
        full: raw.display_name,
      };
      const res = new Response(JSON.stringify(result), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          ...corsHeaders(request, env),
        },
      });
      ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
      return res;
    }

    if (pathname === '/geocode') {
      const q = url.searchParams.get('q')?.trim();
      if (!q || q.length < 2) return jsonResponse({ error: 'q required' }, request, env, 400);
      const cacheKey = new Request(`https://onibus-rj-cache/geocode/v2?q=${encodeURIComponent(q.toLowerCase())}`);
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
      const upstream = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Rio de Janeiro, Brasil')}&format=json&limit=8&accept-language=pt-BR&viewbox=-43.8,-22.7,-43.0,-23.1&bounded=1&addressdetails=1`,
        { headers: { 'User-Agent': 'onibus-rj-ao-vivo-proxy/0.1 (https://github.com/kbrianps)', Accept: 'application/json' } },
      );
      if (!upstream.ok) return jsonResponse({ error: 'geocode upstream error' }, request, env, 502);
      const raw = (await upstream.json()) as Array<{
        lat: string;
        lon: string;
        display_name: string;
        name?: string;
        address?: Record<string, string>;
      }>;
      const seen = new Set<string>();
      const results = raw
        .filter((r) => {
          const a = r.address ?? {};
          const city = a.city || a.town || a.municipality || '';
          return city === 'Rio de Janeiro';
        })
        .map((r) => {
          const a = r.address ?? {};
          const area = a.suburb || a.neighbourhood || a.city_district || a.quarter || a.town || '';
          const primary = r.name || r.display_name.split(',')[0].trim();
          return {
            lat: parseFloat(r.lat),
            lng: parseFloat(r.lon),
            label: r.display_name,
            primary,
            area,
          };
        })
        .filter((r) => {
          const key = `${r.primary.toLowerCase()}|${r.area.toLowerCase()}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      const body = JSON.stringify(results);
      const stored = new Response(body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
        },
      });
      ctx.waitUntil(caches.default.put(cacheKey, stored));
      return new Response(body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=300, s-maxage=300',
          ...corsHeaders(request, env),
        },
      });
    }

    if (pathname !== '/sppo') {
      return jsonResponse({ error: 'not found' }, request, env, 404);
    }

    const line = url.searchParams.get('line')?.trim().toUpperCase() || null;
    const bbox = parseBbox(url.searchParams.get('bbox'));

    if (!line && !bbox) {
      return jsonResponse({ error: 'line or bbox required' }, request, env, 400);
    }

    let snapshot: Bus[];
    try {
      snapshot = await loadSnapshot();
    } catch (err) {
      return jsonResponse({ error: 'upstream unavailable', detail: String(err) }, request, env, 502);
    }

    const result: Bus[] = [];
    for (const b of snapshot) {
      if (line && b.line !== line) continue;
      if (bbox) {
        const [minLat, minLng, maxLat, maxLng] = bbox;
        if (b.lat < minLat || b.lat > maxLat || b.lng < minLng || b.lng > maxLng) continue;
      }
      result.push(b);
    }

    return jsonResponse(result, request, env);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      console.error('worker error:', err instanceof Error ? `${err.message}\n${err.stack}` : err);
      return jsonResponse({ error: 'internal error' }, request, env, 500);
    }
  },
  async scheduled(_event: ScheduledEvent, _env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      refreshSnapshot().catch((err) => console.error('scheduled refresh failed', err)),
    );
  },
};
