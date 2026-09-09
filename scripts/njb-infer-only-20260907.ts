/**
 * NJB infer-only run (2026-09-07, Jason — real carrier number, hard rules
 * apply). Mirrors compile-menu/index.ts's classify/infer step (§3 stages
 * 4-5, item 3/../_shared/archetypes.ts) EXACTLY, verbatim, up to and
 * including the owner_questions insert — then STOPS. Does not import or
 * call compile-menu/index.ts itself (that function always continues past
 * this point into the write-back half).
 *
 * HARD RULES (Jason, explicit):
 *   1. Writes ONLY to owner_questions (insert-if-not-exists, same key as
 *      compile-menu/index.ts: scope_type|scope_id|slot_key).
 *   2. NEVER writes option_groups/option_choices — those are read-only
 *      snapshot input here, exactly as compile-menu/index.ts treats them
 *      for this same step.
 *   3. NEVER writes menu_items (no bot_state/ask_plan/display_name/
 *      product_key update) and NEVER writes lexicon. Both are compile-menu's
 *      write-back half — not reachable from this script at all, since
 *      compileMenu()/applyOverrides() are never even called here.
 *   4. This is compile-menu's real write-back mechanism NOT invoked against
 *      NJB's shop_id — no HTTP call to the deployed function, no local
 *      capture-handler invocation, nothing. This script is the entire
 *      extent of NJB write activity tonight.
 *
 * Usage: set -a; source ~/.openclaw/.secrets; set +a
 *        SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *        SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *        deno run --allow-env --allow-net scripts/njb-infer-only-20260907.ts <shop_id>
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  buildOwnerQuestionSummaries,
  type InferSourceItem,
} from "../supabase/functions/_shared/compile-menu.ts";
import type { ExtractedGroup } from "../supabase/functions/_shared/archetypes.ts";
import { normalizeMenuItems, pickDescriptionSlot, pickSideDescriptionSlot, type RawMenuItemRow } from "../supabase/functions/_shared/normalize.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  Deno.exit(1);
}
const shopId = Deno.args[0];
if (!shopId) {
  console.error("Usage: deno run --allow-env --allow-net njb-infer-only-20260907.ts <shop_id>");
  Deno.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const FETCH_PAGE_SIZE = 1000;
async function fetchAllRows<T>(
  queryBuilder: () => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await (queryBuilder() as any).range(from, from + FETCH_PAGE_SIZE - 1);
    if (error) throw new Error(`fetchAllRows failed at offset ${from}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < FETCH_PAGE_SIZE) break;
    from += FETCH_PAGE_SIZE;
  }
  return rows;
}
const IN_BATCH_SIZE = 150;
async function fetchAllRowsBatchedIn<T, K>(
  ids: K[],
  queryBuilder: (batch: K[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += IN_BATCH_SIZE) {
    const batch = ids.slice(i, i + IN_BATCH_SIZE);
    rows.push(...await fetchAllRows(() => queryBuilder(batch)));
  }
  return rows;
}

const { data: menu, error: menuErr } = await supabase
  .from("menus").select("id, shop_id").eq("shop_id", shopId)
  .order("created_at", { ascending: false }).limit(1).maybeSingle();
if (menuErr || !menu) { console.error("menu lookup failed:", menuErr?.message ?? "no menu found"); Deno.exit(1); }
const menuId = menu.id;
console.log(`shop_id=${shopId} menu_id=${menuId}`);

const itemRows = await fetchAllRows<any>(() =>
  supabase.from("menu_items")
    .select("id, menu_id, name, description, display_name, category, price_cents, size_label, active, price_provenance, product_key, import_key")
    .eq("menu_id", menuId).eq("active", true)
    .order("display_order", { ascending: true }).order("id", { ascending: true }),
);
console.log(`active menu_items: ${itemRows.length}`);
if (itemRows.length === 0) { console.log("No active items — nothing to infer."); Deno.exit(0); }

const itemIds = itemRows.map((i: any) => i.id);
const groupRows = await fetchAllRowsBatchedIn<any, string>(itemIds, batch =>
  supabase.from("option_groups")
    .select("id, menu_item_id, name, kind, slot_key, min_select, max_select, kitchen_critical, price_critical, default_choice_id, ask_mode, provenance, display_order, import_key")
    .in("menu_item_id", batch)
    .order("display_order", { ascending: true }).order("id", { ascending: true }),
);
console.log(`option_groups (read-only, NOT written): ${groupRows.length}`);

const groupIds = groupRows.map((g: any) => g.id);
const choiceRows = groupIds.length > 0
  ? await fetchAllRowsBatchedIn<any, string>(groupIds, batch =>
      supabase.from("option_choices")
        .select("id, option_group_id, name, display_name, price_cents, is_default, provenance, import_key")
        .in("option_group_id", batch)
        .order("display_order", { ascending: true }).order("id", { ascending: true }),
    )
  : [];
console.log(`option_choices (read-only, NOT written): ${choiceRows.length}`);

const { data: questionRows } = await supabase.from("owner_questions").select("*").eq("menu_id", menuId);
console.log(`existing owner_questions rows before this run: ${(questionRows ?? []).length}`);

const choicesByGroup = new Map<string, any[]>();
for (const c of choiceRows) {
  const list = choicesByGroup.get(c.option_group_id);
  if (list) list.push(c); else choicesByGroup.set(c.option_group_id, [c]);
}
const groupsByItem = new Map<string, any[]>();
for (const g of groupRows) {
  const list = groupsByItem.get(g.menu_item_id);
  if (list) list.push(g); else groupsByItem.set(g.menu_item_id, [g]);
}

const rawForNormalize: RawMenuItemRow[] = itemRows.map((r: any) => ({
  id: r.id, name: r.name, description: r.description, category: r.category,
  price_cents: r.price_cents, size_label: r.size_label,
}));
const normalizedById = new Map(normalizeMenuItems(rawForNormalize).map(n => [n.id, n]));

const inferSourceItems: InferSourceItem[] = itemRows.map((row: any) => {
  const normalized = normalizedById.get(row.id);
  const nameSlot = normalized?.slots.find(s => s.source === "name");
  const descriptionSlot = normalized ? pickDescriptionSlot(normalized) : undefined;
  const sideSlot = normalized ? pickSideDescriptionSlot(normalized) : undefined;
  const extractedGroups: ExtractedGroup[] = (groupsByItem.get(row.id) ?? []).map((g: any) => ({
    name: g.name,
    required: g.kind === "slot",
    choiceNames: (choicesByGroup.get(g.id) ?? []).map((c: any) => c.display_name ?? c.name),
    provenance: g.provenance,
  }));
  return {
    id: row.id, name: row.name, description: row.description, category: row.category,
    productKey: normalized?.product_key ?? row.product_key,
    extractedGroups,
    nameSlotChoices: nameSlot ? nameSlot.choices.map((c: any) => c.display_name) : null,
    descriptionSlotChoices: descriptionSlot ? descriptionSlot.choices.map((c: any) => c.display_name) : null,
    sideSlotChoices: sideSlot ? sideSlot.choices.map((c: any) => c.display_name) : null,
    priceCents: row.price_cents,
  };
});

const categoryQuestionSummaries = buildOwnerQuestionSummaries(inferSourceItems);
const freshDrafts = categoryQuestionSummaries.flatMap(s => s.questions);
console.log(`freshly-computed question drafts: ${freshDrafts.length}`);

const existingQuestionKeys = new Set(
  ((questionRows ?? []) as any[]).map(q => `${q.scope_type}|${q.scope_id}|${q.slot_key ?? ""}`),
);
const newDrafts = freshDrafts.filter(
  d => !existingQuestionKeys.has(`${d.scope_type}|${d.scope_id}|${d.slot_key}`),
);
console.log(`new drafts to insert (not already present): ${newDrafts.length}`);

if (newDrafts.length > 0) {
  const { data: inserted, error: insertError } = await supabase
    .from("owner_questions")
    .insert(
      newDrafts.map(d => ({
        shop_id: shopId, menu_id: menuId,
        scope_type: d.scope_type, scope_id: d.scope_id, slot_key: d.slot_key,
        kind: d.kind, question_text: d.question_text, proposal: d.proposal,
        blocking: d.blocking, priority: d.priority, items_affected: d.items_affected,
      })),
    )
    .select();
  if (insertError) {
    console.error("owner_questions insert error:", insertError.message);
    Deno.exit(1);
  }
  console.log(`inserted ${inserted?.length ?? 0} new owner_questions rows.`);
} else {
  console.log("Nothing new to insert.");
}

console.log("DONE. No menu_items, option_groups, option_choices, or lexicon rows were written by this script.");
