import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadLastLine, saveLastLine, loadLastLocation, saveLastLocation } from './storage';

const memStorage: Record<string, string> = {};

beforeEach(() => {
  for (const k of Object.keys(memStorage)) delete memStorage[k];
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => memStorage[k] ?? null,
    setItem: (k: string, v: string) => {
      memStorage[k] = v;
    },
    removeItem: (k: string) => {
      delete memStorage[k];
    },
    clear: () => {
      for (const k of Object.keys(memStorage)) delete memStorage[k];
    },
    key: () => null,
    length: 0,
  });
});

describe('storage', () => {
  it('returns null when no line saved', () => {
    expect(loadLastLine()).toBeNull();
  });

  it('persists and reads last line', () => {
    saveLastLine('485');
    expect(loadLastLine()).toBe('485');
  });

  it('returns null when no location saved', () => {
    expect(loadLastLocation()).toBeNull();
  });

  it('persists and reads last location', () => {
    saveLastLocation({ lat: -22.9, lng: -43.2, label: 'Maracanã' });
    const loaded = loadLastLocation();
    expect(loaded?.lat).toBe(-22.9);
    expect(loaded?.lng).toBe(-43.2);
    expect(loaded?.label).toBe('Maracanã');
  });

  it('returns null on malformed location JSON', () => {
    memStorage['onibus-rj:lastLocation'] = 'not json';
    expect(loadLastLocation()).toBeNull();
  });
});
