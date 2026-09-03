/**
 * campaign-status-reader Edge Function
 *
 * READ-ONLY against Telnyx. Polls the phone_number_campaigns mapping status
 * for shops with campaign_assignment_status = 'submitted' and advances them
 * to 'approved' when both tmobileNumberMappingStatus AND
 * nonTmobileNumberMappingStatus == 'ADDED'.
 *
 * Invoked by external scheduler (same pattern as daily-reset). Can run
 * independently or be called after daily-reset in the same crontab.
 *
 * POST /functions/v1/campaign-status-reader
 * Authorization: Bearer <daily_reset_secret>
 *
 * NEVER writes to Telnyx. The campaign CSMB9HG is TCR_ACCEPTED and must
 * not be modified.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TELNYX_API = "https://api.telnyx.com/v2";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1\/campaign-status-reader/, "").replace(/^\/campaign-status-reader/, "");

  // Health check
  if (req.method === "GET" && (path === "/" || path === "/health")) {
    return jsonResponse({ status: "ok", service: "campaign-status-reader" });
  }

  // Auth: require shared secret (same as daily-reset)
  const authHeader = req.headers.get("Authorization");
  const expectedSecret = Deno.env.get("DAILY_RESET_SECRET") ?? "";
  if (!expectedSecret) {
    console.error("[campaign-status-reader] DAILY_RESET_SECRET not configured");
    return jsonResponse({ error: "Not configured" }, 500);
  }
  if (!authHeader || authHeader !== `Bearer ${expectedSecret}`) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const telnyxKey = Deno.env.get("TELNYX_API_KEY") ?? "";
  if (!telnyxKey) {
    console.error("[campaign-status-reader] TELNYX_API_KEY not configured");
    return jsonResponse({ error: "Telnyx API key not configured" }, 500);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const authHeaders = {
    "Authorization": `Bearer ${telnyxKey}`,
    "Content-Type": "application/json",
  };

  const now = new Date().toISOString();

  // Fetch all shops with campaign_assignment_status = 'submitted'
  const { data: submittedShops, error: fetchErr } = await supabase
    .from("shops")
    .select("id, name, phone_number_e164, campaign_id")
    .eq("campaign_assignment_status", "submitted");

  if (fetchErr) {
    console.error("[campaign-status-reader] Failed to fetch submitted shops:", fetchErr);
    return jsonResponse({ error: "Failed to fetch submitted shops", detail: fetchErr.message }, 500);
  }

  if (!submittedShops || submittedShops.length === 0) {
    console.log("[campaign-status-reader] No shops in 'submitted' status — nothing to poll.");
    return jsonResponse({ ok: true, read: 0, advanced: 0 });
  }

  console.log(`[campaign-status-reader] Polling mapping status for ${submittedShops.length} submitted shops`);

  let advanced = 0;
  const skipped: string[] = [];

  for (const shop of submittedShops) {
    const phoneNumber = shop.phone_number_e164;
    if (!phoneNumber) {
      console.warn(`[campaign-status-reader] Shop ${shop.id} has status='submitted' but no phone_number_e164 — skipping`);
      skipped.push(shop.id);
      continue;
    }

    try {
      // READ-ONLY: GET phone_number_campaigns mapping status
      const mapRes = await fetch(
        `${TELNYX_API}/10dlc/phone_number_campaigns/${encodeURIComponent(phoneNumber)}`,
        { headers: authHeaders },
      );

      if (!mapRes.ok) {
        console.warn(
          `[campaign-status-reader] Telnyx mapping lookup failed for ${phoneNumber} ` +
          `(shop ${shop.id}): HTTP ${mapRes.status}`,
        );
        skipped.push(shop.id);
        continue;
      }

      const mapJson = await mapRes.json();
      const records = mapJson?.data;
      if (!Array.isArray(records) || records.length === 0) {
        console.warn(
          `[campaign-status-reader] No campaign mapping records for ${phoneNumber} ` +
          `(shop ${shop.id}) — number may not be assigned to any campaign yet`,
        );
        skipped.push(shop.id);
        continue;
      }

      // Check each mapping record for this number
      let allAdded = true;
      for (const rec of records) {
        const tmoStatus = rec.tmobileNumberMappingStatus;
        const nonTmoStatus = rec.nonTmobileNumberMappingStatus;
        if (tmoStatus !== "ADDED" || nonTmoStatus !== "ADDED") {
          allAdded = false;
          console.log(
            `[campaign-status-reader] Shop ${shop.id} (${phoneNumber}): ` +
            `tmobile=${tmoStatus}, nonTmobile=${nonTmoStatus} — not yet ready`,
          );
          break;
        }
      }

      if (allAdded) {
        // Advance to approved
        const { error: upErr } = await supabase
          .from("shops")
          .update({
            campaign_assignment_status: "approved",
            campaign_assignment_checked_at: now,
          })
          .eq("id", shop.id);

        if (upErr) {
          console.error(
            `[campaign-status-reader] Failed to update shop ${shop.id} to approved: ${upErr.message}`,
          );
          skipped.push(shop.id);
        } else {
          advanced++;
          console.log(
            `[campaign-status-reader] Shop ${shop.id} (${phoneNumber}): both mappings ADDED → approved`,
          );
        }
      }
    } catch (err) {
      console.error(
        `[campaign-status-reader] Error polling mapping for shop ${shop.id}: ` +
        (err instanceof Error ? err.message : String(err)),
      );
      skipped.push(shop.id);
    }
  }

  console.log(
    `[campaign-status-reader] Complete: ${submittedShops.length} read, ` +
    `${advanced} advanced to approved, ${skipped.length} skipped/errored`,
  );

  return jsonResponse({
    ok: true,
    read: submittedShops.length,
    advanced,
    skipped: skipped.length > 0 ? skipped.length : 0,
  });
});