/**
 * go-live Edge Function — Spec 05 step 8 go-live gate.
 *
 * POST { shop_id }
 *
 * Verifies ALL go-live prerequisites and ONLY flips status='active',
 * is_paused=false when every gate passes. The Connect gate uses the shared
 * isShopLive() (single source of truth, spec 01/02) — so in Phase 1, with
 * Connect unconfigured, this endpoint correctly REFUSES to go live.
 *
 * Gates (all must pass):
 *   - Connect:          isShopLive(shop) === true  (charges+payouts enabled)
 *   - Delivery Geo:     coords set when delivery_enabled
 *   - Menu:             a confirmed csv-source menu with >=1 active item
 *   - Menu Approved:    owner attestation (§C) on current menu hash
 *   - Menu Clean:       no flagged-awaiting-review rows
 *   - Number:           phone_number_e164 set
 *   - Hours:            open_hours has at least one day configured
 *   - Subscription:     subscription_status === 'active'
 *   - EIN:              required for non-test shops
 *   - Proof:            100% proof_pass_pct on current menu via QA twin
 *   - Delivery Test:    first-delivery handset test recorded passed
 *   - Ticket Dest:      email_ticket_recipient set and valid
 *
 * Returns { ok, live, gates: {...}, blocked_by: [...] }. Never throws the shop
 * live partially; it's all-or-nothing.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { isShopLive } from "../_shared/connect.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonError("Method Not Allowed", 405);

  let body: { shop_id?: string };
  try { body = await req.json(); } catch { return jsonError("Invalid JSON"); }
  const shopId = body.shop_id;
  if (!shopId) return jsonError("shop_id is required");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const { data: shop, error: shopErr } = await supabase
    .from("shops")
    .select("id, name, slug, is_test, ein, open_hours, phone_number_e164, subscription_status, stripe_connected_account_id, charges_enabled, payouts_enabled, connect_status, latitude, longitude, delivery_enabled, formatted_address, email_ticket_recipient, first_delivery_test_passed_at, campaign_assignment_status")
    .eq("id", shopId).single();
  if (shopErr || !shop) return jsonError("Shop not found", 404);

  // Menu gate: confirmed csv OR pdf menu with ≥1 active item AND owner attestation (§C).
  const { data: menu } = await supabase
    .from("menus").select("id, content_hash").eq("shop_id", shopId)
    .or("source.eq.csv,source.eq.pdf").order("created_at", { ascending: false }).maybeSingle();
  let activeItems = 0;
  let menuApproved = false;
  let menuFlaggedReview = 0;
  let menuOpenQuestions = 0;
  if (menu?.id) {
    const { count } = await supabase
      .from("menu_items").select("id", { count: "exact", head: true })
      .eq("menu_id", menu.id).eq("active", true);
    activeItems = count ?? 0;

    // §C sign-off: does a valid approval exist for this content_hash?
    if (menu.content_hash) {
      const { count: approvalCount } = await supabase
        .from("menu_approvals").select("id", { count: "exact", head: true })
        .eq("menu_id", menu.id).eq("content_hash", menu.content_hash);
      menuApproved = (approvalCount ?? 0) > 0;
    }

    // Check for flagged-awaiting-review rows
    const { count: flaggedCount } = await supabase
      .from("menu_items").select("id", { count: "exact", head: true })
      .eq("menu_id", menu.id).eq("flag_review", true);
    menuFlaggedReview = flaggedCount ?? 0;

    // Check open questions count from the menu record
    const { data: menuRecord } = await supabase
      .from("menus").select("open_questions").eq("id", menu.id).maybeSingle();
    const oq = menuRecord?.open_questions;
    if (Array.isArray(oq)) {
      menuOpenQuestions = oq.length;
    } else if (typeof oq === "string") {
      try { menuOpenQuestions = JSON.parse(oq).length; } catch { menuOpenQuestions = 0; }
    }
  }

  const hoursSet = !!shop.open_hours && typeof shop.open_hours === "object" &&
    Object.keys(shop.open_hours as Record<string, unknown>).length > 0;

  const isTest = shop.is_test === true;
  const hasStripe = isShopLive(shop);

  // EIN gate: required for non-test shops only.
  const hasEin = isTest || !!shop.ein;

  // ── Geocode shop's own address if delivery_enabled and coords missing ──
  // Runs before the gates object so the delivery_geo gate sees current coords.
  if (shop.delivery_enabled && (shop.latitude == null || shop.longitude == null)) {
    const address = typeof shop.formatted_address === "string" && shop.formatted_address.trim()
      ? shop.formatted_address.trim()
      : null;
    if (address) {
      const geoKey = Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "";
      if (geoKey) {
        const addrQuery = encodeURIComponent(address);
        const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${addrQuery}&key=${geoKey}`;
        type GeoResult = {
          status: string;
          results: Array<{
            geometry: { location: { lat: number; lng: number }; location_type?: string };
            partial_match?: boolean;
          }>;
        };
        let geoJson: GeoResult | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 8000);
            const geoRes = await fetch(geoUrl, { signal: ctrl.signal });
            clearTimeout(timer);
            if (geoRes.status >= 500) throw new Error(`HTTP ${geoRes.status}`);
            geoJson = await geoRes.json() as GeoResult;
            break;
          } catch {
            if (attempt === 0) continue;
          }
        }
        if (geoJson && geoJson.status === "OK" && geoJson.results.length > 0) {
          const top = geoJson.results[0];
          const qualified = top.partial_match !== true &&
            (top.geometry.location_type === "ROOFTOP" || top.geometry.location_type === "RANGE_INTERPOLATED");
          if (qualified) {
            const loc = top.geometry.location;
            shop.latitude = loc.lat;
            shop.longitude = loc.lng;
            await supabase.from("shops").update({
              latitude: loc.lat,
              longitude: loc.lng,
              updated_at: new Date().toISOString(),
            }).eq("id", shopId);
            console.log(`[go-live] Auto-geocoded shop ${shopId}: lat=${loc.lat} lng=${loc.lng}`);
          } else if (geoJson.status === "OK") {
            console.warn(`[go-live] Geocode result for shop ${shopId} was not qualified ` +
              `(partial_match=${top.partial_match}, location_type=${top.geometry.location_type}) — coords left null`);
          }
        }
      } else {
        console.warn(`[go-live] GOOGLE_MAPS_API_KEY not set — cannot auto-geocode shop ${shopId}`);
      }
    } else {
      console.warn(`[go-live] Delivery-enabled shop ${shopId} has no formatted_address — cannot auto-geocode`);
    }
  }

  // ── Proof Gate: resolve QA twin, read latest test_run, verify 100% ──
  let proofPass = false;
  let proofMessage = "";
  const sourceName: string = (shop as any).name ?? "";
  const sourceSlug: string = (shop as any).slug ?? "";

  // Find QA twin: is_test=true, phone-less, tenant config has is_qa_twin
  const { data: twinCandidates } = await supabase
    .from("shops")
    .select("id, name, tenant_id")
    .eq("is_test", true)
    .is("phone_number_e164", null);

  let twinShop: { id: string; name: string } | null = null;
  if (twinCandidates && twinCandidates.length > 0) {
    const tenantIds = [...new Set(twinCandidates.map((t: any) => t.tenant_id))];
    const { data: tenants } = await supabase
      .from("tenants")
      .select("id, config")
      .in("id", tenantIds);
    const qaTenantIds = new Set(
      (tenants ?? []).filter((t: any) => t.config?.is_qa_twin === true).map((t: any) => t.id),
    );
    const qaTwins = (twinCandidates ?? []).filter((t: any) => qaTenantIds.has(t.tenant_id));
    // Match by name: twin name contains source name (case-insensitive)
    twinShop = qaTwins.find((t: any) =>
      t.name.toLowerCase().includes(sourceName.toLowerCase()),
    ) ?? null;
  }

  const sourceMenuHash: string | null = menu?.content_hash ?? null;

  if (twinShop) {
    // Read twin's menu for parity check
    const { data: twinMenu } = await supabase
      .from("menus")
      .select("id, content_hash, updated_at")
      .eq("shop_id", twinShop.id)
      .or("source.eq.csv,source.eq.pdf")
      .order("created_at", { ascending: false })
      .maybeSingle();

    let twinActiveItems = 0;
    if (twinMenu?.id) {
      const { count: tc } = await supabase
        .from("menu_items").select("id", { count: "exact", head: true })
        .eq("menu_id", twinMenu.id).eq("active", true);
      twinActiveItems = tc ?? 0;
    }

    // Menu parity: same item count + same content_hash
    const menuParity = twinActiveItems === activeItems &&
      twinMenu?.content_hash === sourceMenuHash;

    if (!menuParity) {
      proofMessage = `Go-live refused: QA twin "${twinShop.name}" menu does not match shop menu. ` +
        `Twin: ${twinActiveItems} items (hash ${(twinMenu?.content_hash ?? "none").slice(0, 8)}). ` +
        `Shop: ${activeItems} items (hash ${(sourceMenuHash ?? "none").slice(0, 8)}). ` +
        `Re-create the twin with create-qa-twin.py before launch.`;
    } else {
      // Read latest test_run for twin
      const { data: latestRun } = await supabase
        .from("test_runs")
        .select("id, proof_pass_pct, scorer_version, started_at")
        .eq("shop_id", twinShop.id)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!latestRun) {
        proofMessage = `Go-live refused: no Proof run found for QA twin "${twinShop.name}". ` +
          `Run Proof before launch.`;
      } else if (latestRun.scorer_version !== 3) {
        proofMessage = `Go-live refused: Proof run ${latestRun.id} uses scorer_version ` +
          `${latestRun.scorer_version}, requires version 3. Re-run Proof.`;
      } else if (latestRun.proof_pass_pct !== 100) {
        proofMessage = `Go-live refused: Proof run ${latestRun.id} scored ` +
          `${latestRun.proof_pass_pct}% (100% required). Run Proof and clear all failures before launch.`;
      } else if (
        twinMenu?.updated_at && latestRun.started_at &&
        new Date(latestRun.started_at) < new Date(twinMenu.updated_at)
      ) {
        proofMessage = `Go-live refused: Proof run ${latestRun.id} is stale — ` +
          `twin menu changed after the run (run: ${latestRun.started_at}, ` +
          `menu updated: ${twinMenu.updated_at}). Re-run Proof.`;
      } else {
        proofPass = true;
      }
    }
  } else {
    proofMessage = `Go-live refused: no QA twin found for "${sourceName}". ` +
      `Create a twin with create-qa-twin.py before running Proof.`;
  }

  // ── Delivery Test Gate: first-delivery handset test recorded passed ──
  const deliveryTestPass = isTest || !!shop.first_delivery_test_passed_at;

  // ── Campaign Assignment Gate: number must be mapped/approved before live ──
  const campaignAssigned = isTest || (shop as any).campaign_assignment_status === "approved";

  // ── Ticket Destination Gate: email_ticket_recipient must be valid ──
  const emailRecipient: string | null = (shop as any).email_ticket_recipient ?? null;
  const ticketDestPass = typeof emailRecipient === "string" &&
    emailRecipient.trim().length > 0 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRecipient.trim());

  const gates = {
    connect: hasStripe,
    delivery_geo: shop.delivery_enabled ? (shop.latitude != null && shop.longitude != null) : true,
    menu: activeItems > 0,
    menu_approved: menuApproved || activeItems === 0,  // §C: requires owner attestation
    menu_clean: menuFlaggedReview === 0,                 // §C: no flagged rows pending
    number: !!shop.phone_number_e164,
    hours: hoursSet,
    subscription: shop.subscription_status === "active",
    ein: hasEin,
    proof: proofPass,
    delivery_test: deliveryTestPass,
    campaign_assignment: campaignAssigned,
    ticket_destination: ticketDestPass,
  };

  const blocked_by = Object.entries(gates).filter(([, ok]) => !ok).map(([k]) => k);

  if (blocked_by.length > 0) {
    // Build per-gate refusal messages (actionable, spec §Refusal messages)
    const gateMsgs: Record<string, string> = {
      connect: "Go-live refused: Stripe Connect is not enabled yet (charges_enabled false). This is the expected Phase-1 gate — the shop cannot take live orders until payouts are configured.",
      delivery_geo: "Go-live refused: Delivery is enabled but shop coordinates are missing. Ensure the shop address is set (formatted_address) and try again — the system will auto-geocode it.",
      proof: proofMessage || "Go-live refused: Proof has not passed.",
      delivery_test: "Go-live refused: the first-delivery test has not been completed on this number. Run the 8-step handset script and record the result.",
      campaign_assignment: "Go-live refused: campaign assignment is not yet approved. The number is provisioned but carrier mapping is incomplete. The system checks this automatically — no manual action needed unless it has been more than 2 hours since number provision.",
      ticket_destination: "Go-live refused: no order email is configured. The kitchen has no way to receive orders.",
    };
    // Pick the first blocked gate that has a custom message; fall back to join
    const customMsg = blocked_by.find((k) => gateMsgs[k]) ?? null;
    const message = customMsg
      ? gateMsgs[customMsg]
      : "Go-live refused: " + blocked_by.join(", ");

    return jsonResponse({ ok: true, live: false, gates, blocked_by, message });
  }

  // All gates pass → flip live.
  const { error: upErr } = await supabase
    .from("shops").update({ is_paused: false, onboarding_step: "done", updated_at: new Date().toISOString() })
    .eq("id", shopId);
  if (upErr) return jsonError("Failed to flip live: " + upErr.message, 500);

  return jsonResponse({ ok: true, live: true, gates, blocked_by: [] });
});

function jsonResponse(b: unknown, status = 200): Response {
  return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}
function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
