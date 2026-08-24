# Spec: Delivery Radius Zone + address check

**Owner:** SprintAI_bot (lead) → John Walsh (build) → Melvin (verify)
**Date:** 2026-08-24
**Decision (Jason):** Zone model = **radius in miles**. Owner sets it on the setup screen and can modify it in the admin screen.

## Goal

A shop owner defines a delivery radius (miles). When a customer gives a delivery address in chat, we geocode it, measure straight-line distance from the shop, and:
- **inside radius** → accept, continue order
- **outside radius** → warmly decline delivery, offer pickup instead (never silently accept)
- **address low-confidence / ungeocodable** → ask the customer to re-confirm (fail safe; never accept a guess)
- **shop has no radius set (null)** → behave exactly as today (accept, no check) so existing shops don't regress

Generalizes to every shop. No per-shop code.

## Data model

New migration `supabase/migrations/063_add_delivery_radius_and_geo.sql`:
```sql
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision,
  ADD COLUMN IF NOT EXISTS delivery_radius_mi numeric(5,2);
```
`delivery_radius_mi` nullable (null = no check). Apply to live project `rvdqfxtrskxekfkqnegx`.

## Tasks

1. **google-places-lookup** (`supabase/functions/google-places-lookup/index.ts`)
   - Add `"location"` to `detailFields`.
   - Store `latitude = detailJson.location.latitude`, `longitude = detailJson.location.longitude` in the `shops` update block (alongside existing place fields). Null-safe.

2. **Migration 063** as above.

3. **Setup screen** (`signup-page/setup.html`)
   - Inside `#deliveryOptions` (next to Delivery fee), add:
     `Delivery radius (miles)` → `<input type="number" id="deliveryRadius" step="0.5" min="0" placeholder="e.g. 5">`
     Hint: "Customers outside this distance are offered pickup instead. Leave blank for no limit."
   - Load existing `delivery_radius_mi` into the field on page load; include it in the save payload.

4. **onboarding-save** (`supabase/functions/onboarding-save/index.ts`)
   - Accept `delivery_radius_mi` from the setup payload and persist to `shops`. Coerce empty → null; clamp negative → null.

5. **Admin screen** (`admin-dashboard/src/pages/ShopDetail.tsx`)
   - Add `delivery_radius_mi` to `shopForm` state (loaded from the shop row).
   - Add a labeled number input in the shop-settings edit form.
   - Include `delivery_radius_mi` in the `saveShop` mutation's `shops.update({...})`. Empty → null.

6. **chat-sms** (`supabase/functions/chat-sms/index.ts`, `set_delivery_address` handler ~line 980)
   - After the address is collected, if the shop has `latitude`, `longitude`, and a non-null `delivery_radius_mi`:
     - Geocode the customer address via Google Geocoding API (`https://maps.googleapis.com/maps/api/geocode/json`, key `GOOGLE_MAPS_API_KEY` from env).
     - If geocode `status !== "OK"` or top result `location_type` is `APPROXIMATE`/partial or no result → **do not set** the address; return a message asking the customer to re-check/re-send the full street address. Fail safe.
     - Compute haversine miles between shop and customer coords.
     - If distance > `delivery_radius_mi` → **do not set** the delivery address; return a warm message: outside the delivery area, offer pickup (keep the cart, let them switch to pickup). Match existing friendly tone.
     - If distance ≤ radius → set the delivery address as today.
   - If the shop lacks lat/lng or radius is null → current behavior unchanged.
   - Add the shop's `latitude, longitude, delivery_radius_mi` to the shop select used by chat-sms so the handler has them.
   - Straight-line haversine is acceptable for v1. Do not add a Distance-Matrix call.

7. **Early order-type + zone gate** (`supabase/functions/chat-sms/index.ts`, `buildSystemPrompt`)
   - For **delivery-enabled** shops, the assistant asks **"delivery or pickup?" early** — in the opening turns, before the customer builds a cart — not only at checkout.
   - If the customer picks **delivery**, collect the delivery address **up front** and run the Task 6 geocode + radius check **immediately**, before taking menu items.
     - outside zone / ungeocodable → tell them **now** (before any cart is built), offer pickup instead.
     - inside zone → proceed to take the order.
   - Keep it warm and natural (a real shop asks "for pickup or delivery?"), not a form. Do not front-load address collection for **pickup** orders or for pickup-only shops.
   - Reuse the same geocode/haversine helper from Task 6 — no duplicate logic.

## Acceptance criteria (Melvin verifies live)

- Migration 063 applied; `shops` has `latitude`, `longitude`, `delivery_radius_mi`.
- google-places-lookup stores lat/lng on a test shop (verify a real place returns coords and the row updates).
- Setup screen renders the radius field, saves it, and reloads the persisted value.
- Admin ShopDetail renders + saves the radius; value round-trips.
- chat-sms behavior, all four branches, via a scripted conversation or direct handler test:
  - address inside radius → accepted
  - address outside radius → declined warmly + pickup offered, address NOT set
  - ungeocodable/low-confidence address → asked to re-confirm, address NOT set
  - shop with null radius → unchanged (accepts any address)
- **Early gate:** in a delivery-enabled shop, the bot asks delivery-or-pickup within the first couple of assistant turns; on delivery it checks the address BEFORE items are added; an out-of-zone customer is told up front and offered pickup, not after building a cart. Pickup-only shops never ask for an address early.
- Tenant isolation: radius + coords are per-shop; no cross-tenant read.
- No secrets logged. Geocode failures logged without PII where avoidable.

## REVISION 2026-08-24 — fail CLOSED, positive confirmation required (Jason)

The v1 zone check fails **open** (partial match, no-result, and geocode error all "proceed with a warning"). That creates a take-the-order-then-chase-the-customer support loop. **Reverse it.** For a delivery order we accept the address **only** when it is a positively-qualified, in-zone, street-level match. Otherwise we do not deliver there — offer pickup. Never set a delivery address we could not confirm.

Rewrite the geocode/zone block in `supabase/functions/chat-sms/index.ts` (the block around lines 1013–1044, `set_delivery_address`) to this logic:

Define **qualified** = geocode `status === "OK"` AND ≥1 result AND `results[0].partial_match !== true` AND `results[0].geometry.location_type` ∈ {`"ROOFTOP"`, `"RANGE_INTERPOLATED"`}. (location_type filters out city/region **centroids** — `APPROXIMATE`/`GEOMETRIC_CENTER` — which is how the fake-city address slipped through. Request `location_type` is already in the geocode response; read `results[0].geometry.location_type`.)

Branches (shop has coords + `delivery_radius_mi > 0` + `GOOGLE_MAPS_API_KEY` present):
- **Qualified AND distance ≤ radius** → accept: fall through to `order_carts.update` and set the address. (unchanged happy path)
- **Qualified AND distance > radius** → **do not set**; warm decline + offer pickup (existing outside-zone message).
- **Not qualified** (partial match, centroid-only, `ZERO_RESULTS`, or any non-OK status) → **do not set the address**. Return a warm message: we couldn't confirm that as a deliverable address — ask them to double-check the street number + ZIP, or switch to pickup. No "a staff member may contact you." No proceed.
- **Transient failure** (fetch throws, network error, HTTP 5xx, or timeout) → retry the geocode **once**; if it still fails → **do not set**; warm message that we can't confirm addresses right now, offer pickup or try again shortly. Do **not** accept an unconfirmed delivery.
- **No `GOOGLE_MAPS_API_KEY` / shop has no coords or radius null** → existing behavior (no check) unchanged, so shops without a configured zone are unaffected.

Key invariant: on any path other than "qualified + in-zone," the code must **not** run `order_carts.update` with the delivery address. The only ways forward for the customer are (a) give a corrected address that qualifies, or (b) switch to pickup.

**Flagged tradeoff (for Jason, not a blocker):** strict `location_type` + `partial_match` gating can false-reject a small number of valid-but-messy addresses (odd abbreviations, brand-new construction). That's the safe direction — err toward pickup, never toward an unfulfillable delivery. Also: a full Google Geocoding outage would block **all** delivery orders (fail-closed by design); pickup still works. Acceptable, but worth knowing.

### Acceptance (Melvin, live on Zio's — radius 3 mi)
- In-zone real street address (ROOFTOP) → accepted.
- Out-of-zone real street address → declined + pickup offered, address NOT set.
- Garbage / fake-city / centroid-only address → **declined** (not "proceed with warning"), address NOT set.
- `ZERO_RESULTS` address → declined, address NOT set.
- Confirm via DB that `order_carts.delivery_address` is **null/unchanged** after every non-qualified attempt.
- Shop with null radius → unchanged (no check).

## REVISION 2 — 2026-08-24 — coords REQUIRED for a delivery shop to go live (Jason)

A delivery-enabled shop must have coordinates to complete onboarding. Enforce at the go-live gate, and make it enforceable (not a dead-end) by geocoding the shop's own address as the reliable source.

**File:** `supabase/functions/go-live/index.ts`.

1. **Backfill coords before the gate.** If `shop.delivery_enabled === true` AND (`shop.latitude` is null OR `shop.longitude` is null):
   - Geocode the shop's own address via `GOOGLE_MAPS_API_KEY` (Google Geocoding API). Use `shop.formatted_address` if present, else compose from the shop's address fields.
   - Qualified result (`status === "OK"`, `results[0].partial_match !== true`, `location_type` ∈ {`ROOFTOP`,`RANGE_INTERPOLATED`}) → persist `latitude`/`longitude` to the `shops` row and use them.
   - Not qualified / geocode fails → leave coords null (the gate below will block with a clear message).

2. **Add a `delivery_geo` gate** to the `gates` object:
   `delivery_geo: shop.delivery_enabled ? (shop.latitude != null && shop.longitude != null) : true`
   When it blocks, the message must be actionable: e.g. "Go-live refused: we couldn't locate your shop on the map — check that your street address is correct so we can set your delivery area." (Non-delivery shops are unaffected — gate is `true`.)

3. **Defense-in-depth in chat-sms** (`supabase/functions/chat-sms/index.ts`): if a shop has `delivery_enabled === true` but is missing coords (or the geo key is absent), delivery must **refuse** (offer pickup) rather than fall through and accept blind. This kills the fail-open path Melvin flagged even if a bad row ever reaches production. Do not change the configured happy path.

### Acceptance (Melvin, live)
- Delivery shop with coords → `delivery_geo` passes, go-live proceeds (other gates permitting).
- Delivery shop, coords null, valid address → go-live backfills coords from the address, then passes.
- Delivery shop, coords null, un-geocodable address → go-live **refused** with the actionable message; status not flipped live.
- Non-delivery shop → `delivery_geo` gate is `true`, no effect.
- chat-sms: a delivery-enabled shop with coords forced null → delivery **refused** (pickup offered), no address written.

## Out of scope (v1)
- Drive-time / road distance, polygon zones, ZIP allowlists.
- Persistent geocode cache table (in-request caching only).
