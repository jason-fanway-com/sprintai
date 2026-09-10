/**
 * google-places-lookup
 *
 * Phase 6: Find a shop on Google Maps via Places API (New) and merge
 * authoritative address, phone, rating, and review count into the shops row.
 *
 * Two modes, selected by `mode` in the request body:
 *   - (default / "auto") — original onboarding behavior: search by shop_id,
 *     SKIP if google_place_id is already set, write the top match straight
 *     to `shops` with no confirmation step. Called by onboarding-save
 *     (fire-and-forget, async, non-blocking).
 *   - "set" — owner-facing address entry (admin-chat's SET_SHOP_ADDRESS,
 *     the Settings page's live address field). Takes shop_id + address,
 *     searches, and on a match writes it to `shops` in the same call — the
 *     owner types an address, presses Enter, and either sees the matched
 *     formatted_address or a "no match" message; there is no separate
 *     confirm step. Never skips on an existing place_id — the owner is
 *     explicitly (re-)looking up an address, possibly replacing one already
 *     set. On no match, nothing is written — the caller must never keep a
 *     stale geocode while implying a new one was set.
 *
 * Both modes share the same two Google Places calls (search, details) —
 * one implementation of "talk to Google", two callers.
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

Deno.serve(async (req: Request) => {
  // ── Auth ──────────────────────────────────────────────────────────
  const auth = req.headers.get("authorization");
  const expectedKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const internalSecret = Deno.env.get("INTERNAL_FUNCTION_SECRET") ?? "";
  const bearerKey = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
  if (bearerKey !== expectedKey && bearerKey !== internalSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  let body: { shop_id?: string; name?: string; address_hint?: string; mode?: "set"; address?: string } = {};
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

  // ── mode: "set" — owner typed an address, look it up, write on a match ──
  if (mode === "set") {
    const address = (body.address ?? "").trim();
    if (!address) {
      return new Response(JSON.stringify({ error: "address required" }), { status: 400 });
    }
    const textQuery = shop.name ? `${shop.name}, ${address}` : address;
    const searched = await searchPlace(textQuery);
    if ("error" in searched) {
      return new Response(JSON.stringify(searched), { status: searched.status });
    }
    if ("skipped" in searched) {
      // No write — a miss must never touch the existing geocode.
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: searched.reason }));
    }
    const details = await fetchPlaceDetails(searched.placeId);
    if ("error" in details) {
      return new Response(JSON.stringify(details), { status: details.status });
    }
    const { error: updateErr } = await supabase
      .from("shops")
      .update({
        google_place_id: details.place_id,
        formatted_address: details.formattedAddress || null,
        google_rating: details.rating,
        google_review_count: details.userRatingCount,
        business_status: details.businessStatus || null,
        latitude: details.latitude,
        longitude: details.longitude,
      })
      .eq("id", shop_id);
    if (updateErr) {
      console.error("DB update failed:", updateErr.message);
      return new Response(JSON.stringify({ error: "DB update failed", detail: updateErr.message, result: details }), { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true, candidate: details }));
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
