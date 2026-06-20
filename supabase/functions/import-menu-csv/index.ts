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
 * Returns: { ok, menu_id, inserted, updated, deactivated, skipped_owner_edited, no_op }
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
  DesiredItem,
  ExistingItem,
} from "../../../menu-pipeline/core/import-plan.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

  let inserted = 0, updated = 0, skippedOwnerEdited = 0, deactivated = 0;

  // -- Inserts -----------------------------------------------------------------
  for (const d of diff.toInsert) {
    const itemId = await upsertItem(supabase, menuId, d, null);
    if (itemId) { await syncGroups(supabase, itemId, d); inserted++; }
  }

  // -- Updates (skip owner-edited) ---------------------------------------------
  for (const u of diff.toUpdate) {
    if (u.skippedOwnerEdited) { skippedOwnerEdited++; continue; }
    await upsertItem(supabase, menuId, u.desired, u.id);
    await syncGroups(supabase, u.id, u.desired);
    // Re-activate if it was previously deactivated.
    await supabase.from("menu_items").update({ active: true }).eq("id", u.id);
    updated++;
  }

  // -- Deactivations (never hard-delete) ---------------------------------------
  if (diff.toDeactivate.length) {
    await supabase.from("menu_items").update({ active: false }).in("id", diff.toDeactivate);
    deactivated = diff.toDeactivate.length;
  }

  return jsonResponse({
    ok: true, menu_id: menuId, no_op: false,
    inserted, updated, deactivated, skipped_owner_edited: skippedOwnerEdited,
  });
});

// ---- DB helpers ------------------------------------------------------------

async function upsertItem(
  // deno-lint-ignore no-explicit-any
  supabase: any, menuId: string, d: DesiredItem, existingId: string | null,
): Promise<string | null> {
  const row = {
    menu_id: menuId,
    name: d.name,
    description: d.description || null,
    price_cents: d.priceCents ?? 0,
    category: d.category || "Uncategorized",
    size_label: d.sizeLabel || null,
    import_key: d.importKey,
    display_order: d.displayOrder,
    active: true,
    is_available: true,
  };
  if (existingId) {
    await supabase.from("menu_items").update(row).eq("id", existingId);
    return existingId;
  }
  const { data, error } = await supabase.from("menu_items").insert(row).select("id").single();
  if (error) { console.error("[import-menu-csv] item insert failed:", error.message); return null; }
  return data.id as string;
}

/**
 * Sync option groups + choices for an item by import_key (diff-based).
 * Replaces choices/groups that came from import; safe because option rows are
 * machine-owned (not the owner-edited menu_item).
 */
async function syncGroups(
  // deno-lint-ignore no-explicit-any
  supabase: any, itemId: string, d: DesiredItem,
): Promise<void> {
  const desiredGroupKeys = new Set(d.groups.map((g) => g.importKey));

  // Existing groups for this item.
  const { data: exGroups } = await supabase
    .from("option_groups").select("id, import_key").eq("menu_item_id", itemId);

  // Deactivate-by-delete groups no longer desired (machine-owned, safe to remove).
  const staleGroupIds = (exGroups ?? [])
    .filter((g: { import_key: string | null }) => g.import_key && !desiredGroupKeys.has(g.import_key))
    .map((g: { id: string }) => g.id);
  if (staleGroupIds.length) {
    await supabase.from("option_choices").delete().in("option_group_id", staleGroupIds);
    await supabase.from("option_groups").delete().in("id", staleGroupIds);
  }

  const exByKey = new Map<string, string>();
  for (const g of exGroups ?? []) if (g.import_key) exByKey.set(g.import_key, g.id);

  for (const g of d.groups) {
    let groupId = exByKey.get(g.importKey);
    const groupRow = {
      menu_item_id: itemId, name: g.name, required: g.required,
      min_select: g.minSelect, max_select: g.maxSelect,
      display_order: g.displayOrder, import_key: g.importKey,
    };
    if (groupId) {
      await supabase.from("option_groups").update(groupRow).eq("id", groupId);
    } else {
      const { data, error } = await supabase.from("option_groups").insert(groupRow).select("id").single();
      if (error || !data) { console.error("[import-menu-csv] group insert failed:", error?.message); continue; }
      groupId = data.id as string;
    }

    // Sync choices for this group.
    const desiredChoiceKeys = new Set(g.choices.map((c) => c.importKey));
    const { data: exChoices } = await supabase
      .from("option_choices").select("id, import_key").eq("option_group_id", groupId);
    const staleChoiceIds = (exChoices ?? [])
      .filter((c: { import_key: string | null }) => c.import_key && !desiredChoiceKeys.has(c.import_key))
      .map((c: { id: string }) => c.id);
    if (staleChoiceIds.length) await supabase.from("option_choices").delete().in("id", staleChoiceIds);

    const exChoiceByKey = new Map<string, string>();
    for (const c of exChoices ?? []) if (c.import_key) exChoiceByKey.set(c.import_key, c.id);

    for (const c of g.choices) {
      const choiceRow = {
        option_group_id: groupId, name: c.name, price_cents: c.priceCents,
        display_order: c.displayOrder, import_key: c.importKey,
      };
      const cid = exChoiceByKey.get(c.importKey);
      if (cid) await supabase.from("option_choices").update(choiceRow).eq("id", cid);
      else await supabase.from("option_choices").insert(choiceRow);
    }
  }
}

// ---- response helpers ------------------------------------------------------

function jsonResponse(b: unknown, status = 200): Response {
  return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}
function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
