/**
 * import-menu-csv Edge Function — Stage B applier.
 *
 * POST application/json:
 *   { shop_id: string, menu_name?: string, csv: string }
 *
 * Takes a CONFIRMED canonical 7-column CSV and imports it into the live schema
 * (menu_items + option_groups + option_choices) IDEMPOTENTLY and DIFF-BASED.
 *
 * Unlike parse-menu-pdf (which deletes all menus on every upload), this:
 *   - resolves/creates a single 'csv'-source menu for the shop,
 *   - skips entirely if the CSV's import_hash matches the menu's stored hash (no-op),
 *   - upserts items by stable import_key, preserving owner-edited rows,
 *   - DEACTIVATES (active=false) items no longer present — never hard-deletes,
 *   - enforces referential integrity (fails loudly) before writing.
 *
 * Returns: { ok, menu_id, inserted, updated, deactivated, skipped_owner_edited,
 *            skipped_owner_edited_option_groups, skipped_owner_edited_option_choices, no_op }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { parseCanonicalCsv } from "../../../menu-pipeline/core/csv.ts";
import { validateRows } from "../../../menu-pipeline/core/validate.ts";
import { assertValid } from "../../../menu-pipeline/core/validate.ts";
import {
  buildImportPlan,
  diffItems,
} from "../../../menu-pipeline/core/import-plan.ts";
import type {
  ExistingItem,
} from "../../../menu-pipeline/core/import-plan.ts";
import { applyToUpdate, syncGroups, upsertItem } from "./apply.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonError("Method Not Allowed", 405);

  let body: { shop_id?: string; menu_name?: string; csv?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("Expected JSON body { shop_id, menu_name?, csv }");
  }
  const shop_id = body.shop_id;
  const csv = body.csv;
  if (!shop_id) return jsonError("shop_id is required");
  if (!csv) return jsonError("csv is required");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  // -- Verify shop -------------------------------------------------------------
  const { data: shop, error: shopErr } = await supabase
    .from("shops").select("id, name").eq("id", shop_id).single();
  if (shopErr || !shop) return jsonError("Shop not found", 404);

  // -- Parse + validate (referential integrity is HARD here) -------------------
  let plan;
  try {
    const rows = parseCanonicalCsv(csv);
    assertValid(validateRows(rows, { strictReferences: true }), shop.name);
    plan = buildImportPlan(rows, body.menu_name ?? `${shop.name} Menu`);
  } catch (err) {
    return jsonError("Import rejected: " + (err instanceof Error ? err.message : String(err)), 422);
  }

  // -- Resolve the shop's csv-source menu (single canonical menu) --------------
  const { data: existingMenu } = await supabase
    .from("menus").select("id, import_hash").eq("shop_id", shop_id).eq("source", "csv").maybeSingle();

  let menuId = existingMenu?.id as string | undefined;

  // No-op if hash matches.
  if (existingMenu && existingMenu.import_hash === plan.importHash) {
    return jsonResponse({ ok: true, menu_id: menuId, no_op: true, reason: "import_hash unchanged" });
  }

  if (!menuId) {
    const { data: menu, error: menuErr } = await supabase
      .from("menus").insert({
        shop_id, name: plan.menuName, source: "csv",
        import_hash: plan.importHash, effective_from: new Date().toISOString(),
      }).select("id").single();
    if (menuErr || !menu) return jsonError("Failed to create menu: " + (menuErr?.message ?? "unknown"), 500);
    menuId = menu.id;
  } else {
    await supabase.from("menus").update({ import_hash: plan.importHash }).eq("id", menuId);
  }

  // -- Load existing items for diff -------------------------------------------
  const { data: existingItemsRaw } = await supabase
    .from("menu_items").select("id, import_key, owner_edited, active").eq("menu_id", menuId);
  const existing: ExistingItem[] = (existingItemsRaw ?? []).map((r: { id: string; import_key: string | null; owner_edited: boolean }) => ({
    id: r.id, importKey: r.import_key, ownerEdited: r.owner_edited,
  }));

  const diff = diffItems(plan.items, existing);

  let inserted = 0, deactivated = 0;
  let skippedOwnerEditedGroups = 0, skippedOwnerEditedChoices = 0;

  // -- Inserts -----------------------------------------------------------------
  for (const d of diff.toInsert) {
    const itemId = await upsertItem(supabase, menuId, d, null);
    if (itemId) {
      const r = await syncGroups(supabase, itemId, d);
      skippedOwnerEditedGroups += r.skippedGroups;
      skippedOwnerEditedChoices += r.skippedChoices;
      inserted++;
    }
  }

  // -- Updates: content is skipped for owner-edited items, but every item in
  // this import is reactivated regardless (see apply.ts for rationale). -------
  const updateResult = await applyToUpdate(supabase, menuId, diff.toUpdate);
  const updated = updateResult.updated;
  const skippedOwnerEdited = updateResult.skippedOwnerEdited;
  skippedOwnerEditedGroups += updateResult.skippedOwnerEditedGroups;
  skippedOwnerEditedChoices += updateResult.skippedOwnerEditedChoices;

  // -- Deactivations (never hard-delete) ---------------------------------------
  if (diff.toDeactivate.length) {
    await supabase.from("menu_items").update({ active: false }).in("id", diff.toDeactivate);
    deactivated = diff.toDeactivate.length;
  }

  return jsonResponse({
    ok: true, menu_id: menuId, no_op: false,
    inserted, updated, deactivated, skipped_owner_edited: skippedOwnerEdited,
    skipped_owner_edited_option_groups: skippedOwnerEditedGroups,
    skipped_owner_edited_option_choices: skippedOwnerEditedChoices,
  });
});

// ---- response helpers ------------------------------------------------------

function jsonResponse(b: unknown, status = 200): Response {
  return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}
function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
