import './styles.css';
import { initMap, type BusWithHeading } from './map';
import { initUI } from './ui';
import { fetchBuses, fetchLines, fetchRoute } from './api';
import { searchPlaces, reverseGeocode } from './geocode';
import { loadLastLine, saveLastLine, loadLastLocation, saveLastLocation } from './storage';
import { getCurrentPosition, watchPosition } from './geo';
import { bearingDeg, type Bus } from './types';

const POLL_MS = 15_000;
const MIN_MOVE_M_FOR_BEARING = 8;
const STALE_MS = 2 * 60 * 1000;
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

function snapToRoute(
  lat: number,
  lng: number,
  shapes: number[][][],
): { distM: number; bearing: number } | null {
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

    if (currentRoute) {
      const snap = snapToRoute(b.lat, b.lng, currentRoute);
      if (snap && snap.distM <= SNAP_MAX_DIST_M) {
        heading = snap.bearing;
      } else if (prev) {
        const moved = metersBetween(prev, b);
        if (moved >= MIN_MOVE_M_FOR_BEARING) {
          heading = bearingDeg(prev.lat, prev.lng, b.lat, b.lng);
        }
      }
    } else if (prev) {
      const moved = metersBetween(prev, b);
      if (moved >= MIN_MOVE_M_FOR_BEARING) {
        heading = bearingDeg(prev.lat, prev.lng, b.lat, b.lng);
      }
    }

    lastBy.set(b.vehicleId, { lat: b.lat, lng: b.lng, heading });
    const stale = now - b.serverTimestamp > STALE_MS;
    return { ...b, heading, stale };
  });
}

let submitStateTimer: number | null = null;

async function tick() {
  if (!currentLine) return;
  if (document.visibilityState !== 'visible') return;
  abortCtrl?.abort();
  abortCtrl = new AbortController();
  try {
    const raw = await fetchBuses({ line: currentLine, signal: abortCtrl.signal });
    const buses = withHeadings(raw);
    map.setBuses(buses);
    if (isFirstFetch) {
      isFirstFetch = false;
      map.fitToBuses(buses);
      ui.setSubmitState('success');
      if (submitStateTimer) clearTimeout(submitStateTimer);
      submitStateTimer = window.setTimeout(() => ui.setSubmitState('idle'), 2500);
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    if (isFirstFetch) {
      isFirstFetch = false;
      ui.setSubmitState('idle');
    }
    console.error(err);
  }
}

async function startPolling(line: string) {
  currentLine = line;
  isFirstFetch = true;
  lastBy.clear();
  currentRoute = null;
  ui.setLineValue(line);
  ui.setSubmitState('loading');
  if (submitStateTimer) {
    clearTimeout(submitStateTimer);
    submitStateTimer = null;
  }
  saveLastLine(line);
  map.setRoute(null);
  if (pollTimer) clearInterval(pollTimer);
  try {
    const r = await fetchRoute(line);
    currentRoute = r ? r.shapes : null;
    map.setRoute(currentRoute);
  } catch (err) {
    console.error('route', err);
  }
  tick();
  pollTimer = window.setInterval(tick, POLL_MS);
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
    ui.setSearchState('success');
    searchStateTimer = window.setTimeout(() => ui.setSearchState('idle'), 2500);
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    ui.setSearchState('idle');
    console.error(err);
  }
});

ui.onPickPlace((place) => {
  manualPos = { lat: place.lat, lng: place.lng };
  saveLastLocation({ lat: place.lat, lng: place.lng, label: place.label });
  map.setUser(place.lat, place.lng);
  map.map.flyTo([place.lat, place.lng], 15, { duration: 0.6 });
});

document.getElementById('recenter')?.addEventListener('click', async () => {
  try {
    const pos = await getCurrentPosition();
    userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    manualPos = null;
    map.setUser(userPos.lat, userPos.lng);
    map.recenter();
    reverseGeocode(userPos.lat, userPos.lng)
      .then((place) => {
        if (place) ui.setSearchValue(place.label);
      })
      .catch(() => {});
  } catch {
    map.recenter();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentLine) tick();
});

(async () => {
  const saved = loadLastLocation();
  if (saved) {
    manualPos = { lat: saved.lat, lng: saved.lng };
    if (saved.label) ui.setSearchValue(saved.label);
    map.setUser(saved.lat, saved.lng);
    map.recenter();
  } else {
    try {
      const pos = await getCurrentPosition();
      userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      map.setUser(userPos.lat, userPos.lng);
      map.recenter();
      reverseGeocode(userPos.lat, userPos.lng)
        .then((place) => {
          if (place && !manualPos) ui.setSearchValue(place.label);
        })
        .catch(() => {});
    } catch {}
  }

  watchPosition((p) => {
    userPos = { lat: p.coords.latitude, lng: p.coords.longitude };
    if (!manualPos) map.setUser(userPos.lat, userPos.lng);
  });

  const last = loadLastLine();
  if (last) startPolling(last);
  document.body.classList.add('ready');
})();
