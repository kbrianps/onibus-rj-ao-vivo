const LAST_LINE_KEY = 'onibus-rj:lastLine';
const LAST_LOCATION_KEY = 'onibus-rj:lastLocation';

export function loadLastLine(): string | null {
  try {
    return localStorage.getItem(LAST_LINE_KEY);
  } catch {
    return null;
  }
}

export function saveLastLine(line: string): void {
  try {
    localStorage.setItem(LAST_LINE_KEY, line);
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
