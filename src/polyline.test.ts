import { describe, it, expect } from 'vitest';
import { decodePolyline, encodePolyline } from './polyline';

describe('polyline', () => {
  it('decodes the canonical Google example', () => {
    const decoded = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(decoded).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
  });

  it('encodes the canonical Google example', () => {
    const encoded = encodePolyline([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
    expect(encoded).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });

  it('round-trips Rio coordinates with ~1m precision', () => {
    const original: [number, number][] = [
      [-22.97557, -43.19203],
      [-22.97534, -43.19198],
      [-22.97501, -43.19185],
      [-22.96342, -43.18217],
      [-22.95001, -43.17042],
    ];
    const encoded = encodePolyline(original);
    const decoded = decodePolyline(encoded);
    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i][0]).toBeCloseTo(original[i][0], 5);
      expect(decoded[i][1]).toBeCloseTo(original[i][1], 5);
    }
  });

  it('handles a single point', () => {
    const encoded = encodePolyline([[-22.9, -43.2]]);
    const decoded = decodePolyline(encoded);
    expect(decoded.length).toBe(1);
    expect(decoded[0][0]).toBeCloseTo(-22.9, 5);
    expect(decoded[0][1]).toBeCloseTo(-43.2, 5);
  });

  it('compresses substantially vs JSON', () => {
    const points: [number, number][] = [];
    for (let i = 0; i < 100; i++) {
      points.push([-22.9 + i * 0.001, -43.2 + i * 0.001]);
    }
    const json = JSON.stringify(points);
    const encoded = encodePolyline(points);
    expect(encoded.length).toBeLessThan(json.length * 0.4);
  });
});
