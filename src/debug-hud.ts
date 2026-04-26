import { debugState } from './debug';

function endpointKey(url: string): string {
  try {
    const u = new URL(url, location.origin);
    if (!u.pathname.startsWith('/tools/onibus-rj-ao-vivo/api/')) {
      if (u.host.includes('cartocdn')) return 'tile';
      return u.host + u.pathname.slice(0, 30);
    }
    return u.pathname.replace('/tools/onibus-rj-ao-vivo/api/', '/');
  } catch {
    return url;
  }
}

function trackFetch(url: string, ms: number, status: number, bytes: number): void {
  const k = endpointKey(url);
  const s = debugState.endpoints[k] ?? {
    count: 0,
    totalMs: 0,
    lastMs: 0,
    errors: 0,
    lastStatus: 0,
    lastBytes: 0,
  };
  s.count += 1;
  s.totalMs += ms;
  s.lastMs = Math.round(ms);
  s.lastStatus = status;
  s.lastBytes = bytes;
  if (status >= 400 || status === 0) s.errors += 1;
  debugState.endpoints[k] = s;
}

function logError(msg: string): void {
  debugState.errors.unshift({ ts: Date.now(), msg: msg.slice(0, 200) });
  if (debugState.errors.length > 10) debugState.errors.length = 10;
  debugState.consoleErrors += 1;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function fmtMem(): { used: string; limit: string; pct: number } {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  if (!m) return { used: 'n/a', limit: 'n/a', pct: 0 };
  return {
    used: fmtBytes(m.usedJSHeapSize),
    limit: fmtBytes(m.jsHeapSizeLimit),
    pct: Math.round((m.usedJSHeapSize / m.jsHeapSizeLimit) * 100),
  };
}

function snapshot(): unknown {
  const mem = fmtMem();
  const uptimeS = Math.round((performance.now() - debugState.startedAt) / 1000);
  const tiles = debugState.tilesLoaded
    ? { loaded: debugState.tilesLoaded, avgMs: Math.round(debugState.tileTotalMs / debugState.tilesLoaded) }
    : null;
  const snaps = debugState.snapsTotal
    ? { total: debugState.snapsTotal, avgMicros: Math.round((debugState.snapTotalMs / debugState.snapsTotal) * 1000) }
    : null;
  const endpoints: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(debugState.endpoints)) {
    endpoints[k] = {
      count: s.count,
      avgMs: Math.round(s.totalMs / s.count),
      lastMs: s.lastMs,
      lastStatus: s.lastStatus,
      lastBytes: fmtBytes(s.lastBytes),
      errors: s.errors,
    };
  }
  return {
    uptimeS,
    memory: mem,
    fps: debugState.fps,
    consoleErrors: debugState.consoleErrors,
    lastErrors: debugState.errors,
    endpoints,
    tiles,
    snaps,
    ua: navigator.userAgent,
    online: navigator.onLine,
  };
}

let panel: HTMLElement | null = null;

function renderPanel(): void {
  if (!panel) return;
  const s = snapshot() as ReturnType<typeof snapshot> & {
    memory: { used: string; limit: string; pct: number };
    endpoints: Record<string, { count: number; avgMs: number; lastMs: number; lastStatus: number; lastBytes: string; errors: number }>;
    lastErrors: { ts: number; msg: string }[];
    tiles: { loaded: number; avgMs: number } | null;
    snaps: { total: number; avgMicros: number } | null;
    fps: number;
    consoleErrors: number;
    uptimeS: number;
    online: boolean;
  };
  const mem = s.memory;
  const epRows = Object.entries(s.endpoints)
    .map(([k, v]) => {
      const errFlag = v.errors > 0 ? ` <span style="color:#ef4444">×${v.errors}</span>` : '';
      const status = v.lastStatus >= 400 || v.lastStatus === 0 ? `<span style="color:#ef4444">${v.lastStatus}</span>` : `<span style="color:#10b981">${v.lastStatus}</span>`;
      return `<tr><td>${k}</td><td style="text-align:right">${v.count}</td><td style="text-align:right">${v.avgMs}/${v.lastMs}ms</td><td style="text-align:right">${status} ${v.lastBytes}${errFlag}</td></tr>`;
    })
    .join('');
  const errList = s.lastErrors
    .slice(0, 5)
    .map((e) => `<div style="font-size:9px;color:#fca5a5;margin-top:2px">• ${e.msg}</div>`)
    .join('');
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <strong style="font-size:11px">DEBUG · ${s.uptimeS}s · ${s.online ? 'on' : 'off'}</strong>
      <div>
        <button id="dbg-copy" style="background:#1e293b;color:#cbd5e1;border:1px solid #475569;padding:2px 6px;font-size:9px;border-radius:3px;cursor:pointer;margin-right:4px">copy json</button>
        <button id="dbg-close" style="background:#1e293b;color:#cbd5e1;border:1px solid #475569;padding:2px 6px;font-size:9px;border-radius:3px;cursor:pointer">×</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:6px;font-size:10px">
      <div>JS heap: <strong>${mem.used}</strong>/${mem.limit} <span style="color:${mem.pct > 80 ? '#ef4444' : mem.pct > 50 ? '#f59e0b' : '#10b981'}">${mem.pct}%</span></div>
      <div>FPS: <strong>${s.fps}</strong></div>
      <div>Console errors: <strong style="color:${s.consoleErrors ? '#ef4444' : '#10b981'}">${s.consoleErrors}</strong></div>
      <div>${s.tiles ? `Tiles: ${s.tiles.loaded} (${s.tiles.avgMs}ms)` : 'Tiles: —'}</div>
      <div style="grid-column:1/3">${s.snaps ? `Snap-to-route: ${s.snaps.total} (${s.snaps.avgMicros}µs avg)` : 'Snap: —'}</div>
    </div>
    <table style="width:100%;font-size:10px;border-collapse:collapse">
      <thead><tr style="color:#94a3b8;border-bottom:1px solid #334155"><th style="text-align:left">endpoint</th><th style="text-align:right">×</th><th style="text-align:right">avg/last</th><th style="text-align:right">status/size</th></tr></thead>
      <tbody>${epRows || '<tr><td colspan="4" style="color:#64748b">no requests yet</td></tr>'}</tbody>
    </table>
    ${errList ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #334155">${errList}</div>` : ''}
  `;
  panel.querySelector('#dbg-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot(), null, 2));
      const btn = panel?.querySelector('#dbg-copy') as HTMLButtonElement | null;
      if (btn) {
        btn.textContent = 'copied!';
        setTimeout(() => { if (btn) btn.textContent = 'copy json'; }, 1500);
      }
    } catch {}
  });
  panel.querySelector('#dbg-close')?.addEventListener('click', () => {
    try {
      localStorage.removeItem('onibus-rj:debug');
    } catch {}
    panel?.remove();
    panel = null;
  });
}

export function initDebugHud(): void {
  debugState.enabled = true;
  try { localStorage.setItem('onibus-rj:debug', '1'); } catch {}

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const t0 = performance.now();
    try {
      const res = await origFetch(input, init);
      const ms = performance.now() - t0;
      let bytes = 0;
      const cl = res.headers.get('content-length');
      if (cl) bytes = parseInt(cl, 10) || 0;
      trackFetch(url, ms, res.status, bytes);
      return res;
    } catch (err) {
      const ms = performance.now() - t0;
      trackFetch(url, ms, 0, 0);
      throw err;
    }
  };

  const origErr = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    logError(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    origErr(...args);
  };
  window.addEventListener('error', (e) => logError(`${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => logError(`unhandled: ${e.reason}`));

  let frames = 0;
  let lastFpsT = performance.now();
  function frame() {
    frames++;
    const now = performance.now();
    if (now - lastFpsT >= 1000) {
      debugState.fps = Math.round((frames * 1000) / (now - lastFpsT));
      frames = 0;
      lastFpsT = now;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  panel = document.createElement('div');
  panel.id = 'debug-panel';
  panel.style.cssText = `
    position: fixed; top: 56px; right: 8px; z-index: 9999;
    width: 360px; max-width: calc(100vw - 16px); max-height: 60vh; overflow-y: auto;
    background: rgba(15, 23, 42, 0.92); color: #e2e8f0;
    border: 1px solid #334155; border-radius: 8px;
    padding: 8px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px; line-height: 1.4; backdrop-filter: blur(6px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  `;
  document.body.appendChild(panel);
  renderPanel();
  setInterval(renderPanel, 1000);
}
