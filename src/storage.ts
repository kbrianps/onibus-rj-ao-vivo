const LAST_LINE_KEY = 'onibus-rj:lastLine';
const LAST_LINES_KEY = 'onibus-rj:lastLines';
const LAST_LOCATION_KEY = 'onibus-rj:lastLocation';

export function loadLastLines(): string[] {
  try {
    const raw = localStorage.getItem(LAST_LINES_KEY);
    if (raw) return (JSON.parse(raw) as string[]).filter((l) => typeof l === 'string');
    const single = localStorage.getItem(LAST_LINE_KEY);
    return single ? [single] : [];
  } catch {
    return [];
  }
}

export function saveLastLines(lines: string[]): void {
  try {
    localStorage.setItem(LAST_LINES_KEY, JSON.stringify(lines));
  } catch {}
}

export interface SavedLocation {
  lat: number;
  lng: number;
  label?: string;
}

export function loadLastLocation(): SavedLocation | null {
  try {
    const raw = localStorage.getItem(LAST_LOCATION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SavedLocation;
  } catch {
    return null;
  }
}

export function saveLastLocation(loc: SavedLocation): void {
  try {
    localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify(loc));
  } catch {}
}
