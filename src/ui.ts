import type { Place } from './geocode';

export type SubmitState = 'idle' | 'loading' | 'success';

export interface LineChip {
  line: string;
  color: string;
  solo: boolean;
  /** Number of route shape directions available (typically 0, 1, or 2). */
  directions: number;
  /** Current direction filter: null = both, 0 or 1 = only that shape. */
  directionFilter: number | null;
  /** Per-shape destination labels (neighborhood). */
  directionLabels: (string | null)[];
}

export interface BusPopupData {
  vehicleId: string;
  line: string;
  color: string;
  ageS: number;
  speed: number;
  x: number;
  y: number;
  /** Display: "Indo para Guadalupe" or "Calculando rota…" or null. */
  directionLabel: string | null;
  /** Distance in meters from closest route shape; null if on-route. */
  offRouteDistM?: number | null;
}

export interface UIHandle {
  onSubmitLine: (cb: (line: string) => void) => void;
  onLineInput: (cb: (q: string) => void) => void;
  onPickLine: (cb: (line: string) => void) => void;
  setLineSuggestions: (lines: { line: string; active: boolean }[]) => void;
  setSubmitState: (state: SubmitState) => void;
  onSearchInput: (cb: (q: string) => void) => void;
  onPickPlace: (cb: (place: Place) => void) => void;
  setSearchResults: (results: Place[]) => void;
  setSearchState: (state: SubmitState) => void;
  setSearchValue: (value: string) => void;
  setLineValue: (line: string) => void;
  setPollSnapshotAt: (tsMs: number | null) => void;
  setPollLoading: (loading: boolean) => void;
  setBusesCount: (count: number) => void;
  setCalculatingRoutes: (calculating: boolean) => void;
  setLineChips: (chips: LineChip[]) => void;
  onChipSolo: (cb: (line: string) => void) => void;
  onChipRemove: (cb: (line: string) => void) => void;
  onChipDirection: (cb: (line: string, filter: number | null) => void) => void;
  showBusPopup: (data: BusPopupData) => void;
  hideBusPopup: () => void;
  toast: (msg: string, ms?: number) => void;
  showUpdateToast: (onUpdate: () => void) => void;
}

const SUBMIT_ICONS: Record<SubmitState, string> = {
  idle: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>`,
  loading: `<svg class="spin" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
  success: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>`,
};

export function initUI(): UIHandle {
  const form = document.getElementById('line-form') as HTMLFormElement;
  const input = document.getElementById('line-input') as HTMLInputElement;
  const submitBtn = form.querySelector('button[type="submit"]') as HTMLButtonElement;
  const lineSuggestions = document.getElementById('line-suggestions') as HTMLUListElement;
  const searchForm = document.getElementById('search-form') as HTMLFormElement;
  const searchInput = document.getElementById('search-input') as HTMLInputElement;
  const searchStatusBtn = document.getElementById('search-status') as HTMLButtonElement;
  const searchResults = document.getElementById('search-results') as HTMLUListElement;
  const pollStatus = document.getElementById('poll-status') as HTMLDivElement;
  const pollStatusText = document.getElementById('poll-status-text') as HTMLSpanElement;
  const lineChipsEl = document.getElementById('line-chips') as HTMLElement;
  const chipMenu = document.getElementById('chip-menu') as HTMLDivElement;
  const busPopup = document.getElementById('bus-popup') as HTMLDivElement;
  const toastEl = document.getElementById('toast') as HTMLDivElement;

  let pickPlaceCb: ((p: Place) => void) | null = null;
  let pickLineCb: ((line: string) => void) | null = null;
  let chipSoloCb: ((line: string) => void) | null = null;
  let chipRemoveCb: ((line: string) => void) | null = null;
  let chipDirectionCb: ((line: string, filter: number | null) => void) | null = null;
  let toastTimer: number | null = null;
  let chipMenuOpenForLine: string | null = null;
  let currentChipsMap = new Map<string, LineChip>();
  const POLL_LOADING_MIN_MS = 500;
  const FRESH_GLOW_MS = 1500;
  let pollSnapshotAt: number | null = null;
  let lastShownSnapshotAt: number | null = null;
  let freshGlowUntil = 0;
  let pollLoading = false;
  let pollLoadingStartedAt = 0;
  let pollLoadingClearTimer: number | null = null;
  let pollTickHandle: number | null = null;
  let busesCount = 0;
  let calculatingRoutes = false;

  function chipContent(line: string): string {
    const size = line.length <= 4 ? 'sm' : line.length <= 6 ? 'md' : 'lg';
    return `<span class="chip-row" data-size="${size}">${line}</span>`;
  }

  function ageLabel(ageMs: number): string {
    const seconds = Math.max(0, Math.round(ageMs / 1000));
    if (seconds < 60) return `Atualizado há ${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remSec = seconds % 60;
    if (minutes === 1 && remSec === 0) return 'Atualizado há 1 min';
    if (remSec === 0) return `Atualizado há ${minutes} min`;
    return `Atualizado há ${minutes} min ${remSec}s`;
  }

  function renderPollStatus() {
    pollStatus.hidden = false;
    if (pollSnapshotAt === null) {
      pollStatus.dataset.state = 'empty';
      pollStatusText.textContent = 'Selecione uma linha de ônibus';
      return;
    }
    if (calculatingRoutes) {
      pollStatus.dataset.state = 'calculating';
      pollStatusText.textContent = 'Calculando sentido…';
      return;
    }
    if (busesCount === 0) {
      pollStatus.dataset.state = 'no-buses';
      pollStatusText.textContent = 'Nenhum ônibus disponível';
      return;
    }
    const now = Date.now();
    if (now < freshGlowUntil) {
      pollStatus.dataset.state = pollLoading ? 'loading' : 'fresh';
      pollStatusText.textContent = 'Atualizado agora';
      return;
    }
    pollStatus.dataset.state = pollLoading ? 'loading' : 'idle';
    pollStatusText.textContent = ageLabel(now - pollSnapshotAt);
  }

  function ensurePollTick() {
    if (pollTickHandle !== null) return;
    pollTickHandle = window.setInterval(() => {
      if (pollSnapshotAt === null) return;
      renderPollStatus();
    }, 1000);
  }

  searchForm.addEventListener('submit', (e) => e.preventDefault());

  searchInput.addEventListener('focus', () => {
    if (searchResults.children.length) searchResults.hidden = false;
  });

  document.addEventListener('click', (e) => {
    if (!searchForm.contains(e.target as Node)) searchResults.hidden = true;
  });

  searchResults.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('li[data-idx]') as HTMLLIElement | null;
    if (!li || !pickPlaceCb) return;
    const data = JSON.parse(li.dataset.place!) as Place;
    pickPlaceCb(data);
    searchInput.value = data.label.split(',')[0];
    searchResults.hidden = true;
  });

  document.addEventListener('click', (e) => {
    if (!form.contains(e.target as Node) && !lineSuggestions.contains(e.target as Node)) {
      lineSuggestions.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }
  });

  lineSuggestions.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('li[data-line]') as HTMLLIElement | null;
    if (!li || !pickLineCb) return;
    const line = li.dataset.line!;
    input.value = '';
    lineSuggestions.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    pickLineCb(line);
  });

  lineChipsEl.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest('button[data-line]') as HTMLButtonElement | null;
    if (!chip) return;
    const line = chip.dataset.line!;
    if (chipMenuOpenForLine === line) {
      hideChipMenu();
    } else {
      openChipMenu(line, chip);
    }
  });

  chipMenu.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest('button[data-action]') as
      | HTMLButtonElement
      | null;
    if (!action) return;
    const line = action.dataset.line!;
    const kind = action.dataset.action!;
    hideChipMenu();
    if (kind === 'solo') chipSoloCb?.(line);
    else if (kind === 'remove') chipRemoveCb?.(line);
    else if (kind === 'direction') {
      const raw = action.dataset.dir;
      const filter = raw === 'both' ? null : Number(raw);
      chipDirectionCb?.(line, filter);
    }
  });

  function openChipMenu(line: string, anchor: HTMLElement) {
    const chip = currentChipsMap.get(line);
    if (!chip) return;
    const isSolo = chip.solo;
    const showSolo = currentChipsMap.size > 1;
    const soloButton = showSolo
      ? `<button type="button" role="menuitem" data-action="solo" data-line="${line}">${
          isSolo ? 'Mostrar todas as linhas' : 'Ver só esta linha'
        }</button>`
      : '';
    let directionButtons = '';
    if (chip.directions === 2) {
      const labelFor = (idx: number) => {
        const dest = chip.directionLabels?.[idx];
        return dest ? `Indo para ${dest}` : `Sentido ${idx + 1}`;
      };
      const opt = (raw: string, label: string, active: boolean) =>
        `<button type="button" role="menuitem" data-action="direction" data-line="${line}" data-dir="${raw}"${active ? ' data-active="true"' : ''}>${active ? '✓ ' : ''}${label}</button>`;
      directionButtons =
        opt('0', labelFor(0), chip.directionFilter === 0) +
        opt('1', labelFor(1), chip.directionFilter === 1) +
        opt('both', 'Mostrar ambos sentidos', chip.directionFilter === null);
    }
    chipMenu.innerHTML = `
      ${soloButton}
      ${directionButtons}
      <button type="button" role="menuitem" data-action="remove" data-line="${line}" data-danger="true">
        Remover linha
      </button>
    `;
    chipMenu.style.setProperty('--menu-color', chip.color);
    chipMenu.hidden = false;
    chipMenuOpenForLine = line;
    requestAnimationFrame(() => {
      const rect = anchor.getBoundingClientRect();
      const w = chipMenu.offsetWidth;
      const h = chipMenu.offsetHeight;
      const left = Math.min(window.innerWidth - w - 8, rect.right + 10);
      const top = Math.max(8, Math.min(window.innerHeight - h - 8, rect.top - 4));
      chipMenu.style.left = `${left}px`;
      chipMenu.style.top = `${top}px`;
    });
  }

  function hideChipMenu() {
    chipMenu.hidden = true;
    chipMenuOpenForLine = null;
  }

  document.addEventListener('pointerdown', (e) => {
    const target = e.target as HTMLElement;
    if (!busPopup.hidden && !target.closest('#bus-popup')) {
      busPopup.hidden = true;
    }
    if (
      chipMenuOpenForLine &&
      !target.closest('#chip-menu') &&
      !target.closest('#line-chips')
    ) {
      hideChipMenu();
    }
  });

  return {
    onSubmitLine(cb) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = input.value.trim().toUpperCase();
        if (v) {
          input.blur();
          lineSuggestions.hidden = true;
          input.setAttribute('aria-expanded', 'false');
          cb(v);
        }
      });
    },
    onLineInput(cb) {
      let timer: number | null = null;
      input.addEventListener('input', () => {
        const v = input.value.trim();
        if (timer) clearTimeout(timer);
        timer = window.setTimeout(() => cb(v), 100);
      });
      input.addEventListener('focus', () => cb(input.value.trim()));
    },
    onPickLine(cb) {
      pickLineCb = cb;
    },
    setSubmitState(state) {
      submitBtn.innerHTML = SUBMIT_ICONS[state];
      submitBtn.dataset.state = state;
    },
    setLineSuggestions(lines) {
      if (!lines.length) {
        lineSuggestions.hidden = true;
        lineSuggestions.innerHTML = '';
        input.setAttribute('aria-expanded', 'false');
        return;
      }
      lineSuggestions.innerHTML = lines
        .slice(0, 10)
        .map((l) => {
          const safe = l.line.replace(/"/g, '&quot;');
          const dim = !l.active ? ' data-inactive="true"' : '';
          const hint = !l.active
            ? '<span class="suggestion-hint">sem ônibus agora</span>'
            : '';
          return `<li data-line="${safe}" role="option"${dim}><span class="suggestion-line">${safe}</span>${hint}</li>`;
        })
        .join('');
      lineSuggestions.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    },
    onSearchInput(cb) {
      let timer: number | null = null;
      searchInput.addEventListener('input', () => {
        const v = searchInput.value.trim();
        if (timer) clearTimeout(timer);
        timer = window.setTimeout(() => cb(v), 300);
      });
    },
    onPickPlace(cb) {
      pickPlaceCb = cb;
    },
    setSearchResults(results) {
      if (!results.length) {
        searchResults.hidden = true;
        searchResults.innerHTML = '';
        return;
      }
      searchResults.innerHTML = results
        .map((r, i) => {
          const primary = r.primary ?? r.label.split(',')[0].trim();
          const area = r.area ?? '';
          const secondary = area && area !== primary ? `<span class="secondary">${area}</span>` : '';
          return `<li data-idx="${i}" data-place='${JSON.stringify(r).replace(/'/g, '&#39;')}' role="option"><span class="primary">${primary}</span>${secondary}</li>`;
        })
        .join('');
      searchResults.hidden = false;
    },
    setSearchState(state) {
      searchStatusBtn.innerHTML = SUBMIT_ICONS[state];
      searchStatusBtn.dataset.state = state;
    },
    setSearchValue(value) {
      searchInput.value = value;
    },
    setLineValue(line) {
      input.value = line;
    },
    setPollSnapshotAt(tsMs) {
      pollSnapshotAt = tsMs;
      if (tsMs !== null && tsMs !== lastShownSnapshotAt) {
        lastShownSnapshotAt = tsMs;
        freshGlowUntil = Date.now() + FRESH_GLOW_MS;
      }
      ensurePollTick();
      renderPollStatus();
    },
    setPollLoading(loading) {
      ensurePollTick();
      if (loading) {
        if (pollLoadingClearTimer !== null) {
          clearTimeout(pollLoadingClearTimer);
          pollLoadingClearTimer = null;
        }
        pollLoading = true;
        pollLoadingStartedAt = Date.now();
        renderPollStatus();
        return;
      }
      const elapsed = Date.now() - pollLoadingStartedAt;
      const wait = Math.max(0, POLL_LOADING_MIN_MS - elapsed);
      if (wait === 0) {
        pollLoading = false;
        renderPollStatus();
        return;
      }
      if (pollLoadingClearTimer !== null) clearTimeout(pollLoadingClearTimer);
      pollLoadingClearTimer = window.setTimeout(() => {
        pollLoading = false;
        pollLoadingClearTimer = null;
        renderPollStatus();
      }, wait);
    },
    setBusesCount(count) {
      busesCount = count;
      renderPollStatus();
    },
    setCalculatingRoutes(calculating) {
      calculatingRoutes = calculating;
      renderPollStatus();
    },
    setLineChips(chips) {
      currentChipsMap = new Map(chips.map((c) => [c.line, c]));
      if (chipMenuOpenForLine && !currentChipsMap.has(chipMenuOpenForLine)) {
        hideChipMenu();
      }
      if (chips.length === 0) {
        lineChipsEl.innerHTML = '';
        lineChipsEl.dataset.empty = 'true';
        return;
      }
      delete lineChipsEl.dataset.empty;
      const anySolo = chips.some((c) => c.solo);
      lineChipsEl.innerHTML = chips
        .map((c) => {
          const dim = anySolo && !c.solo ? ' data-dim="true"' : '';
          const solo = c.solo ? ' data-solo="true"' : '';
          const safe = c.line.replace(/"/g, '&quot;');
          return `<button type="button" data-line="${safe}" style="--line-color:${c.color}"${dim}${solo} aria-label="Linha ${safe}, toque para opções">${chipContent(c.line)}</button>`;
        })
        .join('');
    },
    onChipSolo(cb) {
      chipSoloCb = cb;
    },
    onChipRemove(cb) {
      chipRemoveCb = cb;
    },
    onChipDirection(cb) {
      chipDirectionCb = cb;
    },
    showBusPopup(data) {
      const ageLabel = data.ageS < 60 ? `${data.ageS}s` : `${Math.floor(data.ageS / 60)}min`;
      busPopup.style.setProperty('--popup-color', data.color);
      const directionRow = data.directionLabel
        ? `<div class="bus-popup-direction"${data.directionLabel.startsWith('Calculando') ? ' data-pending="true"' : ''}>${data.directionLabel}</div>`
        : '';
      const offRouteRow =
        data.offRouteDistM != null
          ? `<div class="bus-popup-offroute" title="Pode ter desviado, GPS impreciso ou estar parado fora do trajeto (garagem, ponto final, etc)"><span class="bus-popup-offroute-badge">?</span>Fora do trajeto</div>`
          : '';
      busPopup.innerHTML = `
        <div class="bus-popup-header">
          <span class="bus-popup-line">${data.line}</span>
          <span class="bus-popup-ord">${data.vehicleId}</span>
        </div>
        ${directionRow}
        ${offRouteRow}
        <div class="bus-popup-meta">${data.speed > 0 ? `${Math.round(data.speed)} km/h · ` : ''}há ${ageLabel}</div>
      `;
      busPopup.hidden = false;
      requestAnimationFrame(() => {
        const w = busPopup.offsetWidth;
        const h = busPopup.offsetHeight;
        const left = Math.max(8, Math.min(window.innerWidth - w - 8, data.x - w / 2));
        const top = Math.max(8, data.y - h - 14);
        busPopup.style.left = `${left}px`;
        busPopup.style.top = `${top}px`;
      });
    },
    hideBusPopup() {
      busPopup.hidden = true;
    },
    toast(msg, ms = 3000) {
      toastEl.textContent = msg;
      toastEl.hidden = false;
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => {
        toastEl.hidden = true;
        toastTimer = null;
      }, ms);
    },
    showUpdateToast(onUpdate) {
      let el = document.getElementById('update-toast') as HTMLDivElement | null;
      if (!el) {
        el = document.createElement('div');
        el.id = 'update-toast';
        document.body.appendChild(el);
      }
      el.innerHTML = `
        <span>Nova versão disponível</span>
        <button type="button" class="update-toast-btn">Atualizar</button>
      `;
      el.hidden = false;
      el.querySelector('.update-toast-btn')?.addEventListener('click', () => {
        onUpdate();
      });
    },
  };
}
