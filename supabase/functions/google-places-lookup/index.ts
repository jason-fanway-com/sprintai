/**
 * google-places-lookup
 *
 * Phase 6: Find a shop on Google Maps via Places API (New) and merge
 * authoritative address, phone, rating, and review count into the shops row.
 *
 * Called by onboarding-save when a new shop is created (async, non-blocking).
 * Also callable directly for ad-hoc enrichment of existing shops.
 *
 * Auth: Edge function key (service_role via Supabase internal).
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

  let body: { shop_id?: string; name?: string; address_hint?: string } = {};
  try { body = await req.json(); } catch { /* ok */ }

  const { shop_id, name, address_hint } = body;
  if (!shop_id) {
    return new Response(JSON.stringify({ error: "shop_id required" }), { status: 400 });
  }

  // ── Fetch shop row ────────────────────────────────────────────────
  const { data: shop, error: shopErr } = await supabase
    .from("shops")
    .select("id, name, formatted_address, google_place_id")
    .eq("id", shop_id)
    .single();

  if (shopErr || !shop) {
    return new Response(JSON.stringify({ error: "Shop not found", detail: shopErr?.message }), { status: 404 });
  }

  // Idempotency: skip if already populated
  if (shop.google_place_id) {
    return new Response(JSON.stringify({
      skipped: true,
      reason: "google_place_id already set",
      place_id: shop.google_place_id,
    }));
  }

  // ── Search ────────────────────────────────────────────────────────
  const searchQuery = name ?? shop.name;
  const textQuery = address_hint
    ? `${searchQuery} ${address_hint}`
    : searchQuery;

  const searchFields = "places.id,places.displayName,places.formattedAddress";
  let placeId: string | null = null;

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
      return new Response(JSON.stringify({
        error: "Places search failed",
        status: sr.status,
      }), { status: 502 });
    }

    const searchJson = await sr.json();
    const firstPlace = searchJson?.places?.[0];
    if (!firstPlace?.id) {
      return new Response(JSON.stringify({
        skipped: true,
        reason: "No Places match found",
      }));
    }

    placeId = firstPlace.id;
  } catch (e) {
    console.error("Places search exception:", String(e));
    return new Response(JSON.stringify({
      error: "Places search exception",
      detail: String(e),
    }), { status: 502 });
  }

  // ── Place Details ─────────────────────────────────────────────────
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
      return new Response(JSON.stringify({
        error: "Place details failed",
        status: dr.status,
      }), { status: 502 });
    }

    const detailJson = await dr.json();
    const result: PlaceResult = {
      place_id: placeId,
      formattedAddress: detailJson?.formattedAddress ?? "",
      phone: detailJson?.nationalPhoneNumber ?? "",
      rating: detailJson?.rating ?? null,
      userRatingCount: detailJson?.userRatingCount ?? null,
      businessStatus: detailJson?.businessStatus ?? "",
    };

    // ── Merge into shops ────────────────────────────────────────────
    const lat = detailJson?.location?.latitude ?? null;
    const lng = detailJson?.location?.longitude ?? null;

    const { error: updateErr } = await supabase
      .from("shops")
      .update({
        google_place_id: result.place_id,
        formatted_address: result.formattedAddress || null,
        google_rating: result.rating,
        google_review_count: result.userRatingCount,
        business_status: result.businessStatus || null,
        latitude: lat,
        longitude: lng,
      })
      .eq("id", shop_id);

    if (updateErr) {
      console.error("DB update failed:", updateErr.message);
      return new Response(JSON.stringify({
        error: "DB update failed",
        detail: updateErr.message,
        result,
      }), { status: 500 });
    }

    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });

  } catch (e) {
    console.error("Place details exception:", String(e));
    return new Response(JSON.stringify({
      error: "Place details exception",
      detail: String(e),
    }), { status: 502 });
  }
});