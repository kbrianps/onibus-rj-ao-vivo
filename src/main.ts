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

const DIR_LOG = (() => {
  try {
    return (
      new URLSearchParams(location.search).get('logdir') === '1' ||
      localStorage.getItem('onibus-rj:logdir') === '1' ||
      isDebugEnabled()
    );
  } catch {
    return false;
  }
})();

const POLL_MIN_MS = 5_000;
const POLL_MAX_MS = 15_000;
const POLL_BUFFER_MS = 500;
const POLL_FALLBACK_INTERVAL_MS = 10_000;
const MIN_MOVE_M_FOR_BEARING = 5;
const SPLIT_PATH_RATIO = 3;
const SPLIT_PATH_MIN_DELTA_M = 25;
const STALE_MS = 5 * 60 * 1000;
const SNAP_MAX_DIST_M = 120;
const MAX_LINES = 5;
const SNAP_CACHE_MAX = 400;

const LINE_PALETTE = [
  'hsl(199, 89%, 48%)',
  'hsl(28, 89%, 48%)',
  'hsl(140, 70%, 38%)',
  'hsl(270, 70%, 55%)',
  'hsl(330, 80%, 50%)',
  'hsl(170, 75%, 38%)',
  'hsl(245, 75%, 55%)',
  'hsl(45, 85%, 47%)',
  'hsl(305, 70%, 48%)',
];

const map = initMap('map');
const ui = initUI();

let manualSubmitPending = false;

interface BusHistory {
  lat: number;
  lng: number;
  heading: number | null;
  /** Locked direction (committed only after 2 consecutive consistent polls). */
  shapeIdx: number | null;
  /** Most recent instant vote — if next vote matches, commit to shapeIdx. */
  lastVote: number | null;
}

interface LineState {
  color: string;
  routeShapes: number[][][] | null;
  lastBy: Map<string, BusHistory>;
  firstFetchPending: boolean;
  hasBuses: boolean;
  /** null = both shapes, number = filter to that shape index. */
  directionFilter: number | null;
  /** Human-readable destination labels per shape index ("Maracanã", etc). */
  directionLabels: (string | null)[];
  /** Successful poll cycles for this line. Direction commits land at >=2. */
  pollsCompleted: number;
}

const selectedLines = new Map<string, LineState>();
const knownBuses = new Map<string, ProcessedBus>();
let soloLine: string | null = null;
let userPos: { lat: number; lng: number } | null = null;
let manualPos: { lat: number; lng: number } | null = null;
let pollTimer: number | null = null;
let abortCtrl: AbortController | null = null;
let tickEpoch = 0;

const snapCache = new Map<string, SnapResult[]>();

function pickLineColor(): string {
  const used = new Set<string>();
  for (const state of selectedLines.values()) used.add(state.color);
  for (const c of LINE_PALETTE) if (!used.has(c)) return c;
  return LINE_PALETTE[selectedLines.size % LINE_PALETTE.length];
}

interface SnapResult {
  distM: number;
  bearing: number;
  shapeIdx: number;
}

function snapPerShape(
  lat: number,
  lng: number,
  line: string,
  shapes: number[][][],
): SnapResult[] {
  const key = `${line}|${lat.toFixed(5)}|${lng.toFixed(5)}`;
  const cached = snapCache.get(key);
  if (cached !== undefined) return cached;

  const t0 = performance.now();
  const results: SnapResult[] = [];
  for (let s = 0; s < shapes.length; s++) {
    const shape = shapes[s];
    let best: { distM: number; bearing: number } | null = null;
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
    if (best) results.push({ shapeIdx: s, distM: best.distM, bearing: best.bearing });
  }
  if (snapCache.size >= SNAP_CACHE_MAX) {
    const firstKey = snapCache.keys().next().value;
    if (firstKey !== undefined) snapCache.delete(firstKey);
  }
  snapCache.set(key, results);
  trackSnap(performance.now() - t0);
  return results;
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

interface ProcessedBus extends BusWithHeading {
  shapeIdx: number | null;
}

function processBuses(rawBuses: Bus[]): ProcessedBus[] {
  const now = Date.now();
  const out: ProcessedBus[] = [];
  for (const b of rawBuses) {
    const lineState = selectedLines.get(b.line);
    if (!lineState) continue;

    const prev = lineState.lastBy.get(b.vehicleId);
    let heading: number | null = prev?.heading ?? null;
    let shapeIdx: number | null = prev?.shapeIdx ?? null;
    let lastVote: number | null = prev?.lastVote ?? null;
    let currentVote: number | null = null;
    let motionBearing: number | null = null;
    if (prev) {
      const moved = metersBetween(prev, b);
      if (moved >= MIN_MOVE_M_FOR_BEARING) {
        motionBearing = bearingDeg(prev.lat, prev.lng, b.lat, b.lng);
      }
    }

    let splitPathLock = false;
    let branch: 'no-shapes' | 'no-snap' | 'split' | 'split-skip' | 'vote' | 'snap-only' =
      'no-shapes';
    let closestInfo: { idx: number; dist: number; bearing: number } | null = null;
    let secondInfo: { idx: number; dist: number } | null = null;
    let diff: number | null = null;
    let goingForward: boolean | null = null;
    if (lineState.routeShapes) {
      const snaps = snapPerShape(b.lat, b.lng, b.line, lineState.routeShapes);
      const sortedByDist = [...snaps].sort((a, b) => a.distM - b.distM);
      const closest = sortedByDist[0];
      if (closest) {
        closestInfo = {
          idx: closest.shapeIdx,
          dist: Math.round(closest.distM),
          bearing: Math.round(closest.bearing),
        };
      }
      if (closest && closest.distM <= SNAP_MAX_DIST_M) {
        const second = sortedByDist[1];
        if (second) secondInfo = { idx: second.shapeIdx, dist: Math.round(second.distM) };
        const isSplitPath =
          lineState.routeShapes.length === 2 &&
          second !== undefined &&
          second.distM > closest.distM * SPLIT_PATH_RATIO + SPLIT_PATH_MIN_DELTA_M;
        if (motionBearing !== null) {
          diff = ((motionBearing - closest.bearing + 540) % 360) - 180;
          goingForward = Math.abs(diff) <= 90;
        }
        const motionContradictsClosest = motionBearing !== null && goingForward === false;
        if (isSplitPath && !motionContradictsClosest) {
          branch = 'split';
          shapeIdx = closest.shapeIdx;
          lastVote = closest.shapeIdx;
          splitPathLock = true;
          if (motionBearing !== null) {
            heading = motionBearing;
          } else if (heading === null) {
            heading = closest.bearing;
          }
        } else if (isSplitPath && motionContradictsClosest) {
          branch = 'split-skip';
          heading = motionBearing;
          if (lineState.routeShapes.length === 2) {
            currentVote = 1 - closest.shapeIdx;
          }
        } else if (motionBearing !== null) {
          branch = 'vote';
          heading = motionBearing;
          if (lineState.routeShapes.length === 2) {
            currentVote = goingForward ? closest.shapeIdx : 1 - closest.shapeIdx;
          } else {
            currentVote = closest.shapeIdx;
          }
        } else if (heading === null) {
          branch = 'snap-only';
          heading = closest.bearing;
        } else {
          branch = 'snap-only';
        }
      } else {
        branch = 'no-snap';
        if (motionBearing !== null) heading = motionBearing;
      }
    } else if (motionBearing !== null) {
      heading = motionBearing;
    }

    if (!splitPathLock) {
      if (currentVote !== null && currentVote === lastVote) {
        shapeIdx = currentVote;
      }
      if (currentVote !== null) lastVote = currentVote;
    }

    if (DIR_LOG && lineState.routeShapes && lineState.routeShapes.length === 2) {
      const labels = lineState.directionLabels;
      const lab = (i: number | null): string => (i === null ? '-' : labels[i] ?? `idx${i}`);
      const moved = prev ? Math.round(metersBetween(prev, b)) : 0;
      const motionStr = motionBearing !== null ? `${Math.round(motionBearing)}°` : '-';
      const closestStr = closestInfo
        ? `idx${closestInfo.idx}(${lab(closestInfo.idx)}) d=${closestInfo.dist}m brg=${closestInfo.bearing}°`
        : '-';
      const secondStr = secondInfo
        ? `idx${secondInfo.idx}(${lab(secondInfo.idx)}) d=${secondInfo.dist}m`
        : '-';
      const headingStr = heading !== null ? `${Math.round(heading)}°` : '-';
      const diffStr = diff !== null ? `${Math.round(diff)}°` : '-';
      const fwd = goingForward === null ? '-' : goingForward ? 'fwd' : 'rev';
      console.log(
        `[dir] ${b.line}/${b.vehicleId} ${branch} | moved=${moved}m motion=${motionStr} | closest=${closestStr} | second=${secondStr} | diff=${diffStr} ${fwd} | vote=${currentVote ?? '-'} last=${lastVote ?? '-'} | committed=${shapeIdx ?? '-'}(${lab(shapeIdx)}) | heading=${headingStr}${splitPathLock ? ' LOCK' : ''}`,
      );
    }

    lineState.lastBy.set(b.vehicleId, {
      lat: b.lat,
      lng: b.lng,
      heading,
      shapeIdx,
      lastVote,
    });
    const stale = now - b.serverTimestamp > STALE_MS;
    const pending =
      lineState.directionFilter !== null &&
      lineState.routeShapes !== null &&
      lineState.routeShapes.length === 2 &&
      shapeIdx === null;
    out.push({ ...b, heading, stale, color: lineState.color, shapeIdx, pending });
  }
  return out;
}

function visibleBuses(buses: ProcessedBus[]): ProcessedBus[] {
  return buses.filter((b) => {
    if (soloLine && b.line !== soloLine) return false;
    const state = selectedLines.get(b.line);
    if (!state) return false;
    if (state.directionFilter !== null && b.shapeIdx !== null && b.shapeIdx !== state.directionFilter) {
      return false;
    }
    return true;
  });
}

function anyLineCalculating(): boolean {
  for (const [line, state] of selectedLines) {
    if (state.directionFilter === null) continue;
    if (!state.routeShapes || state.routeShapes.length !== 2) continue;
    if (state.pollsCompleted >= 3) continue;
    let hasCommitted = false;
    let hasAny = false;
    for (const bus of knownBuses.values()) {
      if (bus.line !== line) continue;
      hasAny = true;
      if (bus.shapeIdx !== null) {
        hasCommitted = true;
        break;
      }
    }
    if (hasAny && !hasCommitted) return true;
  }
  return false;
}

function buildRouteLayers(): RouteLayer[] {
  const inactive: RouteLayer[] = [];
  const active: RouteLayer[] = [];
  for (const [line, state] of selectedLines) {
    if (soloLine && line !== soloLine) continue;
    if (!state.routeShapes) continue;
    let shapesToShow = state.routeShapes;
    if (state.directionFilter !== null && state.routeShapes[state.directionFilter]) {
      shapesToShow = [state.routeShapes[state.directionFilter]];
    }
    const layer: RouteLayer = { shapes: shapesToShow, color: state.color };
    if (state.hasBuses) {
      active.push(layer);
    } else {
      inactive.push(layer);
    }
  }
  return [...inactive, ...active];
}

function renderChips() {
  const chips = Array.from(selectedLines.entries()).map(([line, state]) => ({
    line,
    color: state.color,
    solo: line === soloLine,
    directions: state.routeShapes ? state.routeShapes.length : 0,
    directionFilter: state.directionFilter,
    directionLabels: state.directionLabels,
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
    const countByLine = new Map<string, number>();
    for (const b of visible) countByLine.set(b.line, (countByLine.get(b.line) ?? 0) + 1);
    let routeLayersChanged = false;
    for (const [line, state] of selectedLines) {
      const has = (countByLine.get(line) ?? 0) > 0;
      if (state.hasBuses !== has) {
        state.hasBuses = has;
        routeLayersChanged = true;
      }
    }
    if (routeLayersChanged) map.setRoutes(buildRouteLayers());

    map.setBuses(visible);
    ui.setBusesCount(visible.length);
    ui.setCalculatingRoutes(anyLineCalculating());

    let forceQuickFollowup = false;
    let pendingFitTargets: BusWithHeading[] | null = null;
    for (const [line, state] of selectedLines) {
      state.pollsCompleted++;
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

    if (forceQuickFollowup && manualSubmitPending) {
      manualSubmitPending = false;
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
    if (!isAbort) ui.setSubmitState('idle');
    ui.setPollLoading(false);
    if (myEpoch === tickEpoch) {
      const isWarmup = err instanceof HttpError && err.status === 503;
      schedulePoll(isAbort || isWarmup ? POLL_MIN_MS : POLL_MAX_MS);
    }
  }
}

async function addLine(line: string, opts: { manual?: boolean } = {}): Promise<void> {
  if (selectedLines.has(line)) return;
  if (selectedLines.size >= MAX_LINES) {
    if (opts.manual) {
      ui.toast(`Limite de ${MAX_LINES} linhas. Remova uma antes de adicionar.`, 3500);
    }
    return;
  }
  const state: LineState = {
    color: pickLineColor(),
    routeShapes: null,
    lastBy: new Map(),
    firstFetchPending: true,
    hasBuses: false,
    directionFilter: null,
    directionLabels: [],
    pollsCompleted: 0,
  };
  selectedLines.set(line, state);
  saveLastLines(Array.from(selectedLines.keys()));
  renderChips();
  if (opts.manual) {
    manualSubmitPending = true;
    ui.setSubmitState('loading');
  }
  fetchRoute(line)
    .then((r) => {
      state.routeShapes = r ? r.shapes : null;
      map.setRoutes(buildRouteLayers());
      if (r && r.shapes.length === 2) {
        loadDirectionLabels(line, state, r.shapes);
      }
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
    ui.setBusesCount(0);
    ui.setCalculatingRoutes(false);
    ui.setPollSnapshotAt(null);
    return;
  }
  ui.setCalculatingRoutes(anyLineCalculating());
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

async function loadDirectionLabels(
  line: string,
  state: LineState,
  shapes: number[][][],
): Promise<void> {
  const labels: (string | null)[] = await Promise.all(
    shapes.map(async (shape) => {
      const last = shape[shape.length - 1];
      if (!last) return null;
      try {
        const place = await reverseGeocode(last[0], last[1]);
        if (!place) return null;
        return place.area || place.label.split(',')[0].trim() || null;
      } catch {
        return null;
      }
    }),
  );
  if (selectedLines.get(line) !== state) return;
  state.directionLabels = labels;
  renderChips();
}

function setDirectionFilter(line: string, filter: number | null): void {
  const state = selectedLines.get(line);
  if (!state) return;
  state.directionFilter = filter;
  renderChips();
  map.setRoutes(buildRouteLayers());
  const visible = visibleBuses(Array.from(knownBuses.values()));
  map.setBuses(visible);
  ui.setBusesCount(visible.length);
  ui.setCalculatingRoutes(anyLineCalculating());
  ui.hideBusPopup();
}

ui.onSubmitLine((line) => addLine(line, { manual: true }));
ui.onPickLine((line) => addLine(line, { manual: true }));
ui.onChipSolo(toggleSolo);
ui.onChipRemove(removeLine);
ui.onChipDirection((line, filter) => setDirectionFilter(line, filter));

map.onBusClick((vehicleId) => {
  const bus = knownBuses.get(vehicleId);
  if (!bus) return;
  const state = selectedLines.get(bus.line);
  const color = state?.color ?? '#0ea5e9';
  const ageS = Math.max(0, Math.round((Date.now() - bus.serverTimestamp) / 1000));
  const screen = map.latLngToContainer(bus.lat, bus.lng);
  let directionLabel: string | null = null;
  if (state && state.routeShapes && state.routeShapes.length === 2) {
    if (bus.shapeIdx === null) {
      directionLabel = 'Calculando rota…';
    } else {
      const dest = state.directionLabels[bus.shapeIdx];
      directionLabel = dest ? `Indo para ${dest}` : `Sentido ${bus.shapeIdx + 1}`;
    }
  }
  ui.showBusPopup({
    vehicleId: bus.vehicleId,
    line: bus.line,
    color,
    ageS,
    speed: bus.speed,
    x: screen.x,
    y: screen.y,
    directionLabel,
  });
});

type LineInfo = { line: string; active: boolean };
let allLines: LineInfo[] | null = null;
let linesLoading: Promise<LineInfo[]> | null = null;
async function getLines(): Promise<LineInfo[]> {
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
    const matches = lines.filter(
      (l) => l.line.startsWith(upper) && !selectedLines.has(l.line),
    );
    matches.sort((a, b) => Number(b.active) - Number(a.active));
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
