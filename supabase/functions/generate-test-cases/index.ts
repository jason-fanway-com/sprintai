/**
 * generate-test-cases Edge Function
 *
 * Wraps the shared test-suite generator so it can be called asynchronously
 * from the onboarding wizard (fire-and-forget), the admin dashboard "Regenerate
 * Test Cases" button, or the pre-flight CLI.
 *
 * POST { shop_id: string }
 * → generates menu-derived + library + conversational cases for the shop
 * → returns summary (counts, shop info, any generation errors)
 *
 * This is a read-only generator. It does NOT run the test suite or call any
 * LLM — those happen separately via the CLI (scripts/test-suite/run.ts).
 *
 * Tenant isolation: verifies shop exists; no cross-tenant data exposed.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { generateCases } from "../_shared/test-suite/generator.ts";

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

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonError("Server configuration error — missing Supabase credentials", 500);
  }

  try {
    // ── Enqueue a pending test run (idempotent) ──────────────────────
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Resolve tenant_id from the shop
    const { data: shopData, error: shopErr } = await supabase
      .from("shops")
      .select("id, tenant_id, name")
      .eq("id", shopId)
      .single();

    if (shopErr || !shopData) {
      return jsonError(`Shop ${shopId} not found`, 404);
    }

    // Idempotent: skip enqueue if a pending or running row already exists
    const { data: existing, error: existingErr } = await supabase
      .from("test_run_queue")
      .select("id, status")
      .eq("shop_id", shopId)
      .in("status", ["pending", "running"])
      .limit(1);

    if (existingErr) {
      console.error("test_run_queue lookup failed:", existingErr);
      return jsonError("Failed to check queue status", 500);
    }

    let queueId: string | null = null;
    if (!existing || existing.length === 0) {
      const { data: inserted, error: insertErr } = await supabase
        .from("test_run_queue")
        .insert({
          shop_id: shopId,
          tenant_id: shopData.tenant_id,
          status: "pending",
          reason: "onboarding",
        })
        .select("id")
        .single();

      if (insertErr) {
        console.error("test_run_queue insert failed:", insertErr);
        return jsonError("Failed to enqueue test run", 500);
      }
      queueId = inserted.id;
    } else {
      queueId = existing[0].id;
    }

    const result = await generateCases({
      supabaseUrl,
      serviceRoleKey,
      shopId,
    });

    return jsonResponse({
      ok: true,
      shop: result.shop,
      menuItemCount: result.menuItemCount,
      totalCases: result.cases.length,
      derivedCount: result.derivedCount,
      libraryCount: result.libraryCount,
      conversationalCount: result.conversationalCount,
      queueId,
      queuedStatus: !existing || existing.length === 0 ? "new" : "already_queued",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("generate-test-cases failed:", message);
    return jsonError(`Failed to generate test cases: ${message}`, 500);
  }
});

function jsonResponse(b: unknown, status = 200): Response {
  return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}
function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}