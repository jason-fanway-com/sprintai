/**
 * SprintAI daily-reset Edge Function
 * Cron: runs daily (scheduled via Supabase cron or external scheduler).
 *
 * Actions:
 *   - Delete specials whose active_date is in the past (yesterday or older).
 *   - Clear expired delivery pauses (delivery_paused_until < now).
 *   - Log activity to admin_action_log for audit trail.
 *
 * Invoked by external scheduler (e.g., GitHub Actions, pg_cron) via POST to
 * /functions/v1/daily-reset with a shared secret.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1\/daily-reset/, "").replace(/^\/daily-reset/, "");

  // Health check
  if (req.method === "GET" && (path === "/" || path === "/health")) {
    return jsonResponse({ status: "ok", service: "daily-reset" });
  }

  // Auth: require shared secret
  const authHeader = req.headers.get("Authorization");
  const expectedSecret = Deno.env.get("DAILY_RESET_SECRET") ?? "";
  if (!expectedSecret) {
    console.error("[daily-reset] DAILY_RESET_SECRET not configured");
    return jsonResponse({ error: "Not configured" }, 500);
  }
  if (!authHeader || authHeader !== `Bearer ${expectedSecret}`) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const results: Record<string, unknown> = {};
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // ── 1. Clean expired specials ──────────────────────────────────────────────
  const { count: specialsDeleted, error: specErr } = await supabase
    .from("specials")
    .delete({ count: "exact" })
    .lt("active_date", today);

  if (specErr) {
    console.error("[daily-reset] Failed to clean specials:", specErr);
    results.specials_error = specErr.message;
  } else {
    results.specials_cleaned = specialsDeleted ?? 0;
    console.log(`[daily-reset] Cleaned ${specialsDeleted} expired specials`);
  }

  // ── 2. Clear expired delivery pauses ──────────────────────────────────────
  const now = new Date().toISOString();
  const { count: pausesCleared, error: pauseErr } = await supabase
    .from("shops")
    .update(
      { delivery_paused_until: null, delivery_pause_reason: null, delivery_enabled: true },
      { count: "exact" },
    )
    .not("delivery_paused_until", "is", null)
    .lt("delivery_paused_until", now);

  if (pauseErr) {
    console.error("[daily-reset] Failed to clear delivery pauses:", pauseErr);
    results.pauses_error = pauseErr.message;
  } else {
    results.delivery_pauses_cleared = pausesCleared ?? 0;
    console.log(`[daily-reset] Cleared ${pausesCleared} expired delivery pauses`);
  }

  // ── 3. Log summary to admin_action_log (one entry per shop is too noisy;
  //        just log a system-level summary row with shop_id=null) ────────────
  // Skip for now — admin_action_log requires a shop_id FK. This can be
  // extended later with a system-level log table.

  console.log("[daily-reset] Complete:", JSON.stringify(results));
  return jsonResponse({ ok: true, ...results });
});