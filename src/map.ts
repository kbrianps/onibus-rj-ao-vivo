import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Bus } from './types';
import rioBoundary from './rio-boundary.json';

const RIO: L.LatLngTuple = [-22.9083, -43.1964];
const RIO_BOUNDS = L.latLngBounds([-23.085, -43.81], [-22.74, -43.09]);

export interface BusWithHeading extends Bus {
  heading: number | null;
  stale: boolean;
}

export interface MapHandle {
  map: L.Map;
  setUser: (lat: number, lng: number) => void;
  setBuses: (buses: BusWithHeading[]) => void;
  clearBuses: () => void;
  setRoute: (shapes: number[][][] | null) => void;
  recenter: () => void;
  fitToBuses: (buses: BusWithHeading[]) => void;
  onClick: (cb: (lat: number, lng: number) => void) => void;
}

export function initMap(containerId: string): MapHandle {
  const map = L.map(containerId, {
    zoomControl: false,
    preferCanvas: true,
    attributionControl: false,
    minZoom: 11,
    maxBounds: RIO_BOUNDS,
    maxBoundsViscosity: 1.0,
  }).setView(RIO, 11);

  L.control.zoom({ position: 'bottomright', zoomInTitle: 'Aproximar', zoomOutTitle: 'Afastar' }).addTo(map);
  L.control.attribution({ prefix: false, position: 'bottomleft' }).addTo(map);

  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    {
      maxZoom: 19,
      subdomains: 'abcd',
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    },
  ).addTo(map);

  const worldRing: L.LatLngTuple[] = [
    [-90, -180],
    [-90, 180],
    [90, 180],
    [90, -180],
  ];
  const holes: L.LatLngTuple[][] = [];
  for (const polygon of (rioBoundary as { coordinates: number[][][][] }).coordinates) {
    for (const ring of polygon) {
      holes.push(ring.map(([lng, lat]) => [lat, lng] as L.LatLngTuple));
    }
  }
  L.polygon([worldRing, ...holes], {
    stroke: false,
    fillColor: '#f8fafc',
    fillOpacity: 0.85,
    interactive: false,
  }).addTo(map);
  L.polygon(holes, {
    color: '#0ea5e9',
    weight: 1.5,
    opacity: 0.5,
    fill: false,
    interactive: false,
  }).addTo(map);

  const userIcon = L.divIcon({
    className: 'user-marker',
    html: `<svg viewBox="0 0 24 32" width="28" height="37" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C6 0 1 4.5 1 10c0 6 11 22 11 22s11-16 11-22C23 4.5 18 0 12 0z" fill="#dc2626" stroke="white" stroke-width="1.5"/><circle cx="12" cy="10" r="4" fill="white"/></svg>`,
    iconSize: [28, 37],
    iconAnchor: [14, 37],
  });

  let userMarker: L.Marker | null = null;
  const routeLayer = L.layerGroup().addTo(map);
  const busLayer = L.layerGroup().addTo(map);
  const markers = new Map<string, L.Marker>();
  const animations = new Map<string, number>();
  const ANIM_DURATION = 1200;

  function animateMarkerTo(vehicleId: string, marker: L.Marker, to: L.LatLng) {
    const prev = animations.get(vehicleId);
    if (prev) cancelAnimationFrame(prev);
    const from = marker.getLatLng();
    if (Math.abs(from.lat - to.lat) < 1e-7 && Math.abs(from.lng - to.lng) < 1e-7) return;
    const start = performance.now();
    function step(now: number) {
      const t = Math.min(1, (now - start) / ANIM_DURATION);
      const eased = 1 - Math.pow(1 - t, 3);
      marker.setLatLng([
        from.lat + (to.lat - from.lat) * eased,
        from.lng + (to.lng - from.lng) * eased,
      ]);
      if (t < 1) {
        animations.set(vehicleId, requestAnimationFrame(step));
      } else {
        animations.delete(vehicleId);
      }
    }
    animations.set(vehicleId, requestAnimationFrame(step));
  }

  function busIcon(heading: number | null, stale: boolean): L.DivIcon {
    const color = stale ? '#94a3b8' : '#0ea5e9';
    if (heading === null) {
      return L.divIcon({
        className: 'bus-marker',
        html: `<svg viewBox="0 0 24 32" width="22" height="29" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C6 0 1 4.5 1 10c0 6 11 22 11 22s11-16 11-22C23 4.5 18 0 12 0z" fill="${color}" stroke="white" stroke-width="1.5"/><circle cx="12" cy="10" r="3.5" fill="white"/></svg>`,
        iconSize: [22, 29],
        iconAnchor: [11, 29],
      });
    }
    return L.divIcon({
      className: 'bus-marker',
      html: `<svg viewBox="0 0 24 32" width="24" height="32" style="transform:rotate(${heading}deg); transform-origin: 12px 22px;" xmlns="http://www.w3.org/2000/svg"><path d="M12 32C6 32 1 27.5 1 22c0-6 11-22 11-22s11 16 11 22c0 5.5-5 10-11 10z" fill="${color}" stroke="white" stroke-width="1.5"/><circle cx="12" cy="22" r="3.5" fill="white"/></svg>`,
      iconSize: [24, 32],
      iconAnchor: [12, 22],
    });
  }


  return {
    map,
    setUser(lat, lng) {
      const ll: L.LatLngTuple = [lat, lng];
      if (!userMarker) {
        userMarker = L.marker(ll, { icon: userIcon, interactive: false, keyboard: false, zIndexOffset: 500 }).addTo(map);
      } else {
        userMarker.setLatLng(ll);
      }
    },
    setBuses(buses) {
      const seen = new Set<string>();
      for (const b of buses) {
        seen.add(b.vehicleId);
        const target = L.latLng(b.lat, b.lng);
        const existing = markers.get(b.vehicleId);
        if (existing) {
          existing.setIcon(busIcon(b.heading, b.stale));
          animateMarkerTo(b.vehicleId, existing, target);
        } else {
          const m = L.marker(target, {
            icon: busIcon(b.heading, b.stale),
            interactive: false,
            keyboard: false,
          }).addTo(busLayer);
          markers.set(b.vehicleId, m);
        }
      }
      for (const [id, m] of markers) {
        if (!seen.has(id)) {
          const raf = animations.get(id);
          if (raf) cancelAnimationFrame(raf);
          animations.delete(id);
          busLayer.removeLayer(m);
          markers.delete(id);
        }
      }
    },
    clearBuses() {
      busLayer.clearLayers();
      markers.clear();
    },
    setRoute(shapes) {
      routeLayer.clearLayers();
      if (!shapes) return;
      for (const shape of shapes) {
        const latlngs = shape.map(([lat, lng]) => [lat, lng] as L.LatLngTuple);
        L.polyline(latlngs, {
          color: '#0ea5e9',
          weight: 4,
          opacity: 0.55,
          interactive: false,
        }).addTo(routeLayer);
      }
    },
    recenter() {
      if (userMarker) map.flyTo(userMarker.getLatLng(), 14, { duration: 0.6 });
      else map.flyTo(RIO, 11, { duration: 0.6 });
    },
    fitToBuses(buses) {
      if (!buses.length) return;
      const points: L.LatLngTuple[] = buses.map((b) => [b.lat, b.lng]);
      if (userMarker) points.push([userMarker.getLatLng().lat, userMarker.getLatLng().lng]);
      const raw = L.latLngBounds(points);
      const safe = L.latLngBounds(
        [
          Math.max(raw.getSouth(), RIO_BOUNDS.getSouth()),
          Math.max(raw.getWest(), RIO_BOUNDS.getWest()),
        ],
        [
          Math.min(raw.getNorth(), RIO_BOUNDS.getNorth()),
          Math.min(raw.getEast(), RIO_BOUNDS.getEast()),
        ],
      );
      map.fitBounds(safe.isValid() ? safe : RIO_BOUNDS, { padding: [60, 60], maxZoom: 15, animate: true });
    },
    onClick(cb) {
      map.on('click', (e) => cb(e.latlng.lat, e.latlng.lng));
    },
  };
}
