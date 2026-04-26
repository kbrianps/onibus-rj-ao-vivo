import type { Place } from './geocode';

export type SubmitState = 'idle' | 'loading' | 'success';

export interface UIHandle {
  onSubmitLine: (cb: (line: string) => void) => void;
  onLineInput: (cb: (q: string) => void) => void;
  onPickLine: (cb: (line: string) => void) => void;
  setLineSuggestions: (lines: string[]) => void;
  setSubmitState: (state: SubmitState) => void;
  onSearchInput: (cb: (q: string) => void) => void;
  onPickPlace: (cb: (place: Place) => void) => void;
  setSearchResults: (results: Place[]) => void;
  setSearchState: (state: SubmitState) => void;
  setSearchValue: (value: string) => void;
  setLineValue: (line: string) => void;
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

  let pickPlaceCb: ((p: Place) => void) | null = null;
  let pickLineCb: ((line: string) => void) | null = null;

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
    input.value = line;
    lineSuggestions.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    pickLineCb(line);
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
        .map((l) => `<li data-line="${l}" role="option">${l}</li>`)
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
  };
}
