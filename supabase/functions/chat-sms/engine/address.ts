// address.ts — geocode + delivery-zone check. Fails closed: an address is
// deliverable only when Google returns a street-level, non-partial match inside
// the shop's radius. Ported from the legacy set_delivery_address path.
import type { Address } from "./form.ts";

export interface ShopGeo { lat: number | null; lng: number | null; radius_mi: number | null }

export interface Geocoder { (text: string): Promise<Address> }

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

interface GeoResult {
  status: string;
  results: Array<{ formatted_address?: string; geometry: { location: { lat: number; lng: number }; location_type?: string }; partial_match?: boolean }>;
}

export function googleGeocoder(apiKey: string, shop: ShopGeo, fetchImpl: typeof fetch = fetch): Geocoder {
  return async (text: string): Promise<Address> => {
    const base: Address = { text, formatted: null, validated: false, zone_ok: false };
    if (!apiKey || shop.lat == null || shop.lng == null || !shop.radius_mi || shop.radius_mi <= 0) return base;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(text)}&key=${apiKey}`;
    let geo: GeoResult | null = null;
    for (let attempt = 0; attempt < 2 && !geo; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetchImpl(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (res.status >= 500) continue;
        geo = await res.json() as GeoResult;
      } catch { /* retry once */ }
    }
    if (!geo || geo.status !== "OK" || geo.results.length === 0) return base;
    const top = geo.results[0];
    const streetLevel = top.partial_match !== true && (top.geometry.location_type === "ROOFTOP" || top.geometry.location_type === "RANGE_INTERPOLATED");
    if (!streetLevel) return base;
    const miles = haversineMiles(shop.lat, shop.lng, top.geometry.location.lat, top.geometry.location.lng);
    return { text, formatted: top.formatted_address ?? text, validated: true, zone_ok: miles <= shop.radius_mi };
  };
}
