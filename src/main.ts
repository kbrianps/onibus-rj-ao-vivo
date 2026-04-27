import './styles.css';
import { initMap, type BusWithHeading } from './map';
import { initUI } from './ui';
import { fetchBuses, fetchLines, fetchRoute, HttpError } from './api';
import { searchPlaces, reverseGeocode } from './geocode';
import { loadLastLine, saveLastLine, loadLastLocation, saveLastLocation } from './storage';
import { getCurrentPosition, watchPosition } from './geo';
import { bearingDeg, type Bus } from './types';
import { isDebugEnabled, trackSnap, installEarlyDebugCapture, debugState } from './debug';

if (isDebugEnabled()) {
  installEarlyDebugCapture();
  void import('./debug-hud').then((m) => m.initDebugHud());
}

const POLL_MIN_MS = 5_000;
const POLL_MAX_MS = 60_000;
const POLL_BUFFER_MS = 1_000;
const POLL_FALLBACK_INTERVAL_MS = 60_000;
const MIN_MOVE_M_FOR_BEARING = 8;
const STALE_MS = 5 * 60 * 1000;
const SNAP_MAX_DIST_M = 120;

const map = initMap('map');
const ui = initUI();

let userPos: { lat: number; lng: number } | null = null;
let manualPos: { lat: number; lng: number } | null = null;
let currentLine: string | null = null;
let currentRoute: number[][][] | null = null;
let pollTimer: number | null = null;
let abortCtrl: AbortController | null = null;
let isFirstFetch = false;

const lastBy = new Map<string, { lat: number; lng: number; heading: number | null }>();
const snapCache = new Map<string, { distM: number; bearing: number } | null>();
const SNAP_CACHE_MAX = 200;

function snapToRoute(
  lat: number,
  lng: number,
  shapes: number[][][],
): { distM: number; bearing: number } | null {
  const key = `${lat.toFixed(5)}|${lng.toFixed(5)}`;
  if (snapCache.has(key)) return snapCache.get(key) ?? null;

  const t0 = performance.now();
  let best: { distM: number; bearing: number } | null = null;
  for (const shape of shapes) {
    for (let i = 0; i < shape.length - 1; i++) {
      const [aLat, aLng] = shape[i];
      const [bLat, bLng] = shape[i + 1];
      const dx = bLng - aLng;
      const dy = bLat - aLat;
      const lenSq = dx * dx + dy * dy;
      let pLat = aLat;
      let pLng = aLng;
      if (lenSq > 0) {
        let t = ((lng - aLng) * dx + (lat - aLat) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        pLat = aLat + t * dy;
        pLng = aLng + t * dx;
      }
      const distM = metersBetween({ lat, lng }, { lat: pLat, lng: pLng });
      if (!best || distM < best.distM) {
        best = { distM, bearing: bearingDeg(aLat, aLng, bLat, bLng) };
      }
    }
  }
  if (snapCache.size >= SNAP_CACHE_MAX) {
    const firstKey = snapCache.keys().next().value;
    if (firstKey !== undefined) snapCache.delete(firstKey);
  }
  snapCache.set(key, best);
  trackSnap(performance.now() - t0);
  return best;
}

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371e3;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function withHeadings(buses: Bus[]): BusWithHeading[] {
  const now = Date.now();
  return buses.map((b) => {
    const prev = lastBy.get(b.vehicleId);
    let heading: number | null = prev?.heading ?? null;
    let motionBearing: number | null = null;
    if (prev) {
      const moved = metersBetween(prev, b);
      if (moved >= MIN_MOVE_M_FOR_BEARING) {
        motionBearing = bearingDeg(prev.lat, prev.lng, b.lat, b.lng);
      }
    }

    if (currentRoute) {
      const snap = snapToRoute(b.lat, b.lng, currentRoute);
      if (snap && snap.distM <= SNAP_MAX_DIST_M) {
        if (motionBearing !== null) {
          const diff = ((motionBearing - snap.bearing + 540) % 360) - 180;
          heading = Math.abs(diff) > 90 ? (snap.bearing + 180) % 360 : snap.bearing;
        } else if (heading === null) {
          heading = snap.bearing;
        }
      } else if (motionBearing !== null) {
        heading = motionBearing;
      }
    } else if (motionBearing !== null) {
      heading = motionBearing;
    }

    lastBy.set(b.vehicleId, { lat: b.lat, lng: b.lng, heading });
    const stale = now - b.serverTimestamp > STALE_MS;
    return { ...b, heading, stale };
  });
}

let submitStateTimer: number | null = null;

function nextPollDelay(refreshedAt: number | null, intervalMs: number | null): number {
  if (refreshedAt === null) return POLL_MAX_MS;
  const interval = intervalMs ?? POLL_FALLBACK_INTERVAL_MS;
  const nextRefreshAt = refreshedAt + interval;
  const delay = nextRefreshAt - Date.now() + POLL_BUFFER_MS;
  return Math.max(POLL_MIN_MS, Math.min(POLL_MAX_MS, delay));
}

let tickEpoch = 0;

function schedulePoll(ms: number) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = window.setTimeout(tick, ms);
  if (debugState.enabled) console.log(`[poll] scheduled in ${Math.round(ms / 100) / 10}s`);
}

async function tick() {
  if (!currentLine) return;
  const myEpoch = ++tickEpoch;
  if (document.visibilityState !== 'visible') {
    if (debugState.enabled) console.log('[poll] hidden tab, retry in 60s');
    schedulePoll(POLL_MAX_MS);
    return;
  }
  abortCtrl?.abort();
  abortCtrl = new AbortController();
  ui.setPollLoading(true);
  const startedAt = performance.now();
  try {
    const result = await fetchBuses({ line: currentLine, signal: abortCtrl.signal });
    const elapsed = Math.round(performance.now() - startedAt);
    const ageS = result.refreshedAt
      ? Math.round((Date.now() - result.refreshedAt) / 1000)
      : 'n/a';
    const buses = withHeadings(result.buses).filter((b) => !b.stale);
    if (debugState.enabled) {
      console.log(
        `[poll] tick=${myEpoch} ok in ${elapsed}ms · ${buses.length} bus(es) · snapshot age ${ageS}s`,
      );
    }
    map.setBuses(buses);
    let forceQuickFollowup = false;
    if (isFirstFetch) {
      isFirstFetch = false;
      forceQuickFollowup = true;
      const anyBusInView = buses.some((b) => map.isInView(b.lat, b.lng));
      if (!anyBusInView) map.fitToBuses(buses);
      ui.setSubmitState('success');
      if (submitStateTimer) clearTimeout(submitStateTimer);
      submitStateTimer = window.setTimeout(() => ui.setSubmitState('idle'), 2500);
    }
    ui.setPollLoading(false);
    if (result.refreshedAt) ui.setPollSnapshotAt(result.refreshedAt);
    if (myEpoch === tickEpoch) {
      if (forceQuickFollowup) schedulePoll(POLL_MIN_MS);
      else schedulePoll(nextPollDelay(result.refreshedAt, result.refreshIntervalMs));
    } else if (debugState.enabled) {
      console.log(`[poll] tick=${myEpoch} done but superseded; not scheduling`);
    }
  } catch (err) {
    const isAbort = (err as Error).name === 'AbortError';
    if (debugState.enabled) {
      const elapsed = Math.round(performance.now() - startedAt);
      console.log(
        `[poll] tick=${myEpoch} ${isAbort ? 'aborted' : 'error'} after ${elapsed}ms${isAbort ? '' : ` :: ${(err as Error).message}`}`,
      );
    }
    if (!isAbort) console.error(err);
    if (isFirstFetch && !isAbort) {
      isFirstFetch = false;
      ui.setSubmitState('idle');
    }
    ui.setPollLoading(false);
    if (myEpoch === tickEpoch) {
      const isWarmup = err instanceof HttpError && err.status === 503;
      schedulePoll(isAbort || isWarmup ? POLL_MIN_MS : POLL_MAX_MS);
    }
  }
}

async function startPolling(line: string) {
  if (line === currentLine) return;
  currentLine = line;
  isFirstFetch = true;
  lastBy.clear();
  snapCache.clear();
  currentRoute = null;
  ui.setLineValue(line);
  ui.setSubmitState('loading');
  if (submitStateTimer) {
    clearTimeout(submitStateTimer);
    submitStateTimer = null;
  }
  saveLastLine(line);
  map.setRoute(null);
  if (pollTimer) clearTimeout(pollTimer);
  try {
    const r = await fetchRoute(line);
    currentRoute = r ? r.shapes : null;
    map.setRoute(currentRoute);
  } catch (err) {
    console.error('route', err);
  }
  tick();
}

ui.onSubmitLine(startPolling);
ui.onPickLine(startPolling);

let allLines: string[] | null = null;
let linesLoading: Promise<string[]> | null = null;
async function getLines(): Promise<string[]> {
  if (allLines) return allLines;
  if (!linesLoading) {
    linesLoading = fetchLines()
      .then((ls) => {
        allLines = ls;
        return ls;
      })
      .catch((err) => {
        linesLoading = null;
        throw err;
      });
  }
  return linesLoading;
}

ui.onLineInput(async (q) => {
  if (q.length === 0) {
    ui.setLineSuggestions([]);
    return;
  }
  try {
    const lines = await getLines();
    const upper = q.toUpperCase();
    const matches = lines.filter((l) => l.startsWith(upper));
    ui.setLineSuggestions(matches);
  } catch (err) {
    console.error(err);
  }
});

let searchAbort: AbortController | null = null;
let searchStateTimer: number | null = null;
ui.onSearchInput(async (q) => {
  searchAbort?.abort();
  if (searchStateTimer) {
    clearTimeout(searchStateTimer);
    searchStateTimer = null;
  }
  if (q.length < 2) {
    ui.setSearchResults([]);
    ui.setSearchState('idle');
    return;
  }
  ui.setSearchState('loading');
  searchAbort = new AbortController();
  try {
    const results = await searchPlaces(q, searchAbort.signal);
    ui.setSearchResults(results);
    ui.setSearchState('idle');
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    ui.setSearchState('idle');
    console.error(err);
  }
});

ui.onPickPlace((place) => {
  manualPos = { lat: place.lat, lng: place.lng };
  const primary = place.primary ?? place.label.split(',')[0].trim();
  const area = place.area ?? '';
  const shortLabel = area && area !== primary ? `${primary}, ${area}` : primary;
  saveLastLocation({ lat: place.lat, lng: place.lng, label: shortLabel });
  ui.setSearchValue(shortLabel);
  ui.setSearchState('success');
  if (searchStateTimer) clearTimeout(searchStateTimer);
  searchStateTimer = window.setTimeout(() => ui.setSearchState('idle'), 2500);
  map.setUser(place.lat, place.lng);
  if (!map.isInView(place.lat, place.lng, -40)) {
    map.flyTo(place.lat, place.lng);
  }
});

document.getElementById('zoom-in')?.addEventListener('click', () => map.zoomIn());
document.getElementById('zoom-out')?.addEventListener('click', () => map.zoomOut());

let watchStarted = false;
document.getElementById('recenter')?.addEventListener('click', async () => {
  try {
    const pos = await getCurrentPosition();
    userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    manualPos = null;
    map.setUser(userPos.lat, userPos.lng);
    const inView = map.isInView(userPos.lat, userPos.lng, -40);
    const currentZoom = map.getCenter().zoom;
    if (!inView || currentZoom < 14) {
      map.flyTo(userPos.lat, userPos.lng, Math.max(currentZoom, 14));
    }
    if (!watchStarted) {
      watchStarted = true;
      watchPosition((p) => {
        userPos = { lat: p.coords.latitude, lng: p.coords.longitude };
        if (!manualPos) map.setUser(userPos.lat, userPos.lng);
      });
    }
    reverseGeocode(userPos.lat, userPos.lng)
      .then((place) => {
        if (place) ui.setSearchValue(place.label);
      })
      .catch(() => {});
  } catch {}
});

document.addEventListener('visibilitychange', () => {
  if (debugState.enabled) {
    console.log(`[poll] visibility -> ${document.visibilityState}`);
  }
  if (document.visibilityState === 'visible' && currentLine) tick();
});

(() => {
  const saved = loadLastLocation();
  if (saved) {
    manualPos = { lat: saved.lat, lng: saved.lng };
    if (saved.label) {
      const parts = saved.label.split(',').map((s) => s.trim()).filter(Boolean);
      const short = parts.length > 2 ? `${parts[0]}, ${parts[1]}` : saved.label;
      ui.setSearchValue(short);
    }
    map.setUser(saved.lat, saved.lng);
    map.recenter();
  }

  const last = loadLastLine();
  if (last) ui.setLineValue(last);
  ui.setPollSnapshotAt(null);
  document.body.classList.add('ready');
})();
