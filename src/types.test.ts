import { describe, it, expect } from 'vitest';
import { bearingDeg } from './types';

describe('bearingDeg', () => {
  it('returns 0 for due north', () => {
    expect(bearingDeg(-22.9, -43.2, -22.8, -43.2)).toBeCloseTo(0, 0);
  });

  it('returns 90 for due east', () => {
    expect(bearingDeg(-22.9, -43.2, -22.9, -43.1)).toBeCloseTo(90, 0);
  });

  it('returns 180 for due south', () => {
    expect(bearingDeg(-22.8, -43.2, -22.9, -43.2)).toBeCloseTo(180, 0);
  });

  it('returns 270 for due west', () => {
    expect(bearingDeg(-22.9, -43.1, -22.9, -43.2)).toBeCloseTo(270, 0);
  });

  it('returns a value in [0, 360) for arbitrary points', () => {
    const b = bearingDeg(-22.9083, -43.1964, -22.85, -43.25);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
  });
});
