/**
 * provision-number Edge Function — Telnyx auto-provisioning.
 *
 * POST { shop_id, area_code? }
 *
 * Guardrails (unchanged from Twilio version):
 *   1. SUBSCRIPTION-FIRST  — refuse unless shops.subscription_pm_set === true.
 *   2. ONE-NUMBER-PER-SHOP — idempotent: returns existing number.
 *   3. DAILY CAP           — MAX_NEW_NUMBERS_PER_DAY (default 25).
 *
 * Telnyx flow (Phase 2):
 *   1. Search available numbers: national_destination_code + sms + voice
 *   2. Order the number
 *   3. Create a per-shop messaging profile (webhook -> chat-sms)
 *   4. Assign number to profile
 *   5. Persist shop.phone_number_e164 / telnyx_number_id / telnyx_messaging_profile_id
 *   6. Log to number_provision_log for cap accounting
 *
 * Number-to-campaign assignment is intentionally SEPARATE: it requires TNSP
 * approval per campaign, so it happens in a parallel async flow (provision-campaign).
 * The number IS active on its messaging profile immediately — just not yet
 * throttled through the campaign.
 *
 * Phase 1 (current): demo/test shops use a single number pre-assigned
 * to the SprintAI brand campaign. This function is the Phase 2 self-serve path.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_NEW_NUMBERS_PER_DAY = 25;

// Telnyx v2 API base
const TELNYX_API = "https://api.telnyx.com/v2";

interface TelnyxNumber {
  phone_number: string;
  id: string;
  locality: string;
  region: string;
  features?: string[];
}

interface TelnyxProfile {
  id: string;
  name: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonError("Method Not Allowed", 405);

  let body: { shop_id?: string; area_code?: string; test_mode?: boolean };
  try { body = await req.json(); } catch { return jsonError("Invalid JSON"); }

  const shopId = body.shop_id;
  if (!shopId) return jsonError("shop_id is required");

  // test_mode retained for backwards compat; always does real Telnyx now.
  const testMode = body.test_mode === true;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const { data: shop, error: shopErr } = await supabase
    .from("shops")
    .select("id, name, phone_number_e164, twilio_number_sid, telnyx_number_id, telnyx_messaging_profile_id, subscription_pm_set")
    .eq("id", shopId).single();
  if (shopErr || !shop) return jsonError("Shop not found", 404);

  // ─ Guardrail 2: ONE-NUMBER-PER-SHOP (idempotent) ─────────────────────────
  if (shop.phone_number_e164) {
    return jsonResponse({
      ok: true, already_provisioned: true,
      phone_number_e164: shop.phone_number_e164,
      telnyx_number_id: shop.telnyx_number_id ?? null,
      telnyx_messaging_profile_id: shop.telnyx_messaging_profile_id ?? null,
    });
  }

  // ─ Guardrail 1: SUBSCRIPTION-FIRST ────────────────────────────────────────
  if (!shop.subscription_pm_set) {
    return jsonError(
      "Subscription payment method not set — number provisioning is blocked until the $99/mo subscription is in place (subscription-first guardrail).",
      402,
    );
  }

  // ─ Guardrail 3: DAILY CAP ───────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const { count } = await supabase
    .from("number_provision_log")
    .select("id", { count: "exact", head: true })
    .eq("provisioned_on", today);
  if ((count ?? 0) >= MAX_NEW_NUMBERS_PER_DAY) {
    console.error(`[provision-number] DAILY CAP HIT (${count}/${MAX_NW_NUMBERS_PER_DAY}) — auto-buy paused. Shop ${shopId} queued.`);
    return jsonError(
      `Daily new-number cap reached (${MAX_NEW_NUMBERS_PER_DAY}). Auto-provisioning paused; your number will be issued shortly.`,
      429,
    );
  }

  const telnyxKey = Deno.env.get("TELNYX_API_KEY") ?? "";
  if (!telnyxKey) return jsonError("Telnyx API key not configured", 500);

  const chatSmsWebhook = (Deno.env.get("SUPABASE_URL") ?? "") + "/functions/v1/chat-sms";
  const authHeaders = {
    "Authorization": `Bearer ${telnyxKey}`,
    "Content-Type": "application/json",
  };

  // �── STEP 1: Search available number (NDC + sms + voice) ───────────────────
  const areaCode = body.area_code ?? "610";  // default SprintAI NDC
  const ndc = areaCode.length === 3 ? areaCode : "610";

  const searchUrl = `${TELNYX_API}/available_phone_numbers?filter[national_destination_code]=${ndc}&filter[features][]=sms&filter[features][]=voice&filter[limit]=5`;
  const searchRes = await fetch(searchUrl, { headers: authHeaders });
  if (!searchRes.ok) {
    const err = await searchRes.text();
    console.error(`[provision-number] Telnyx search failed (${searchRes.status}): ${err}`);
    return jsonError(`Number search failed: Telnyx returned ${searchRes.status}`, 502);
  }
  const searchJson = await searchRes.json();
  const candidates: TelnyxNumber[] = searchJson?.data ?? [];
  if (candidates.length === 0) {
    return jsonError(`No available numbers found in NDC ${ndc} with sms+voice`, 502);
  }

  // Pick the first available number
  const chosen = candidates[0];
  const phoneNumber = chosen.phone_number;

  // �── STEP 2: Order the number ────────────────────────────────────────────────
  const orderBody = { phone_numbers: [{ phone_number: phoneNumber }] };
  const orderRes = await fetch(`${TELNYX_API}/number_orders`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(orderBody),
  });
  if (!orderRes.ok) {
    const err = await orderRes.text();
    console.error(`[provision-number] Telnyx order failed (${orderRes.status}): ${err}`);
    return jsonError("Number order failed", 502);
  }

  // Poll for order completion
  const orderJson = await orderRes.json();
  const orderId = orderJson?.data?.id;
  let numberId: string | null = null;
  if (orderId) {
    for (let i = 0; i < 12; i++) {
      await sleep(2000);
      const pollRes = await fetch(`${TELNYX_API}/number_orders/${orderId}`, { headers: authHeaders });
      if (!pollRes.ok) continue;
      const pollJson = await pollRes.json();
      const status = pollJson?.data?.status;
      if (status === "success") {
        numberId = pollJson?.data?.phone_numbers?.[0]?.id ?? null;
        break;
      }
      if (status === "failure") {
        console.error(`[provision-number] Number order ${orderId} failed`);
        return jsonError("Number order failed — no charge issued", 502);
      }
    }
    if (!numberId) {
      return jsonError("Number order timed out waiting for completion", 504);
    }
  } else {
    // Some orders complete synchronously; try direct lookup
    const numLookup = await fetch(`${TELNYX_API}/phone_numbers?filter[phone_number]=${phoneNumber}`, { headers: authHeaders });
    if (numLookup.ok) {
      const numJson = await numLookup.json();
      numberId = numJson?.data?.[0]?.id ?? null;
    }
    if (!numberId) return jsonError("Number ordered but could not resolve ID", 502);
  }

  // ╕── STEP 3: Create per-shop messaging profile ──────────────────────────────
  const profileName = `sprintai-${shopId.slice(0, 9)}-${shop.name?.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 20) ?? "shop"}`;
  const profileBody = {
    name: profileName,
    webhook_url: chatSmsWebhook,
    enabled: true,
  };
  const profileRes = await fetch(`${TELNYX_API}/messaging_profiles`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(profileBody),
  });
  if (!profileRes.ok) {
    const err = await profileRes.text();
    console.error(`[provision-number] Profile create failed (${profileRes.status}): ${err}`);
    return jsonError("Failed to create messaging profile", 502);
  }
  const profileJson = await profileRes.json();
  const profileId: string = profileJson?.data?.id;
  if (!profileId) return jsonError("Messaging profile created but no ID returned", 502);

  // ╕── STEP 4: Assign number to profile ────────────────────────────────────────
  const assignRes = await fetch(`${TELNYX_API}/messaging_profiles/${profileId}/phone_numbers`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({ phone_numbers: [{ id: numberId }] }),
  });
  if (!assignRes.ok) {
    const err = await assignRes.text();
    console.error(`[provision-number] Assign number to profile failed (${assignRes.status}): ${err}`);
    // Non-fatal: number exists, profile exists. Can recover manually.
  }

  // ╕── STEP 5: Persist ────────────────────────────────────────────────────────
  await supabase.from("shops").update({
    phone_number_e164: phoneNumber,
    reply_from_e164: phoneNumber,
    telnyx_number_id: numberId,
    telnyx_messaging_profile_id: profileId,
    twilio_number_sid: null,  // clear Twilio remnants
    updated_at: new Date().toISOString(),
  }).eq("id", shopId);

  await supabase.from("number_provision_log").insert({
    shop_id: shopId,
    phone_e164: phoneNumber,
    provider: "telnyx",
    telnyx_number_id: numberId,
    telnyx_profile_id: profileId,
    test_mode: testMode,
    provisioned_on: today,
  });

  console.log(`[provision-number] Shop ${shopId}: provisioned ${phoneNumber} (number=${numberId}, profile=${profileId})`);

  return jsonResponse({
    ok: true,
    phone_number_e164: phoneNumber,
    telnyx_number_id: numberId,
    telnyx_messaging_profile_id: profileId,
    webhook: chatSmsWebhook,
    area_code: ndc,
    pending_campaign_assignment: true,
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(b: unknown, status = 200): Response {
  return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}
function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}