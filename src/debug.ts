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

export function logDebugError(msg: string): void {
  debugState.errors.unshift({ ts: Date.now(), msg: msg.slice(0, 200) });
  if (debugState.errors.length > 10) debugState.errors.length = 10;
  debugState.consoleErrors += 1;
}

let earlyCaptureInstalled = false;
export function installEarlyDebugCapture(): void {
  if (earlyCaptureInstalled) return;
  earlyCaptureInstalled = true;
  debugState.enabled = true;
  try { localStorage.setItem('onibus-rj:debug', '1'); } catch {}

  const origErr = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    logDebugError(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    origErr(...args);
  };
  window.addEventListener('error', (e) => logDebugError(`${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    const msg = r instanceof Error ? r.message : typeof r === 'object' ? JSON.stringify(r) : String(r);
    logDebugError(`unhandled: ${msg}`);
  });
}
