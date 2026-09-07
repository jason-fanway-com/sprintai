/**
 * Item 9 — read-only compile report for Not Just Bagels + Zio's Pizzeria
 * (docs/specs/2026-09-07-conversation-ready-menu-design.md §11 item 9).
 *
 * Report-only per Jason's sequencing change: SELECTs only, zero writes to
 * any table (menu_items, lexicon, owner_questions, option_groups — nothing).
 * This is deliberately NOT the compile-menu edge function (which writes
 * menu_items.bot_state/ask_plan + lexicon on every run) — it reuses the same
 * pure modules (normalize.ts item 2, archetypes.ts item 3, compile-menu.ts
 * item 4) against a live read of each shop's real data and prints/derives a
 * report without touching the DB.
 *
 * Fills the gap BLOCKED.txt's item 9 entry named: compile-menu.ts already
 * accepts PendingQuestion[] and blocks items on them (findBlockingQuestion),
 * but nothing yet calls archetypes.inferCategory and turns the result into
 * PendingQuestion[] — that caller is this script (report-only; the real
 * DB-writing caller, item 3's "infer" edge function, is separate future
 * work, not needed for tonight's report).
 *
 * Blocking is applied per-ITEM, not per-category: inferCategory returns
 * slotOutcomes per (item, slot), and only items whose outcome for a given
 * slot is 'needs_question' or 'proposed' are actually blocked by that
 * slot's question — an item already resolved via stated/default/not_
 * applicable is not blocked just for sharing a category with items that
 * need the question. This matters: e.g. NJB "Bagel With" is 13 items but
 * bagel_type/spread each affect only 11 — the other 2 must not be reported
 * blocked on a question that doesn't apply to them.
 *
 * Usage: set -a; source ~/.openclaw/.secrets; set +a
 *        deno run --allow-env --allow-net scripts/item-9-readonly-compile-report.ts
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { normalizeMenuItems, type RawMenuItemRow } from "../supabase/functions/_shared/normalize.ts";
import {
  inferCategory,
  buildCategoryCandidateGroups,
  type InferItemInput,
  type ExtractedGroup,
  type OwnerQuestionDraft,
  type CategoryPriceItem,
} from "../supabase/functions/_shared/archetypes.ts";
import {
  compileMenu,
  applyOverrides,
  type CompileItem,
  type CompileGroup,
  type CompileChoice,
  type PendingQuestion,
  type OverrideEntityType,
  type CompiledItem,
} from "../supabase/functions/_shared/compile-menu.ts";
import { itemEntityKey, groupEntityKey, choiceEntityKey } from "../supabase/functions/_shared/menu-entity-key.ts";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SPRINTAI_CHAT_SUPABASE_URL / SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY.");
  console.error("Run: set -a; source ~/.openclaw/.secrets; set +a");
  Deno.exit(1);
}

const SHOPS: Record<string, string> = {
  "Not Just Bagels": "b0000000-0000-0000-0000-000000000001",
  "Zio's Pizzeria": "2cba7b51-211c-4437-8910-1af4dcc03498",
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const PAGE_SIZE = 1000;
// A single `.in(col, ids)` filter with a few hundred UUIDs can exceed the
// underlying HTTP transport's request-size tolerance and fail outright
// (confirmed directly: 490 ids -> "TypeError: fetch failed" / "stream error
// detected"). Chunking keeps every single request small regardless of shop size.
const IN_CLAUSE_CHUNK_SIZE = 100;

// deno-lint-ignore no-explicit-any
async function fetchAllRows<T>(qb: () => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await (qb() as any).range(from, from + PAGE_SIZE - 1);
    if (error) {
      // Fail loud: a swallowed fetch error here previously returned a silently
      // truncated (sometimes empty) result set, which then read as real
      // blocking in the report instead of a fetch failure.
      throw new Error(`fetch failed: ${error.message ?? error}`);
    }
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

async function fetchRowsInIdBatches<T>(
  ids: string[],
  queryFor: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: any }>, // deno-lint-ignore no-explicit-any
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CLAUSE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + IN_CLAUSE_CHUNK_SIZE);
    rows.push(...await fetchAllRows(() => queryFor(chunk)));
  }
  return rows;
}

interface MenuItemRow {
  id: string; menu_id: string; name: string; description: string | null;
  display_name: string | null; category: string | null; price_cents: number;
  size_label: string | null; active: boolean; price_provenance: string;
  product_key: string | null; import_key: string | null;
}
interface OptionGroupRow {
  id: string; menu_item_id: string; name: string; kind: string; slot_key: string | null;
  min_select: number; max_select: number; kitchen_critical: boolean; price_critical: boolean;
  default_choice_id: string | null; ask_mode: string | null; provenance: string;
  display_order: number; import_key: string | null; required: boolean;
}
interface OptionChoiceRow {
  id: string; option_group_id: string; name: string; display_name: string | null;
  price_cents: number; is_default: boolean; provenance: string; import_key: string | null;
}
interface OverrideRow {
  entity_type: string; entity_key: string; field: string; value: unknown;
  actor: string; created_at: string;
}

interface ShopReport {
  shopName: string;
  shopId: string;
  itemsIn: number;      // total menu_items rows (active + inactive)
  activeItems: number;
  compiled: CompiledItem[];
  compileItems: CompileItem[];
  invariants: ReturnType<typeof compileMenu>["invariants"];
  drafts: (OwnerQuestionDraft & { category: string; archetype: string })[];
  categoriesFellToOther: number;
  totalCategories: number;
}

async function compileShop(shopName: string, shopId: string): Promise<ShopReport | null> {
  const { data: menus } = await supabase.from("menus").select("id").eq("shop_id", shopId).order("created_at", { ascending: false }).limit(1);
  const menuId = (menus as { id: string }[] | null)?.[0]?.id;
  if (!menuId) {
    console.error(`${shopName}: no menu found for shop_id ${shopId}`);
    return null;
  }

  const allItemRows = await fetchAllRows<MenuItemRow>(() =>
    supabase.from("menu_items")
      .select("id, menu_id, name, description, display_name, category, price_cents, size_label, active, price_provenance, product_key, import_key")
      .eq("menu_id", menuId)
      .order("id", { ascending: true }),
  );
  const itemRows = allItemRows.filter(r => r.active);
  if (itemRows.length === 0) {
    console.error(`${shopName}: zero active items`);
    return null;
  }

  const itemIds = itemRows.map(i => i.id);
  const groupRows = await fetchRowsInIdBatches<OptionGroupRow>(itemIds, chunk =>
    supabase.from("option_groups")
      .select("id, menu_item_id, name, kind, slot_key, min_select, max_select, kitchen_critical, price_critical, default_choice_id, ask_mode, provenance, display_order, import_key, required")
      .in("menu_item_id", chunk)
      .order("display_order", { ascending: true })
      .order("id", { ascending: true }),
  );
  const groupIds = groupRows.map(g => g.id);
  const choiceRows = groupIds.length > 0
    ? await fetchRowsInIdBatches<OptionChoiceRow>(groupIds, chunk =>
        supabase.from("option_choices")
          .select("id, option_group_id, name, display_name, price_cents, is_default, provenance, import_key")
          .in("option_group_id", chunk)
          .order("display_order", { ascending: true })
          .order("id", { ascending: true }),
      )
    : [];

  const [{ data: questionRows }, { data: overrideRows }] = await Promise.all([
    supabase.from("owner_questions").select("*").eq("menu_id", menuId),
    supabase.from("menu_overrides").select("entity_type, entity_key, field, value, actor, created_at").eq("menu_id", menuId),
  ]);

  const choicesByGroup = new Map<string, OptionChoiceRow[]>();
  for (const c of choiceRows) {
    const list = choicesByGroup.get(c.option_group_id);
    if (list) list.push(c); else choicesByGroup.set(c.option_group_id, [c]);
  }
  const groupsByItem = new Map<string, OptionGroupRow[]>();
  for (const g of groupRows) {
    const list = groupsByItem.get(g.menu_item_id);
    if (list) list.push(g); else groupsByItem.set(g.menu_item_id, [g]);
  }

  // Item 2 — real normalizer, same call compile-menu/index.ts makes.
  const rawForNormalize: RawMenuItemRow[] = itemRows.map(r => ({
    id: r.id, name: r.name, description: r.description, category: r.category,
    price_cents: r.price_cents, size_label: r.size_label,
  }));
  const normalizedById = new Map(normalizeMenuItems(rawForNormalize).map(n => [n.id, n]));

  // siblingCount from the REAL product_key the normalizer computed (not a
  // reimplementation) — size/count slots resolve from this, per archetypes.ts.
  const siblingCounts = new Map<string, number>();
  for (const it of itemRows) {
    const pk = normalizedById.get(it.id)?.product_key ?? `unfolded:${it.id}`;
    siblingCounts.set(pk, (siblingCounts.get(pk) ?? 0) + 1);
  }

  // Item 3 input: InferItemInput per item, using REAL extracted option_groups
  // (hand-built, if any) and the REAL normalizer's name/description slots.
  const inferInputs: InferItemInput[] = itemRows.map(r => {
    const normalized = normalizedById.get(r.id);
    const nameSlot = normalized?.slots.find(s => s.source === "name");
    const descSlot = normalized?.slots.find(s => s.source === "description");
    const extractedGroups: ExtractedGroup[] = (groupsByItem.get(r.id) ?? []).map(g => ({
      name: g.name,
      required: g.required,
      choiceNames: (choicesByGroup.get(g.id) ?? []).map(c => c.name),
      provenance: g.provenance,
    }));
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      category: r.category,
      productKey: normalized?.product_key ?? null,
      siblingCount: siblingCounts.get(normalized?.product_key ?? `unfolded:${r.id}`) ?? 1,
      nameSlotChoices: nameSlot ? nameSlot.choices.map(c => c.display_name) : null,
      descriptionSlotChoices: descSlot ? descSlot.choices.map(c => c.display_name) : null,
      extractedGroups,
    };
  });
  const priceCentsById = new Map(itemRows.map(r => [r.id, r.price_cents]));

  // §5.1: "category or set first, item second" — an item with no category
  // has no scope to ask a question against, so it's excluded from infer
  // entirely (matches compile-menu.ts's buildOwnerQuestionSummaries
  // contract exactly: `if (!item.category || !item.category.trim()) continue`).
  // It still gets compiled/counted in items-in/orderable below via
  // compileItems, which is built from the full itemRows list separately.
  const byCategory = new Map<string, InferItemInput[]>();
  for (const it of inferInputs) {
    if (!it.category || !it.category.trim()) continue;
    const list = byCategory.get(it.category) ?? [];
    list.push(it);
    byCategory.set(it.category, list);
  }

  // §5's "shared list" concept, recognized post-hoc: any category can
  // itself be the choice list for another category's slot (e.g. NJB's
  // "Bagels" category IS the bagel_type list for "Bagel With ..." items).
  // Same mechanism as compile-menu.ts's buildOwnerQuestionSummaries.
  const priceItemsByCategory = new Map<string, CategoryPriceItem[]>();
  for (const [category, catItems] of byCategory) {
    priceItemsByCategory.set(category, catItems.map(it => ({ name: it.name, priceCents: priceCentsById.get(it.id) ?? 0 })));
  }
  const categoryCandidates = buildCategoryCandidateGroups(priceItemsByCategory);

  // item_id -> slot_key -> the OwnerQuestionDraft that actually applies to
  // THIS item (needs_question/proposed outcome only — see file header).
  const blockingByItem = new Map<string, Map<string, OwnerQuestionDraft>>();
  const drafts: (OwnerQuestionDraft & { category: string; archetype: string })[] = [];
  let categoriesFellToOther = 0;

  for (const [category, catItems] of byCategory) {
    const otherCategoryCandidates = [...categoryCandidates.values()].filter(g => g.name !== category);
    const catItemsWithCandidates = catItems.map(it => ({ ...it, categoryCandidateGroups: otherCategoryCandidates }));
    const result = inferCategory(category, catItemsWithCandidates);
    if (result.archetype === "other") categoriesFellToOther++;
    for (const q of result.questions) drafts.push({ ...q, category, archetype: result.archetype });

    for (const outcome of result.slotOutcomes) {
      if (outcome.kind !== "needs_question" && outcome.kind !== "proposed") continue;
      const draft = result.questions.find(q => q.slot_key === outcome.slot_key);
      if (!draft) continue; // shouldn't happen — inferCategory only emits needs_question/proposed via a question
      const perItem = blockingByItem.get(outcome.item_id) ?? new Map<string, OwnerQuestionDraft>();
      perItem.set(outcome.slot_key, draft);
      blockingByItem.set(outcome.item_id, perItem);
    }
  }

  // Item-scoped PendingQuestion[] — one per (item, blocking slot), status
  // pending (nothing has been answered; these don't exist in the DB yet).
  const pendingQuestions: PendingQuestion[] = [];
  for (const [itemId, slots] of blockingByItem) {
    for (const [slotKey, draft] of slots) {
      pendingQuestions.push({
        scope_type: "item",
        scope_id: itemId,
        slot_key: slotKey,
        blocking: draft.blocking,
        status: "pending",
        question_text: draft.question_text,
      });
    }
  }
  // Any pre-existing real owner_questions rows (expected empty for NJB/Zio's
  // pre-item-3, but read for correctness/idempotency if item 3's real writer
  // ships later and this script is re-run against answered questions).
  for (const q of (questionRows ?? []) as any[]) {
    pendingQuestions.push({
      scope_type: q.scope_type, scope_id: q.scope_id, slot_key: q.slot_key,
      blocking: q.blocking, status: q.status, question_text: q.question_text,
    });
  }

  // Item 4 — same CompileItem construction as compile-menu/index.ts
  // (real groups + normalizer-derived synthetic groups + overrides).
  const groupEntityKeys = new Map<string, string>();
  const choiceEntityKeys = new Map<string, string>();
  const compileItems: CompileItem[] = itemRows.map(row => {
    const itemKey = itemEntityKey({ id: row.id, importKey: row.import_key });
    const groups: CompileGroup[] = (groupsByItem.get(row.id) ?? []).map(g => {
      const gKey = groupEntityKey(itemKey, { slotKey: g.slot_key, name: g.name });
      groupEntityKeys.set(g.id, gKey);
      const choices: CompileChoice[] = (choicesByGroup.get(g.id) ?? []).map(c => {
        choiceEntityKeys.set(c.id, choiceEntityKey(gKey, { name: c.name }));
        return {
          id: c.id, name: c.name, display_name: c.display_name, price_cents: c.price_cents,
          is_default: c.is_default, provenance: c.provenance as CompileChoice["provenance"],
        };
      });
      return {
        id: g.id, name: g.name, kind: g.kind as CompileGroup["kind"], slot_key: g.slot_key,
        min_select: g.min_select, max_select: g.max_select, kitchen_critical: g.kitchen_critical,
        price_critical: g.price_critical, default_choice_id: g.default_choice_id,
        ask_mode: g.ask_mode as CompileGroup["ask_mode"], provenance: g.provenance as CompileGroup["provenance"],
        display_order: g.display_order, choices,
      };
    });

    const normalized = normalizedById.get(row.id);
    const derivedGroups: CompileGroup[] = (normalized?.slots ?? []).map((slot, slotIdx) => ({
      id: `derived:${row.id}:${slotIdx}`, name: "Choice", kind: "slot" as const, slot_key: "choice",
      min_select: 1, max_select: 1, kitchen_critical: false, price_critical: false,
      default_choice_id: null, ask_mode: null, provenance: "stated" as const, display_order: 1000 + slotIdx,
      choices: slot.choices.map((c, choiceIdx) => ({
        id: `derived:${row.id}:${slotIdx}:${choiceIdx}`, name: c.display_name, display_name: c.display_name,
        price_cents: 0, is_default: false, provenance: "stated" as const,
      })),
    }));

    const raw: CompileItem = {
      id: row.id, name: row.name, display_name: normalized?.display_name ?? row.display_name,
      category: row.category, price_cents: row.price_cents, active: row.active,
      price_provenance: row.price_provenance as CompileItem["price_provenance"],
      product_key: normalized?.product_key ?? row.product_key,
      missing_from_source_since: null,
      groups: [...groups, ...derivedGroups],
    };

    const overrides = (overrideRows ?? []) as OverrideRow[];
    if (overrides.length === 0) return raw;
    return applyOverrides(raw, itemKey, groupEntityKeys, choiceEntityKeys,
      overrides.map(o => ({ ...o, entity_type: o.entity_type as OverrideEntityType })));
  });

  const compiledAt = new Date().toISOString();
  const { items: compiled, invariants } = compileMenu(compileItems, pendingQuestions, compiledAt, false);

  return {
    shopName, shopId, itemsIn: allItemRows.length, activeItems: itemRows.length,
    compiled, compileItems, invariants, drafts,
    categoriesFellToOther, totalCategories: byCategory.size,
  };
}

function renderShopReport(r: ShopReport): string {
  const lines: string[] = [];
  lines.push(`## ${r.shopName}`, "");
  lines.push(`**Items in:** ${r.itemsIn} total (${r.activeItems} active, ${r.itemsIn - r.activeItems} inactive/hidden)`, "");

  const byState = new Map<string, CompiledItem[]>();
  for (const c of r.compiled) {
    const list = byState.get(c.bot_state) ?? [];
    list.push(c);
    byState.set(c.bot_state, list);
  }
  const orderable = byState.get("orderable") ?? [];
  const blocked = byState.get("blocked") ?? [];
  const displayOnly = byState.get("display_only") ?? [];
  const stale = byState.get("stale") ?? [];
  const pct = (n: number) => r.activeItems === 0 ? "0.0" : ((n / r.activeItems) * 100).toFixed(1);

  lines.push(`**Items orderable:** ${orderable.length} / ${r.activeItems} (${pct(orderable.length)}%)`, "");
  lines.push(`Other states: blocked ${blocked.length}, display_only ${displayOnly.length}, stale ${stale.length}`, "");

  lines.push(`### Items blocked, and on what`, "");
  if (blocked.length === 0) {
    lines.push("None.", "");
  } else {
    const nameById = new Map(r.compileItems.map(i => [i.id, i.display_name ?? i.name]));
    const catById = new Map(r.compileItems.map(i => [i.id, i.category ?? "(uncategorized)"]));
    const byReason = new Map<string, string[]>();
    for (const b of blocked) {
      const reason = b.bot_state_reason ?? "(no reason recorded)";
      const label = `${nameById.get(b.item_id) ?? b.item_id} [${catById.get(b.item_id)}]`;
      const list = byReason.get(reason) ?? [];
      list.push(label);
      byReason.set(reason, list);
    }
    for (const [reason, names] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`- **${reason}** — ${names.length} item(s)`);
      for (const n of names) lines.push(`  - ${n}`);
    }
    lines.push("");
  }

  lines.push(`### Full owner_questions list (${r.drafts.length} rows — none exist in the DB yet, these are what item 3's infer would write)`, "");
  if (r.drafts.length === 0) {
    lines.push("None generated.", "");
  } else {
    for (const d of [...r.drafts].sort((a, b) => b.priority - a.priority)) {
      lines.push(
        `- **[${d.category}] ${d.slot_key}** (archetype: ${d.archetype}, blocking: ${d.blocking}, priority: ${d.priority}, items affected: ${d.items_affected})`,
      );
      lines.push(`  - Q: ${d.question_text}`);
      lines.push(`  - Proposed choices: ${d.proposal.choices.length ? d.proposal.choices.join(", ") : "(none — owner must supply)"}`);
      if (d.proposal.exclusions.length > 0) {
        lines.push(`  - Excluded (already resolved without a question): ${d.proposal.exclusions.join(", ")}`);
      }
    }
    lines.push("");
  }

  lines.push(`### §8.2 invariants`, "");
  for (const inv of r.invariants) {
    lines.push(`${inv.pass ? "PASS" : "FAIL"} — inv ${inv.invariant}: ${inv.description}${inv.pass ? "" : ` (${inv.violations.length} violation(s): ${inv.violations.slice(0, 5).join("; ")}${inv.violations.length > 5 ? ", ..." : ""})`}`);
  }
  lines.push("");

  lines.push(`### Ten real ask_plans`, "");
  const sample: CompiledItem[] = [];
  const nameById = new Map(r.compileItems.map(i => [i.id, i.display_name ?? i.name]));
  const catById = new Map(r.compileItems.map(i => [i.id, i.category ?? "(uncategorized)"]));
  const seenCats = new Set<string>();
  // Prefer items with a non-empty ask_plan (an item with zero groups gives
  // an uninformative empty steps:[] plan), then diversify across categories,
  // then fill any remaining slots from whatever's left.
  const hasSteps = (c: CompiledItem) => c.ask_plan.steps.length > 0;
  const sorted = [...r.compiled].sort((a, b) => {
    const stepsDiff = (hasSteps(b) ? 1 : 0) - (hasSteps(a) ? 1 : 0);
    if (stepsDiff !== 0) return stepsDiff;
    return (a.bot_state === "orderable" ? -1 : 1) - (b.bot_state === "orderable" ? -1 : 1);
  });
  for (const c of sorted) {
    if (sample.length >= 10) break;
    const cat = catById.get(c.item_id) ?? "";
    if (seenCats.has(cat)) continue;
    seenCats.add(cat);
    sample.push(c);
  }
  for (const c of sorted) {
    if (sample.length >= 10) break;
    if (sample.includes(c)) continue;
    sample.push(c);
  }
  for (const c of sample) {
    lines.push(`**${nameById.get(c.item_id)}** [${catById.get(c.item_id)}] — bot_state: ${c.bot_state}${c.bot_state_reason ? ` (${c.bot_state_reason})` : ""}`);
    lines.push("```json");
    lines.push(JSON.stringify(c.ask_plan, null, 2));
    lines.push("```", "");
  }

  return lines.join("\n");
}

async function main() {
  const reports: ShopReport[] = [];
  for (const [shopName, shopId] of Object.entries(SHOPS)) {
    console.error(`Compiling ${shopName}...`);
    const r = await compileShop(shopName, shopId);
    if (r) reports.push(r);
  }

  const header = [
    "# Item 9 — read-only compile report: Not Just Bagels + Zio's Pizzeria",
    "",
    `Generated ${new Date().toISOString()}. Report-only: zero writes made to any table.`,
    "",
    "Method: real menu_items/option_groups/option_choices read live from each shop's " +
      "menu, run through item 2's normalizer (normalize.ts), item 3's archetype " +
      "inference (archetypes.ts inferCategory, per-category), and item 4's compiler " +
      "(compile-menu.ts compileMenu) exactly as compile-menu/index.ts would, except " +
      "nothing is written back. owner_questions below do not exist in the DB — item " +
      "3's real DB-writing infer step is separate future work; this script only " +
      "computes what it WOULD write, so bot_state reflects real blocking instead of " +
      "the artificially-clean 170/170 and 220/220 numbers from item 4's pre-item-3 dry run.",
    "",
    "---",
    "",
  ].join("\n");

  const body = reports.map(renderShopReport).join("\n---\n\n");
  console.log(header + body);
}

await main();
