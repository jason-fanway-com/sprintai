/**
 * compile-menu Edge Function — Phase 0 item 4 (docs/specs/2026-09-07-
 * conversation-ready-menu-design.md §3 stage 7, §11 item 4).
 *
 * POST { shop_id } or { menu_id }
 *
 * snapshot ⊕ overrides ⊕ learned → effective menu_items/option_groups/
 * option_choices, lexicon, ask_plan, bot_state. All the actual logic lives
 * in ../_shared/compile-menu.ts (pure, unit-tested); this function's only
 * job is I/O: read the snapshot + overrides + owner_questions, hand it to
 * the pure compiler, write the results back, and return a report.
 *
 * Idempotent: re-running against unchanged inputs writes the same
 * bot_state/ask_plan/lexicon rows (see compile-menu.test.ts). Overrides may
 * be an empty set (item 7's trigger ships separately) — that's the identity
 * case and this still runs correctly.
 *
 * Also runs the normalizer (item 2, ../_shared/normalize.ts) over the raw
 * name/description/category/price/size_label snapshot to get display_name,
 * product_key, and any "X or Y" / "choice of A, B or C" slots the source
 * text states. Per BLOCKED.txt's item 2 note ("Not yet imported by any
 * caller — compiler/item 4 will wire it in"), this is that wiring.
 *
 * Also runs classify/infer (item 3, ../_shared/archetypes.ts) per category
 * and inserts any newly-derived owner_questions rows (insert-if-not-exists
 * by scope_type+scope_id+slot_key — never overwrites an existing row, so an
 * owner's real answer is never clobbered by a later compile). Per item 3's
 * own note ("item 4's compiler is the natural caller"), this is that wiring.
 * The freshly-inserted rows feed straight into this same run's bot_state
 * computation, so a from-scratch menu with zero owner_questions rows still
 * gets a real (not empty) blocking-question picture on its first compile.
 *
 * Deliberately does NOT insert new rows into option_groups/option_choices
 * for those normalizer-derived slots: chat-sms's buildEffectiveMenu reads
 * option_groups/option_choices DIRECTLY for every active item, with no
 * awareness of provenance — a new row there is live the instant it exists,
 * regardless of any P0 column. Materializing derived slots as real rows is
 * therefore live order-taking surface, out of scope here (§11 item 8's
 * resolver work, and only once the sequencer itself reads compiled data).
 * Instead they're carried as synthetic, DB-id-free groups/choices (ids
 * `derived:<item>:<n>`) that feed ask_plan and the report but never touch
 * the tables chat-sms queries — same "additive, dark column" safety
 * property as bot_state/ask_plan/lexicon themselves.
 *
 * Writes:
 *   - menu_items.display_name, product_key, bot_state, bot_state_reason,
 *     ask_plan                                          (every active item)
 *   - lexicon                                            (upsert desired rows,
 *     deactivate stale rule-generated ('stated') rows no longer produced)
 *
 * Returns: { ok, menu_id, shop_id, compiled_at, items: [...], invariants: [...],
 *            owner_questions: [...] } — the same report shape item 9's
 *            read-only run reads from.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  compileMenu,
  applyOverrides,
  buildOwnerQuestionSummaries,
  type CompileItem,
  type CompileGroup,
  type CompileChoice,
  type PendingQuestion,
  type OverrideEntityType,
  type LexiconTerm,
  type InferSourceItem,
} from "../_shared/compile-menu.ts";
import type { ExtractedGroup, OwnerQuestionDraft } from "../_shared/archetypes.ts";
import { itemEntityKey, groupEntityKey, choiceEntityKey } from "../_shared/menu-entity-key.ts";
import { normalizeMenuItems, pickDescriptionSlot, type RawMenuItemRow } from "../_shared/normalize.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Same pagination fix as chat-sms/public-menu's fetchAllRows — PostgREST
// caps a single response at 1000 rows silently. See those files' comments
// for the incident this guards against.
//
// 2026-09-07 incident (Zio's first real compile run): this used to swallow
// a fetch error (`if (error) { console.error(...); break; }`) and return
// whatever partial rows it had — silently. Zio's option_choices fetch (see
// IN_BATCH_SIZE below for why) failed outright with a network-level
// `TypeError: fetch failed`, so it returned ZERO choices for every group,
// and the compiler wrote bot_state='blocked' for 183 items that actually
// have real, stated choices. The report still said `ok: true`. A compiler
// whose entire job is correctness must never write plausible-looking wrong
// data on a fetch failure — it must fail the whole run loudly instead.
const FETCH_PAGE_SIZE = 1000;
async function fetchAllRows<T>(
  queryBuilder: () => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await (queryBuilder() as any).range(from, from + FETCH_PAGE_SIZE - 1);
    if (error) {
      throw new Error(`fetchAllRows failed at offset ${from}: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < FETCH_PAGE_SIZE) break;
    from += FETCH_PAGE_SIZE;
  }
  return rows;
}

// A `.in("col", ids)` filter with enough UUIDs makes the request URL long
// enough to fail outright (reproduced live: ~492 UUIDs on Zio's option
// groups threw `TypeError: fetch failed`, not a graceful PostgREST error —
// see the fetchAllRows comment above for the incident this caused). Batch
// the ID list itself, not just the result page, for any `.in()` filter
// whose value list scales with menu size rather than a fixed small set.
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

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

interface MenuItemRow {
  id: string;
  menu_id: string;
  name: string;
  description: string | null;
  display_name: string | null;
  category: string | null;
  price_cents: number;
  size_label: string | null;
  active: boolean;
  price_provenance: string;
  product_key: string | null;
  import_key: string | null;
}
interface OptionGroupRow {
  id: string;
  menu_item_id: string;
  name: string;
  kind: string;
  slot_key: string | null;
  min_select: number;
  max_select: number;
  kitchen_critical: boolean;
  price_critical: boolean;
  default_choice_id: string | null;
  ask_mode: string | null;
  provenance: string;
  display_order: number;
  import_key: string | null;
}
interface OptionChoiceRow {
  id: string;
  option_group_id: string;
  name: string;
  display_name: string | null;
  price_cents: number;
  is_default: boolean;
  provenance: string;
  import_key: string | null;
}
interface OwnerQuestionRow {
  id: string;
  shop_id: string;
  menu_id: string;
  scope_type: string;
  scope_id: string;
  slot_key: string | null;
  kind: string;
  question_text: string;
  proposal: unknown;
  blocking: boolean;
  priority: number;
  items_affected: number;
  status: string;
  answer: unknown;
  created_at: string;
}
interface MenuOverrideRow {
  entity_type: string;
  entity_key: string;
  field: string;
  value: unknown;
  actor: string;
  created_at: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonError("Method Not Allowed", 405);

  let body: { shop_id?: string; menu_id?: string; acknowledge_display_only?: boolean };
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON");
  }
  if (!body.shop_id && !body.menu_id) return jsonError("shop_id or menu_id is required");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  let menuId = body.menu_id ?? null;
  let shopId = body.shop_id ?? null;

  if (!menuId) {
    const { data: menu, error } = await supabase
      .from("menus")
      .select("id, shop_id")
      .eq("shop_id", shopId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return jsonError(`menu lookup failed: ${error.message}`, 500);
    if (!menu) return jsonError(`no menu found for shop_id ${shopId}`, 404);
    menuId = menu.id;
    shopId = menu.shop_id;
  } else if (!shopId) {
    const { data: menu, error } = await supabase.from("menus").select("shop_id").eq("id", menuId).maybeSingle();
    if (error) return jsonError(`menu lookup failed: ${error.message}`, 500);
    if (!menu) return jsonError(`menu ${menuId} not found`, 404);
    shopId = menu.shop_id;
  }

  const itemRows = await fetchAllRows<MenuItemRow>(() =>
    supabase
      .from("menu_items")
      .select("id, menu_id, name, description, display_name, category, price_cents, size_label, active, price_provenance, product_key, import_key")
      .eq("menu_id", menuId)
      .eq("active", true)
      .order("display_order", { ascending: true })
      .order("id", { ascending: true }),
  );

  if (itemRows.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, menu_id: menuId, shop_id: shopId, compiled_at: new Date().toISOString(), items: [], invariants: [], owner_questions: [] }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  const itemIds = itemRows.map(i => i.id);
  const groupRows = await fetchAllRowsBatchedIn<OptionGroupRow, string>(itemIds, batch =>
    supabase
      .from("option_groups")
      .select("id, menu_item_id, name, kind, slot_key, min_select, max_select, kitchen_critical, price_critical, default_choice_id, ask_mode, provenance, display_order, import_key")
      .in("menu_item_id", batch)
      .order("display_order", { ascending: true })
      .order("id", { ascending: true }),
  );

  const groupIds = groupRows.map(g => g.id);
  const choiceRows = groupIds.length > 0
    ? await fetchAllRowsBatchedIn<OptionChoiceRow, string>(groupIds, batch =>
        supabase
          .from("option_choices")
          .select("id, option_group_id, name, display_name, price_cents, is_default, provenance, import_key")
          .in("option_group_id", batch)
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

  // Normalizer (item 2, §3 stage 3) over the raw snapshot — display_name,
  // product_key, and any "X or Y" / "choice of A, B or C" slots the source
  // text states. Whole-set pass (not per item) because duplicate
  // display_name qualification is a cross-item property (normalize.ts's own
  // contract). See the file header for why the resulting slots are carried
  // as synthetic, non-persisted groups rather than written to option_groups.
  const rawForNormalize: RawMenuItemRow[] = itemRows.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    category: r.category,
    price_cents: r.price_cents,
    size_label: r.size_label,
  }));
  const normalizedById = new Map(normalizeMenuItems(rawForNormalize).map(n => [n.id, n]));

  // §3 stages 4-5 "Classify"/"Infer" (item 3, ../_shared/archetypes.ts) —
  // closes item 3's own stated gap ("item 4's compiler is the natural
  // caller"). Real extracted option_groups (Vito's hand-built lists) feed
  // `extractedGroups` for bind_to_list_named; normalize.ts's "X or Y" /
  // "choice of" slots feed nameSlotChoices/descriptionSlotChoices by
  // source. Menus with zero pre-existing option_groups (NJB, Zio's) simply
  // get an empty extractedGroups per item — buildOwnerQuestionSummaries
  // separately recognizes real category-as-shared-list structure (e.g. a
  // "Bagels" category) via categoryCandidateGroups, so this isn't the only
  // source of a "found list" bind.
  const inferSourceItems: InferSourceItem[] = itemRows.map(row => {
    const normalized = normalizedById.get(row.id);
    const nameSlot = normalized?.slots.find(s => s.source === "name");
    const descriptionSlot = normalized ? pickDescriptionSlot(normalized) : undefined;
    const extractedGroups: ExtractedGroup[] = (groupsByItem.get(row.id) ?? []).map(g => ({
      name: g.name,
      required: g.kind === "slot",
      choiceNames: (choicesByGroup.get(g.id) ?? []).map(c => c.display_name ?? c.name),
      provenance: g.provenance,
    }));
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      productKey: normalized?.product_key ?? row.product_key,
      extractedGroups,
      nameSlotChoices: nameSlot ? nameSlot.choices.map(c => c.display_name) : null,
      descriptionSlotChoices: descriptionSlot ? descriptionSlot.choices.map(c => c.display_name) : null,
      priceCents: row.price_cents,
    };
  });
  const categoryQuestionSummaries = buildOwnerQuestionSummaries(inferSourceItems);
  const freshDrafts: OwnerQuestionDraft[] = categoryQuestionSummaries.flatMap(s => s.questions);

  // Insert-if-not-exists only, keyed on (scope_type, scope_id, slot_key) —
  // never overwrite an existing row, blocking or otherwise, because that
  // row may already carry an owner's real answer (status
  // answered/dismissed). This is what makes re-running infer on every
  // compile idempotent in the sense §11 item 4 requires: identical input
  // produces no new rows on a second run, not "produces the same rows".
  const existingQuestionKeys = new Set(
    ((questionRows ?? []) as OwnerQuestionRow[]).map(q => `${q.scope_type}|${q.scope_id}|${q.slot_key ?? ""}`),
  );
  const newDrafts = freshDrafts.filter(
    d => !existingQuestionKeys.has(`${d.scope_type}|${d.scope_id}|${d.slot_key}`),
  );

  let insertedQuestionRows: OwnerQuestionRow[] = [];
  if (newDrafts.length > 0) {
    const { data: inserted, error: insertError } = await supabase
      .from("owner_questions")
      .insert(
        newDrafts.map(d => ({
          shop_id: shopId,
          menu_id: menuId,
          scope_type: d.scope_type,
          scope_id: d.scope_id,
          slot_key: d.slot_key,
          kind: d.kind,
          question_text: d.question_text,
          proposal: d.proposal,
          blocking: d.blocking,
          priority: d.priority,
          items_affected: d.items_affected,
        })),
      )
      .select();
    if (insertError) {
      console.error(`[compile-menu] owner_questions insert error:`, insertError.message);
    } else {
      insertedQuestionRows = (inserted ?? []) as OwnerQuestionRow[];
    }
  }
  const allOwnerQuestionRows: OwnerQuestionRow[] = [...((questionRows ?? []) as OwnerQuestionRow[]), ...insertedQuestionRows];

  // Entity keys (§9), used to apply overrides — same formula everywhere via
  // menu-entity-key.ts, never re-derived locally.
  const groupEntityKeys = new Map<string, string>(); // group.id -> entity_key
  const choiceEntityKeys = new Map<string, string>(); // choice.id -> entity_key

  const compileItems: CompileItem[] = itemRows.map(row => {
    const itemKey = itemEntityKey({ id: row.id, importKey: row.import_key });
    const groups: CompileGroup[] = (groupsByItem.get(row.id) ?? []).map(g => {
      const gKey = groupEntityKey(itemKey, { slotKey: g.slot_key, name: g.name });
      groupEntityKeys.set(g.id, gKey);
      const choices: CompileChoice[] = (choicesByGroup.get(g.id) ?? []).map(c => {
        choiceEntityKeys.set(c.id, choiceEntityKey(gKey, { name: c.name }));
        return {
          id: c.id,
          name: c.name,
          display_name: c.display_name,
          price_cents: c.price_cents,
          is_default: c.is_default,
          provenance: c.provenance as CompileChoice["provenance"],
        };
      });
      return {
        id: g.id,
        name: g.name,
        kind: g.kind as CompileGroup["kind"],
        slot_key: g.slot_key,
        min_select: g.min_select,
        max_select: g.max_select,
        kitchen_critical: g.kitchen_critical,
        price_critical: g.price_critical,
        default_choice_id: g.default_choice_id,
        ask_mode: g.ask_mode as CompileGroup["ask_mode"],
        provenance: g.provenance as CompileGroup["provenance"],
        display_order: g.display_order,
        choices,
      };
    });

    const normalized = normalizedById.get(row.id);
    // Synthetic groups from the normalizer's name/description slots — never
    // written to option_groups (see file header). Deterministic ids so
    // repeated compiles of unchanged input are byte-identical (idempotency).
    const derivedGroups: CompileGroup[] = (normalized?.slots ?? []).map((slot, slotIdx) => ({
      id: `derived:${row.id}:${slotIdx}`,
      name: "Choice",
      kind: "slot",
      slot_key: "choice",
      min_select: 1,
      max_select: 1,
      kitchen_critical: false,
      price_critical: false,
      default_choice_id: null,
      ask_mode: null,
      provenance: "stated",
      display_order: 1000 + slotIdx,
      choices: slot.choices.map((c, choiceIdx) => ({
        id: `derived:${row.id}:${slotIdx}:${choiceIdx}`,
        name: c.display_name,
        display_name: c.display_name,
        price_cents: 0,
        is_default: false,
        provenance: "stated",
      })),
    }));

    const raw: CompileItem = {
      id: row.id,
      name: row.name,
      display_name: normalized?.display_name ?? row.display_name,
      category: row.category,
      price_cents: row.price_cents,
      active: row.active,
      price_provenance: row.price_provenance as CompileItem["price_provenance"],
      product_key: normalized?.product_key ?? row.product_key,
      // P1 column (§2.3) — doesn't exist yet, so there's nothing real to
      // read. Passing null here means the `stale` bot_state never fires
      // until that column ships; every other state is unaffected.
      missing_from_source_since: null,
      groups: [...groups, ...derivedGroups],
    };

    const overrides = (overrideRows ?? []) as MenuOverrideRow[];
    if (overrides.length === 0) return raw;
    return applyOverrides(
      raw,
      itemKey,
      groupEntityKeys,
      choiceEntityKeys,
      overrides.map(o => ({ ...o, entity_type: o.entity_type as OverrideEntityType })),
    );
  });

  const allQuestions: PendingQuestion[] = allOwnerQuestionRows.map(q => ({
    scope_type: q.scope_type as PendingQuestion["scope_type"],
    scope_id: q.scope_id,
    slot_key: q.slot_key,
    blocking: q.blocking,
    status: q.status as PendingQuestion["status"],
    question_text: q.question_text,
    // See PendingQuestion.exclusions' own comment (compile-menu.ts): without
    // this, findBlockingQuestion's category-scope match has no way to know
    // which items in the category the gate already resolved via a real
    // stated-provenance group, and blanket-blocks the whole category on one
    // item's genuine gap.
    exclusions: Array.isArray((q.proposal as { exclusions?: unknown } | null)?.exclusions)
      ? (q.proposal as { exclusions: string[] }).exclusions
      : [],
  }));

  const acknowledgedDisplayOnly =
    body.acknowledge_display_only === true ||
    ((overrideRows ?? []) as MenuOverrideRow[]).some(o => o.field === "acknowledged_display_only");

  const compiledAt = new Date().toISOString();
  const result = compileMenu(compileItems, allQuestions, compiledAt, acknowledgedDisplayOnly);

  // ---- Write back: menu_items.display_name / product_key / bot_state /
  // bot_state_reason / ask_plan. display_name/product_key come from
  // compileItems (post-override — same value ask_plan.display_name already
  // reflects), not straight from the normalizer, so an owner override on
  // display_name is never clobbered by the next compile. ----
  const productKeyByItem = new Map(compileItems.map(i => [i.id, i.product_key]));
  const CONCURRENCY = 20;
  for (let i = 0; i < result.items.length; i += CONCURRENCY) {
    const batch = result.items.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(c =>
        supabase
          .from("menu_items")
          .update({
            display_name: c.ask_plan.display_name,
            product_key: productKeyByItem.get(c.item_id) ?? null,
            bot_state: c.bot_state,
            bot_state_reason: c.bot_state_reason,
            ask_plan: c.ask_plan,
          })
          .eq("id", c.item_id),
      ),
    );
  }

  // ---- Write back: lexicon — upsert desired rows, deactivate stale
  // 'stated' rows no longer produced by this compile (idempotent re-compile
  // after e.g. a display_name override changes what rules 1/2/3/6 emit). ----
  const desiredTerms: LexiconTerm[] = [
    ...result.items.flatMap(c => c.lexicon_terms),
    ...result.categoryLexicon,
  ];
  const desiredKeys = new Set(desiredTerms.map(t => `${t.term} ${t.target_type} ${t.target_id}`));

  if (desiredTerms.length > 0) {
    await supabase.from("lexicon").upsert(
      desiredTerms.map(t => ({
        shop_id: shopId,
        menu_id: menuId,
        term: t.term,
        target_type: t.target_type,
        target_id: t.target_id,
        provenance: t.provenance,
        active: true,
      })),
      { onConflict: "menu_id,term,target_type,target_id" },
    );
  }

  const { data: existingLexicon } = await supabase
    .from("lexicon")
    .select("id, term, target_type, target_id")
    .eq("menu_id", menuId)
    .eq("provenance", "stated")
    .eq("active", true);
  const staleIds = (existingLexicon ?? [])
    .filter((row: { term: string; target_type: string; target_id: string }) =>
      !desiredKeys.has(`${row.term} ${row.target_type} ${row.target_id}`))
    .map((row: { id: string }) => row.id);
  for (let i = 0; i < staleIds.length; i += IN_BATCH_SIZE) {
    const batch = staleIds.slice(i, i + IN_BATCH_SIZE);
    const { error } = await supabase.from("lexicon").update({ active: false }).in("id", batch);
    if (error) throw new Error(`lexicon deactivate batch failed: ${error.message}`);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      menu_id: menuId,
      shop_id: shopId,
      compiled_at: compiledAt,
      items: result.items,
      invariants: result.invariants,
      owner_questions: allOwnerQuestionRows,
      category_archetypes: categoryQuestionSummaries.map(s => ({ category: s.category, archetype: s.archetype, item_count: s.itemCount })),
    }),
    { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
});
