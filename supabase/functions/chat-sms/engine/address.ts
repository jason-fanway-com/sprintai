// address.ts — geocode + delivery-zone check. Fails closed: an address is
// deliverable only when Google returns a street-level, non-partial match inside
// the shop's radius. Ported from the legacy set_delivery_address path.
import type { Address } from "./form.ts";
import { normalize, isDigits } from "./normalize.ts";

export interface ShopGeo { lat: number | null; lng: number | null; radius_mi: number | null; /** the shop's own town and state ("Allentown", "PA"): "3300 hamilton blvd" with no town is looked up there first */ locality?: string | null; region?: string | null }
/** "5620 Cetronia Rd, Allentown, PA 18106, USA" -> { locality: "Allentown", region: "PA" }; nothing when the shape is not city, state zip */
export function localityOf(formatted: string | null | undefined): { locality: string | null; region: string | null } {
  const parts = (formatted ?? "").split(",").map((p) => p.trim());
  const region = parts.length >= 3 ? parts[2].split(" ").filter(Boolean)[0] ?? null : null;
  return { locality: parts.length >= 3 && parts[1] ? parts[1] : null, region: region && region.length === 2 ? region.toUpperCase() : null };
}

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

const DIRECTIONAL = new Set(["n", "s", "e", "w", "north", "south", "east", "west", "ne", "nw", "se", "sw"]);
/** "2222 w union st" read back as "2222 Union St": a directional the customer typed that the geocoder dropped may be a different street; say what we read. */
export function streetChanged(typed: string, formatted: string): boolean {
  const street = (s: string) => normalize(s.split(",")[0]).split(" "); // raw tokens: words() would read the "w" of "w union st" as "with"
  const tw = street(typed), fw = street(formatted);
  const typedDir = tw.some((w) => DIRECTIONAL.has(w)), readDir = fw.some((w) => DIRECTIONAL.has(w));
  const typedNo = tw.find(isDigits), readNo = fw.find(isDigits);
  return (typedDir && !readDir) || (!!typedNo && !!readNo && typedNo !== readNo);
}

export function googleGeocoder(apiKey: string, shop: ShopGeo, fetchImpl: typeof fetch = fetch): Geocoder {
  return async (text: string): Promise<Address> => {
    const base: Address = { text, formatted: null, validated: false, zone_ok: false };
    if (!apiKey || shop.lat == null || shop.lng == null || !shop.radius_mi || shop.radius_mi <= 0) return base;
    // biased to the shop's own area: "3300 hamilton blvd" with no city is the one near the shop, not one three states away
    const dLat = shop.radius_mi / 69, dLng = shop.radius_mi / (69 * Math.cos((shop.lat * Math.PI) / 180));
    const bounds = `${shop.lat - dLat},${shop.lng - dLng}|${shop.lat + dLat},${shop.lng + dLng}`;
    const urlFor = (components: string) => `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(text)}&bounds=${encodeURIComponent(bounds)}&region=us&components=${encodeURIComponent(components)}&key=${apiKey}`;
    const town = shop.locality ? `country:US|locality:${shop.locality}${shop.region ? `|administrative_area:${shop.region}` : ""}` : null;
    const fetchGeo = async (url: string): Promise<GeoResult | null> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 8000);
          const res = await fetchImpl(url, { signal: ctrl.signal });
          clearTimeout(timer);
          if (res.status >= 500) continue;
          return await res.json() as GeoResult;
        } catch { /* retry once */ }
      }
      return null;
    };
    const isStreet = (g: GeoResult | null) => !!g && g.status === "OK" && g.results.length > 0 && g.results[0].partial_match !== true && (g.results[0].geometry.location_type === "ROOFTOP" || g.results[0].geometry.location_type === "RANGE_INTERPOLATED");
    // the shop's own town first (a bare "3300 hamilton blvd" is the one down the street), the wider country second (a customer in the next town over)
    let geo = town ? await fetchGeo(urlFor(town)) : null;
    if (!isStreet(geo)) geo = await fetchGeo(urlFor("country:US"));
    if (!isStreet(geo)) return base;
    const top = geo!.results[0];
    const miles = haversineMiles(shop.lat, shop.lng, top.geometry.location.lat, top.geometry.location.lng);
    const formatted = top.formatted_address ?? text;
    return { text, formatted, validated: true, zone_ok: miles <= shop.radius_mi, ...(streetChanged(text, formatted) ? { read_as: true } : {}) };
  };
}
