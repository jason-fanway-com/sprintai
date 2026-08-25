# Spec: Google Places as a reliable onboarding step

**Owner:** SprintAI_bot → John Walsh → Melvin
**Date:** 2026-08-24
**Directive (Jason):** Google Places enrichment must be a real part of onboarding. Today `kickPlaces` fires only once at shop-CREATE, using the shop NAME only, before the address is known — fragile, and it never retries or backfills. Zio's has null `google_place_id`/`formatted_address` because it was created before the function existed and was never retried.

## Fix

1. **Fire Places when the address is known, not at create.** In `supabase/functions/onboarding-save/index.ts`, on the setup/address-bearing save path, if the shop has an address (formatted_address or composed street/city/state/zip) AND `google_place_id` is null, call `google-places-lookup` with an `address_hint` = the shop's address (the function already accepts `address_hint`). Keep it fire-and-forget; never block the save. Idempotent: skip if `google_place_id` already set (the function already guards this).
   - Keep the existing create-time kick OR remove it in favor of the address-known kick — builder's judgment, but the address-known path is the reliable one.

2. **Backfill.** Provide a way to enrich existing shops with null `google_place_id`: either a small `--backfill` path or run `google-places-lookup` for each such shop once. At minimum, populate **Zio's** (2cba7b51-211c-4437-8910-1af4dcc03498) live and confirm `google_place_id`, `formatted_address`, `latitude`, `longitude`, rating/review_count get written.

3. **Verify the Places API is actually enabled.** `google-places-lookup` uses Places API (New) `places:searchText` — a DIFFERENT API from Geocoding. It may not be enabled in the GCP project. Call it live for Zio's and report: does it return a place, or an API-not-enabled/permission error? If disabled, STOP and report exactly which GCP API must be enabled (do not thrash) — that's a Jason action.

## Acceptance (Melvin, live)
- After a setup save on a shop with an address and null place_id, `google-places-lookup` fires and (if the API is enabled) populates `google_place_id` + `formatted_address` + rating.
- Zio's is backfilled: `google_place_id` and `formatted_address` non-null (or a clear report that the Places API is disabled in GCP).
- Save is never blocked by Places failure.
- Idempotent: re-saving doesn't re-query once place_id is set.
- Tenant-scoped; no secrets logged.

## Out of scope
- Full self-serve re-onboarding redesign.
