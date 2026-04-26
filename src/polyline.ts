export function decodePolyline(str: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const len = str.length;

  while (index < len) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

export function encodePolyline(points: [number, number][]): string {
  const out: string[] = [];
  let prevLat = 0;
  let prevLng = 0;
  for (const [lat, lng] of points) {
    const latI = Math.round(lat * 1e5);
    const lngI = Math.round(lng * 1e5);
    out.push(encodeSigned(latI - prevLat));
    out.push(encodeSigned(lngI - prevLng));
    prevLat = latI;
    prevLng = lngI;
  }
  return out.join('');
}

function encodeSigned(value: number): string {
  let v = value << 1;
  if (value < 0) v = ~v;
  let s = '';
  while (v >= 0x20) {
    s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>>= 5;
  }
  s += String.fromCharCode(v + 63);
  return s;
}
