/**
 * google-places-lookup
 *
 * Phase 6: Find a shop on Google Maps via Places API (New) and merge
 * authoritative address, phone, rating, and review count into the shops row.
 *
 * Two modes, selected by `mode` in the request body:
 *   - (default / "auto") — original onboarding behavior: search by shop_id
 *     (a business-name Places search — legitimate, since there's no
 *     owner-typed address to resolve against), SKIP if google_place_id is
 *     already set, write the top match straight to `shops` with no
 *     confirmation step. Called by onboarding-save (fire-and-forget, async,
 *     non-blocking).
 *   - "set" — owner-facing address entry (admin-chat's SET_SHOP_ADDRESS,
 *     the Settings page's live address field). Takes shop_id + address and
 *     resolves it through the Geocoding API — an address resolver, not a
 *     place-relevance search, and never mixed with the shop's name (a name
 *     search can rank a same-named business above the address the owner
 *     actually typed). Writes ONLY formatted_address/latitude/longitude —
 *     this mode never touches google_place_id, google_rating,
 *     google_review_count, or business_status, which are the business's
 *     Google identity and unrelated to a street-address correction. If the
 *     resolved address doesn't closely and precisely match what the owner
 *     typed (Google's own `partial_match` flag, the leading house number
 *     disappearing entirely, or a location_type coarser than a rooftop/
 *     interpolated address point — e.g. a bare road centroid), nothing is
 *     written — the candidate is returned for the owner to explicitly
 *     accept via a second call with `confirm: true`. On no match at all,
 *     nothing is written — the caller must never keep a stale geocode while
 *     implying a new one was set.
 *
 * Auth: Edge function key (service_role via Supabase internal) or
 * INTERNAL_FUNCTION_SECRET. Never called directly from a browser — the
 * owner-facing path goes through admin-chat, which holds the internal
 * secret server-side and enforces shop ownership before calling here.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const API_KEY = Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "";
const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const PLACES_API_BASE = "https://places.googleapis.com/v1";
const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

interface PlaceResult {
  place_id: string;
  formattedAddress: string;
  phone: string;
  rating: number;
  userRatingCount: number;
  businessStatus: string;
  latitude: number | null;
  longitude: number | null;
}

async function searchPlace(textQuery: string): Promise<{ placeId: string } | { skipped: true; reason: string } | { error: string; status: number }> {
  const searchFields = "places.id,places.displayName,places.formattedAddress";
  try {
    const sr = await fetch(PLACES_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": API_KEY,
        "X-Goog-FieldMask": searchFields,
      },
      body: JSON.stringify({ textQuery }),
    });
    if (!sr.ok) {
      const errBody = await sr.text();
      console.error("Places search failed:", sr.status, errBody);
      return { error: "Places search failed", status: 502 };
    }
    const searchJson = await sr.json();
    const firstPlace = searchJson?.places?.[0];
    if (!firstPlace?.id) {
      return { skipped: true, reason: "No Places match found" };
    }
    return { placeId: firstPlace.id };
  } catch (e) {
    console.error("Places search exception:", String(e));
    return { error: "Places search exception", status: 502 };
  }
}

async function fetchPlaceDetails(placeId: string): Promise<PlaceResult | { error: string; status: number }> {
  const detailFields = [
    "formattedAddress",
    "nationalPhoneNumber",
    "rating",
    "userRatingCount",
    "businessStatus",
    "location",
  ];
  try {
    const dr = await fetch(`${PLACES_API_BASE}/places/${placeId}`, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": API_KEY,
        "X-Goog-FieldMask": detailFields.join(","),
      },
    });
    if (!dr.ok) {
      const errBody = await dr.text();
      console.error("Place details failed:", dr.status, errBody);
      return { error: "Place details failed", status: 502 };
    }
    const detailJson = await dr.json();
    return {
      place_id: placeId,
      formattedAddress: detailJson?.formattedAddress ?? "",
      phone: detailJson?.nationalPhoneNumber ?? "",
      rating: detailJson?.rating ?? null,
      userRatingCount: detailJson?.userRatingCount ?? null,
      businessStatus: detailJson?.businessStatus ?? "",
      latitude: detailJson?.location?.latitude ?? null,
      longitude: detailJson?.location?.longitude ?? null,
    };
  } catch (e) {
    console.error("Place details exception:", String(e));
    return { error: "Place details exception", status: 502 };
  }
}

interface GeocodeResult {
  formattedAddress: string;
  latitude: number;
  longitude: number;
  partialMatch: boolean;
  locationType: string;
}

// Only these two location_types mean Google resolved to an actual building/
// address point. GEOMETRIC_CENTER (e.g. the midpoint of a street with no
// house number) and APPROXIMATE are real results, not a lookup failure, but
// they are not precise enough to silently become the center of a delivery
// radius — those must go through confirmation too.
const PRECISE_LOCATION_TYPES = new Set(["ROOFTOP", "RANGE_INTERPOLATED"]);

// Address resolution, not place-relevance ranking — this is what mode:"set"
// must use. Never concatenate the shop's name into this query: the owner is
// stating a street address, and a name search can let a same-named business
// outrank the address actually typed.
async function geocodeAddress(address: string): Promise<{ result: GeocodeResult } | { skipped: true; reason: string } | { error: string; status: number }> {
  try {
    const url = `${GEOCODE_URL}?address=${encodeURIComponent(address)}&key=${API_KEY}`;
    const gr = await fetch(url);
    if (!gr.ok) {
      const errBody = await gr.text();
      console.error("Geocode failed:", gr.status, errBody);
      return { error: "Geocode failed", status: 502 };
    }
    const gj = await gr.json();
    if (gj.status === "ZERO_RESULTS") {
      return { skipped: true, reason: "No address match found" };
    }
    if (gj.status !== "OK") {
      console.error("Geocode non-OK status:", gj.status, gj.error_message ?? "");
      return { error: `Geocode status ${gj.status}`, status: 502 };
    }
    const top = gj.results?.[0];
    if (!top?.formatted_address || top?.geometry?.location?.lat == null || top?.geometry?.location?.lng == null) {
      return { skipped: true, reason: "No address match found" };
    }
    return {
      result: {
        formattedAddress: top.formatted_address,
        latitude: top.geometry.location.lat,
        longitude: top.geometry.location.lng,
        partialMatch: top.partial_match === true,
        locationType: top.geometry?.location_type ?? "",
      },
    };
  } catch (e) {
    console.error("Geocode exception:", String(e));
    return { error: "Geocode exception", status: 502 };
  }
}

// Defense in depth alongside Google's own partial_match flag: if the owner
// typed a leading house number and it does not survive into the resolved
// address at all, treat the match as unconfirmed regardless of what Google
// reports — a wrong-but-confident match is exactly the failure this guards.
function leadingHouseNumber(address: string): string | null {
  const m = address.trim().match(/^(\d+[A-Za-z]?)\b/);
  return m ? m[1].toLowerCase() : null;
}

function houseNumberSurvives(inputAddress: string, resolvedAddress: string): boolean {
  const num = leadingHouseNumber(inputAddress);
  if (!num) return true;
  const resolvedTokens = resolvedAddress.toLowerCase().split(/[^a-z0-9]+/);
  return resolvedTokens.includes(num);
}

Deno.serve(async (req: Request) => {
  // ── Auth ──────────────────────────────────────────────────────────
  const auth = req.headers.get("authorization");
  const expectedKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const internalSecret = Deno.env.get("INTERNAL_FUNCTION_SECRET") ?? "";
  const bearerKey = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
  if (bearerKey !== expectedKey && bearerKey !== internalSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  let body: { shop_id?: string; name?: string; address_hint?: string; mode?: "set"; address?: string; confirm?: boolean } = {};
  try { body = await req.json(); } catch { /* ok */ }

  const { shop_id, name, address_hint, mode } = body;
  if (!shop_id) {
    return new Response(JSON.stringify({ error: "shop_id required" }), { status: 400 });
  }

  const { data: shop, error: shopErr } = await supabase
    .from("shops")
    .select("id, name, formatted_address, google_place_id")
    .eq("id", shop_id)
    .single();

  if (shopErr || !shop) {
    return new Response(JSON.stringify({ error: "Shop not found", detail: shopErr?.message }), { status: 404 });
  }

  // ── mode: "set" — owner typed an address, resolve it, write on a confirmed match ──
  if (mode === "set") {
    const address = (body.address ?? "").trim();
    if (!address) {
      return new Response(JSON.stringify({ error: "address required" }), { status: 400 });
    }
    const confirmed = body.confirm === true;
    const geocoded = await geocodeAddress(address);
    if ("error" in geocoded) {
      return new Response(JSON.stringify(geocoded), { status: geocoded.status });
    }
    if ("skipped" in geocoded) {
      // No write — a miss must never touch the existing geocode.
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: geocoded.reason }));
    }
    const { formattedAddress, latitude, longitude, partialMatch, locationType } = geocoded.result;
    const numberSurvives = houseNumberSurvives(address, formattedAddress);
    const isPrecise = PRECISE_LOCATION_TYPES.has(locationType);
    if (!confirmed && (partialMatch || !numberSurvives || !isPrecise)) {
      // Resolved address doesn't cleanly match what the owner typed — return
      // it as a candidate. Nothing is written until the owner explicitly
      // accepts it via a second call with confirm:true. Silently writing a
      // different address than the one stated is the defect this closes.
      return new Response(JSON.stringify({
        ok: true,
        needs_confirmation: true,
        candidate: { formattedAddress, latitude, longitude },
      }));
    }
    // Only the address fields — this mode never touches google_place_id,
    // google_rating, google_review_count, or business_status. Those are the
    // business's Google identity, unrelated to correcting a street address,
    // and a bad match here must not be able to corrupt them.
    const { error: updateErr } = await supabase
      .from("shops")
      .update({
        formatted_address: formattedAddress,
        latitude,
        longitude,
      })
      .eq("id", shop_id);
    if (updateErr) {
      console.error("DB update failed:", updateErr.message);
      return new Response(JSON.stringify({ error: "DB update failed", detail: updateErr.message }), { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true, candidate: { formattedAddress, latitude, longitude } }));
  }

  // ── default / "auto" mode — original onboarding behavior, unchanged ────
  // Idempotency: skip if already populated. Only this mode has ever done this.
  if (shop.google_place_id) {
    return new Response(JSON.stringify({
      skipped: true,
      reason: "google_place_id already set",
      place_id: shop.google_place_id,
    }));
  }

  const searchQuery = name ?? shop.name;
  const textQuery = address_hint ? `${searchQuery} ${address_hint}` : searchQuery;

  const searched = await searchPlace(textQuery);
  if ("error" in searched) {
    return new Response(JSON.stringify({ error: searched.error, status: searched.status }), { status: searched.status });
  }
  if ("skipped" in searched) {
    return new Response(JSON.stringify({ skipped: true, reason: searched.reason }));
  }

  const details = await fetchPlaceDetails(searched.placeId);
  if ("error" in details) {
    return new Response(JSON.stringify(details), { status: details.status });
  }

  const result: PlaceResult = details;
  const { error: updateErr } = await supabase
    .from("shops")
    .update({
      google_place_id: result.place_id,
      formatted_address: result.formattedAddress || null,
      google_rating: result.rating,
      google_review_count: result.userRatingCount,
      business_status: result.businessStatus || null,
      latitude: result.latitude,
      longitude: result.longitude,
    })
    .eq("id", shop_id);

  if (updateErr) {
    console.error("DB update failed:", updateErr.message);
    return new Response(JSON.stringify({ error: "DB update failed", detail: updateErr.message, result }), { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
});
