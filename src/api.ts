import type { Bus, Bounds } from './types';
import { bboxParam } from './geo';

const BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

export interface FetchOpts {
  line?: string;
  bbox?: Bounds;
  signal?: AbortSignal;
}

export async function fetchBuses(opts: FetchOpts): Promise<Bus[]> {
  const params = new URLSearchParams();
  if (opts.line) params.set('line', opts.line);
  if (opts.bbox) params.set('bbox', bboxParam(opts.bbox));
  if (!params.has('line') && !params.has('bbox')) {
    throw new Error('line or bbox required');
  }
  const res = await fetch(`${BASE}/sppo?${params}`, { signal: opts.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchLines(signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(`${BASE}/lines`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface RouteShapes {
  line: string;
  shapes: number[][][];
}

export async function fetchRoute(line: string, signal?: AbortSignal): Promise<RouteShapes | null> {
  const res = await fetch(`${BASE}/route?line=${encodeURIComponent(line)}`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
