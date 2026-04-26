// Lightweight stubs always present in the bundle (~150 bytes when minified).
// The full HUD lives in debug-hud.ts and is dynamically imported only when ?debug=1.

export interface EndpointStats {
  count: number;
  totalMs: number;
  lastMs: number;
  errors: number;
  lastStatus: number;
  lastBytes: number;
}

export interface DebugState {
  endpoints: Record<string, EndpointStats>;
  errors: { ts: number; msg: string }[];
  consoleErrors: number;
  fps: number;
  tilesLoaded: number;
  tileTotalMs: number;
  snapsTotal: number;
  snapTotalMs: number;
  startedAt: number;
  enabled: boolean;
}

export const debugState: DebugState = {
  endpoints: {},
  errors: [],
  consoleErrors: 0,
  fps: 0,
  tilesLoaded: 0,
  tileTotalMs: 0,
  snapsTotal: 0,
  snapTotalMs: 0,
  startedAt: performance.now(),
  enabled: false,
};

export function isDebugEnabled(): boolean {
  if (new URLSearchParams(location.search).get('debug') === '1') return true;
  try {
    return localStorage.getItem('onibus-rj:debug') === '1';
  } catch {
    return false;
  }
}

export function trackTile(ms: number): void {
  if (!debugState.enabled) return;
  debugState.tilesLoaded += 1;
  debugState.tileTotalMs += ms;
}

export function trackSnap(ms: number): void {
  if (!debugState.enabled) return;
  debugState.snapsTotal += 1;
  debugState.snapTotalMs += ms;
}
