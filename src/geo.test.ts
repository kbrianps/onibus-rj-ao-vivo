import { describe, it, expect } from 'vitest';
import { bboxParam } from './geo';

describe('bboxParam', () => {
  it('formats bounds with 5 decimal places', () => {
    expect(
      bboxParam({ minLat: -22.9, minLng: -43.2, maxLat: -22.8, maxLng: -43.1 }),
    ).toBe('-22.90000,-43.20000,-22.80000,-43.10000');
  });

  it('rounds to 5 decimals', () => {
    expect(
      bboxParam({
        minLat: -22.9123456,
        minLng: -43.2123456,
        maxLat: -22.8123456,
        maxLng: -43.1123456,
      }),
    ).toBe('-22.91235,-43.21235,-22.81235,-43.11235');
  });
});
