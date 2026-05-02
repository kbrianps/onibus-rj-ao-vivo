import { initMap as initRioMap } from '@kbrianps/rio-map';
import type { Bus } from './types';

export interface BusWithHeading extends Bus {
  heading: number | null;
  stale: boolean;
  color?: string;
  pending?: boolean;
}

export interface RouteLayer {
  shapes: number[][][];
  color?: string;
}

export interface MapHandle {
  setUser: (lat: number, lng: number) => void;
  setBuses: (buses: BusWithHeading[]) => void;
  clearBuses: () => void;
  setRoutes: (routes: RouteLayer[] | null) => void;
  recenter: () => void;
  fitToBuses: (buses: { lat: number; lng: number }[]) => void;
  flyTo: (lat: number, lng: number, zoom?: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  isInView: (lat: number, lng: number, paddingPx?: number) => boolean;
  getCenter: () => { lat: number; lng: number; zoom: number };
  latLngToContainer: (lat: number, lng: number) => { x: number; y: number };
  onClick: (cb: (lat: number, lng: number) => void) => void;
  onBusClick: (cb: (vehicleId: string) => void) => void;
}

export function initMap(containerId: string): MapHandle {
  const inner = initRioMap({ container: containerId });

  return {
    setUser(lat, lng) {
      inner.setUser(lat, lng);
    },
    setBuses(buses) {
      inner.setBuses(
        buses.map((b) => ({
          id: b.vehicleId,
          lat: b.lat,
          lng: b.lng,
          heading: b.heading,
          stale: b.stale,
          color: b.color,
          pending: b.pending,
        })),
      );
    },
    clearBuses() {
      inner.clearBuses();
    },
    setRoutes(routes) {
      inner.setRoutes(routes);
    },
    recenter() {
      inner.recenter();
    },
    fitToBuses(buses) {
      inner.fitToBuses(buses.map((b) => ({ lat: b.lat, lng: b.lng })));
    },
    flyTo(lat, lng, zoom) {
      inner.flyTo(lat, lng, zoom);
    },
    zoomIn() {
      inner.zoomIn();
    },
    zoomOut() {
      inner.zoomOut();
    },
    isInView(lat, lng, paddingPx) {
      return inner.isInView(lat, lng, paddingPx);
    },
    getCenter() {
      return inner.getCenter();
    },
    latLngToContainer(lat, lng) {
      return inner.latLngToContainer(lat, lng);
    },
    onClick(cb) {
      inner.on('click', cb);
    },
    onBusClick(cb) {
      inner.on('busclick', (bus) => cb(bus.id));
    },
  };
}
