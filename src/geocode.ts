export interface Place {
  lat: number;
  lng: number;
  label: string;
  primary?: string;
  area?: string;
}

const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const cleaned = query.trim().replace(/[,\s]+\d+\s*$/, '').trim();
  if (cleaned.length < 2) return [];
  const res = await fetch(`${API_BASE}/geocode?q=${encodeURIComponent(cleaned)}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function reverseGeocode(lat: number, lng: number, signal?: AbortSignal): Promise<Place | null> {
  const res = await fetch(`${API_BASE}/reverse?lat=${lat}&lng=${lng}`, { signal });
  if (!res.ok) return null;
  return res.json();
}
