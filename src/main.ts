import './styles.css';
import { initMap, type BusWithHeading, type RouteLayer } from './map';
import { initUI } from './ui';
import { fetchBuses, fetchLines, fetchRoute, HttpError } from './api';
import { searchPlaces, reverseGeocode } from './geocode';
import {
  loadLastLines,
  saveLastLines,
  loadLastLocation,
  saveLastLocation,
} from './storage';
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
const MAX_LINES = 5;
const SNAP_CACHE_MAX = 400;

const map = initMap('map');
const ui = initUI();

interface LineState {
  color: string;
  routeShapes: number[][][] | null;
  lastBy: Map<string, { lat: number; lng: number; heading: number | null }>;
  firstFetchPending: boolean;
}

const selectedLines = new Map<string, LineState>();
const knownBuses = new Map<string, BusWithHeading>();
let soloLine: string | null = null;
let userPos: { lat: number; lng: number } | null = null;
let manualPos: { lat: number; lng: number } | null = null;
let pollTimer: number | null = null;
let abortCtrl: AbortController | null = null;
let tickEpoch = 0;

const snapCache = new Map<string, { distM: number; bearing: number } | null>();

function lineColor(line: string): string {
  let h = 0;
  for (let i = 0; i < line.length; i++) h = (h * 31 + line.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue}, 65%, 48%)`;
}

function snapToRoute(
  lat: number,
  lng: number,
  line: string,
  shapes: number[][][],
): { distM: number; bearing: number } | null {
  const key = `${line}|${lat.toFixed(5)}|${lng.toFixed(5)}`;
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

function processBuses(rawBuses: Bus[]): BusWithHeading[] {
  const now = Date.now();
  const out: BusWithHeading[] = [];
  for (const b of rawBuses) {
    const lineState = selectedLines.get(b.line);
    if (!lineState) continue;

    const prev = lineState.lastBy.get(b.vehicleId);
    let heading: number | null = prev?.heading ?? null;
    let motionBearing: number | null = null;
    if (prev) {
      const moved = metersBetween(prev, b);
      if (moved >= MIN_MOVE_M_FOR_BEARING) {
        motionBearing = bearingDeg(prev.lat, prev.lng, b.lat, b.lng);
      }
    }

    if (lineState.routeShapes) {
      const snap = snapToRoute(b.lat, b.lng, b.line, lineState.routeShapes);
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

    lineState.lastBy.set(b.vehicleId, { lat: b.lat, lng: b.lng, heading });
    const stale = now - b.serverTimestamp > STALE_MS;
    out.push({ ...b, heading, stale, color: lineState.color });
  }
  return out;
}

function visibleBuses(buses: BusWithHeading[]): BusWithHeading[] {
  if (!soloLine) return buses;
  return buses.filter((b) => b.line === soloLine);
}

function buildRouteLayers(): RouteLayer[] {
  const layers: RouteLayer[] = [];
  for (const [line, state] of selectedLines) {
    if (soloLine && line !== soloLine) continue;
    if (state.routeShapes) layers.push({ shapes: state.routeShapes, color: state.color });
  }
  return layers;
}

function renderChips() {
  const chips = Array.from(selectedLines.entries()).map(([line, state]) => ({
    line,
    color: state.color,
    solo: line === soloLine,
  }));
  ui.setLineChips(chips);
}

let submitStateTimer: number | null = null;

function nextPollDelay(refreshedAt: number | null, intervalMs: number | null): number {
  if (refreshedAt === null) return POLL_MAX_MS;
  const interval = intervalMs ?? POLL_FALLBACK_INTERVAL_MS;
  const nextRefreshAt = refreshedAt + interval;
  const delay = nextRefreshAt - Date.now() + POLL_BUFFER_MS;
  return Math.max(POLL_MIN_MS, Math.min(POLL_MAX_MS, delay));
}

function schedulePoll(ms: number) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = window.setTimeout(tick, ms);
  if (debugState.enabled) console.log(`[poll] scheduled in ${Math.round(ms / 100) / 10}s`);
}

async function tick() {
  if (selectedLines.size === 0) return;
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
  const lineParam = Array.from(selectedLines.keys()).join(',');
  try {
    const result = await fetchBuses({ line: lineParam, signal: abortCtrl.signal });
    const elapsed = Math.round(performance.now() - startedAt);
    const ageS = result.refreshedAt
      ? Math.round((Date.now() - result.refreshedAt) / 1000)
      : 'n/a';
    const processed = processBuses(result.buses).filter((b) => !b.stale);
    knownBuses.clear();
    for (const b of processed) knownBuses.set(b.vehicleId, b);

    const visible = visibleBuses(processed);
    if (debugState.enabled) {
      console.log(
        `[poll] tick=${myEpoch} ok in ${elapsed}ms · ${processed.length} bus(es) (${selectedLines.size} line(s)) · snapshot age ${ageS}s`,
      );
    }
    map.setBuses(visible);

    let forceQuickFollowup = false;
    let pendingFitTargets: BusWithHeading[] | null = null;
    for (const [line, state] of selectedLines) {
      if (state.firstFetchPending) {
        state.firstFetchPending = false;
        forceQuickFollowup = true;
        const linesBuses = visible.filter((b) => b.line === line);
        if (linesBuses.length > 0) {
          const anyBusInView = linesBuses.some((b) => map.isInView(b.lat, b.lng));
          if (!anyBusInView) pendingFitTargets = pendingFitTargets ?? linesBuses;
        }
      }
    }
    if (pendingFitTargets) map.fitToBuses(pendingFitTargets);

    ui.setSubmitState('success');
    if (submitStateTimer) clearTimeout(submitStateTimer);
    submitStateTimer = window.setTimeout(() => ui.setSubmitState('idle'), 2500);

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
    if (!isAbort) ui.setSubmitState('idle');
    ui.setPollLoading(false);
    if (myEpoch === tickEpoch) {
      const isWarmup = err instanceof HttpError && err.status === 503;
      schedulePoll(isAbort || isWarmup ? POLL_MIN_MS : POLL_MAX_MS);
    }
  }
}

async function addLine(line: string): Promise<void> {
  if (selectedLines.has(line)) return;
  if (selectedLines.size >= MAX_LINES) {
    ui.toast(`Limite de ${MAX_LINES} linhas. Remova uma antes de adicionar.`, 3500);
    return;
  }
  const state: LineState = {
    color: lineColor(line),
    routeShapes: null,
    lastBy: new Map(),
    firstFetchPending: true,
  };
  selectedLines.set(line, state);
  saveLastLines(Array.from(selectedLines.keys()));
  renderChips();
  ui.setSubmitState('loading');
  fetchRoute(line)
    .then((r) => {
      state.routeShapes = r ? r.shapes : null;
      map.setRoutes(buildRouteLayers());
    })
    .catch((err) => console.error('route', err));
  if (pollTimer) clearTimeout(pollTimer);
  tick();
}

function removeLine(line: string): void {
  if (!selectedLines.delete(line)) return;
  if (soloLine === line) soloLine = null;
  saveLastLines(Array.from(selectedLines.keys()));
  renderChips();
  map.setRoutes(buildRouteLayers());
  ui.hideBusPopup();
  if (selectedLines.size === 0) {
    if (pollTimer) clearTimeout(pollTimer);
    map.clearBuses();
    knownBuses.clear();
    ui.setPollSnapshotAt(null);
    return;
  }
  if (pollTimer) clearTimeout(pollTimer);
  tick();
}

function toggleSolo(line: string): void {
  if (!selectedLines.has(line)) return;
  soloLine = soloLine === line ? null : line;
  renderChips();
  map.setRoutes(buildRouteLayers());
  map.setBuses(visibleBuses(Array.from(knownBuses.values())));
  ui.hideBusPopup();
}

ui.onSubmitLine(addLine);
ui.onPickLine(addLine);
ui.onChipSolo(toggleSolo);
ui.onChipRemove(removeLine);

map.onBusClick((vehicleId) => {
  const bus = knownBuses.get(vehicleId);
  if (!bus) return;
  const state = selectedLines.get(bus.line);
  const color = state?.color ?? '#0ea5e9';
  const ageS = Math.max(0, Math.round((Date.now() - bus.serverTimestamp) / 1000));
  const screen = map.latLngToContainer(bus.lat, bus.lng);
  ui.showBusPopup({
    vehicleId: bus.vehicleId,
    line: bus.line,
    color,
    ageS,
    speed: bus.speed,
    x: screen.x,
    y: screen.y,
  });
});

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
    const matches = lines.filter((l) => l.startsWith(upper) && !selectedLines.has(l));
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
  if (document.visibilityState === 'visible' && selectedLines.size > 0) tick();
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
  }

  for (const line of loadLastLines().slice(0, MAX_LINES)) {
    void addLine(line);
  }
  ui.setPollSnapshotAt(null);
  renderChips();
  document.body.classList.add('ready');
})();
