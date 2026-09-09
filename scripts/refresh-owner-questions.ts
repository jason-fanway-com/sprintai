/**
 * Owner-questions refresh (2026-09-08). Reusable, any shop — the general
 * fix for the gap a real NJB incident exposed: `scripts/njb-infer-only-*.ts`
 * and compile-menu/index.ts's own infer step can only INSERT a brand-new
 * (scope_type, scope_id, slot_key) question. Neither can notice that an
 * existing PENDING row's items_affected/question_text/priority changed, or
 * that its key stopped being produced by a fresh computation entirely — a
 * normalize.ts parser fix left exactly that: 3 NJB bread questions with
 * inflated items_affected and one (Omelette & Egg Platters/toast) that
 * should have been deleted, all sitting stale until caught and fixed by
 * hand. `planOwnerQuestionsRefresh` (../supabase/functions/_shared/
 * compile-menu.ts) is the pure decision function; this script is the I/O
 * shell around it — same split as njb-infer-only-20260907.ts.
 *
 * THE INVARIANT: only ever touches rows with status='pending'. A row an
 * owner has already answered, dismissed, or been asked is never read for
 * diffing, let alone updated or deleted — see planOwnerQuestionsRefresh's
 * own header/tests for the exact contract this executes.
 *
 * Dry-run by default — prints the plan (update/delete counts + full detail)
 * without writing anything. Pass --apply to actually execute it. Deliberately
 * NOT wired into compile-menu/index.ts's live compile path: that runs on
 * every shop's every compile (including already-live Vito's/Zio's), and
 * auto-applying a refresh there is a bigger, separate decision than building
 * the reusable function itself.
 *
 * Usage: set -a; source ~/.openclaw/.secrets; set +a
 *        SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *        SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *        deno run --allow-env --allow-net scripts/refresh-owner-questions.ts <shop_id> [--apply]
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  buildOwnerQuestionSummaries,
  planOwnerQuestionsRefresh,
  type ExistingOwnerQuestionRow,
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
const shopId = Deno.args.find(a => !a.startsWith("--"));
const apply = Deno.args.includes("--apply");
if (!shopId) {
  console.error("Usage: deno run --allow-env --allow-net refresh-owner-questions.ts <shop_id> [--apply]");
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
console.log(`shop_id=${shopId} menu_id=${menuId} mode=${apply ? "APPLY" : "dry-run"}`);

const itemRows = await fetchAllRows<any>(() =>
  supabase.from("menu_items")
    .select("id, menu_id, name, description, display_name, category, price_cents, size_label, active, price_provenance, product_key, import_key")
    .eq("menu_id", menuId).eq("active", true)
    .order("display_order", { ascending: true }).order("id", { ascending: true }),
);
console.log(`active menu_items: ${itemRows.length}`);
if (itemRows.length === 0) { console.log("No active items — nothing to refresh."); Deno.exit(0); }

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
const existingRows: ExistingOwnerQuestionRow[] = ((questionRows ?? []) as any[]).map(q => ({
  id: q.id,
  scope_type: q.scope_type,
  scope_id: q.scope_id,
  slot_key: q.slot_key,
  status: q.status,
  question_text: q.question_text,
  items_affected: q.items_affected,
  priority: q.priority,
  blocking: q.blocking,
  proposal: q.proposal ?? null,
}));
console.log(`existing owner_questions rows: ${existingRows.length} (${existingRows.filter(r => r.status === "pending").length} pending)`);

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

const plan = planOwnerQuestionsRefresh(existingRows, freshDrafts);
console.log(`\nplan: ${plan.toUpdate.length} to update, ${plan.toDelete.length} to delete`);

for (const u of plan.toUpdate) {
  const before = existingRows.find(r => r.id === u.id)!;
  console.log(`  UPDATE [${before.scope_id}]/${before.slot_key}: items_affected ${before.items_affected} -> ${u.items_affected}, priority ${before.priority} -> ${u.priority}`);
}
for (const d of plan.toDelete) {
  const before = existingRows.find(r => r.id === d.id)!;
  console.log(`  DELETE [${before.scope_id}]/${before.slot_key} (items_affected was ${before.items_affected}) -- no longer produced by a fresh computation`);
}

if (!apply) {
  console.log("\nDry run only — no writes made. Re-run with --apply to execute this plan.");
  Deno.exit(0);
}

if (plan.toUpdate.length === 0 && plan.toDelete.length === 0) {
  console.log("\nNothing to apply.");
  Deno.exit(0);
}

for (const u of plan.toUpdate) {
  const { error } = await supabase.from("owner_questions").update({
    question_text: u.question_text,
    items_affected: u.items_affected,
    priority: u.priority,
    blocking: u.blocking,
    proposal: u.proposal,
  }).eq("id", u.id).eq("status", "pending"); // belt-and-suspenders: never update a row that stopped being pending between read and write
  if (error) { console.error(`update failed for ${u.id}:`, error.message); Deno.exit(1); }
}
for (const d of plan.toDelete) {
  const { error } = await supabase.from("owner_questions").delete().eq("id", d.id).eq("status", "pending");
  if (error) { console.error(`delete failed for ${d.id}:`, error.message); Deno.exit(1); }
}
console.log(`\nApplied: ${plan.toUpdate.length} updated, ${plan.toDelete.length} deleted.`);
console.log("DONE. No menu_items, option_groups, option_choices, or lexicon rows were touched by this script.");
