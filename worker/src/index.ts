import routesData from '../data/routes.json';

const ROUTES = routesData as Record<string, number[][][]>;

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
const SNAPSHOT_TTL_S = 15;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

async function loadSnapshot(ctx: ExecutionContext): Promise<Bus[]> {
  const cacheKey = new Request('https://onibus-rj-cache/snapshot', { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) {
    return hit.json<Bus[]>();
  }
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
  ctx.waitUntil(cache.put(cacheKey, stored.clone()));
  return buses;
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
}

const PATH_PREFIX = '/tools/onibus-rj-ao-vivo';
const API_PREFIX = '/api';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    const url = new URL(request.url);
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

    if (env.RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return jsonResponse({ error: 'rate limit exceeded' }, request, env, 429);
      }
    }

    if (pathname === '/route') {
      const line = url.searchParams.get('line')?.trim().toUpperCase();
      if (!line) return jsonResponse({ error: 'line required' }, request, env, 400);
      const shapes = ROUTES[line];
      if (!shapes) return jsonResponse({ error: 'route not found' }, request, env, 404);
      return new Response(JSON.stringify({ line, shapes }), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=604800',
          ...corsHeaders(request, env),
        },
      });
    }

    if (pathname === '/lines') {
      let snapshot: Bus[];
      try {
        snapshot = await loadSnapshot(ctx);
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
      const cacheKey = new Request(`https://onibus-rj-cache/geocode?q=${encodeURIComponent(q.toLowerCase())}`);
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
      const res = new Response(JSON.stringify(results), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          ...corsHeaders(request, env),
        },
      });
      ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
      return res;
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
      snapshot = await loadSnapshot(ctx);
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
  },
};
