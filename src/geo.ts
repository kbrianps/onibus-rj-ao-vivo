import type { Bounds } from './types';

export function getCurrentPosition(timeoutMs = 8000): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation não suportada'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: timeoutMs,
      maximumAge: 30_000,
    });
  });
}

export function watchPosition(cb: (pos: GeolocationPosition) => void): number | null {
  if (!('geolocation' in navigator)) return null;
  return navigator.geolocation.watchPosition(cb, () => {}, {
    enableHighAccuracy: true,
    maximumAge: 15_000,
    timeout: 20_000,
  });
}

export function bboxParam(b: Bounds): string {
  return `${b.minLat.toFixed(5)},${b.minLng.toFixed(5)},${b.maxLat.toFixed(5)},${b.maxLng.toFixed(5)}`;
}
