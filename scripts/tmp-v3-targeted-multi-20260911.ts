// Stage 1 (V3) targeted multi-item walk — supplements item5-menu-readiness-live-report.ts's
// generic §8.4 multi-item walk (which picks items by array order, not by category) with
// scenarios specifically hitting the categories the two just-fixed archetype commits
// (387a567, 49a4840) touched: Entrees/Pasta (platter side-slot fix), plus Angus Burgers/
// Temp, Hot Sandwiches/Bread, Wraps, Homemade Paninis (unaffected by the fix but named by
// the PO as categories to specifically re-exercise for cross-item bleed).
//
// Non-live: builds carts directly via applyCompiledAddItem, exactly like
// menu-readiness.ts's own §8.4 walk. No chat-sms call, no LLM, no OpenRouter spend.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  compileMenu, buildOwnerQuestionSummaries,
  type CompileItem, type CompileGroup, type CompileChoice, type CompiledItem,
  type PendingQuestion, type InferSourceItem,
} from "../supabase/functions/_shared/compile-menu.ts";
import type { ExtractedGroup } from "../supabase/functions/_shared/archetypes.ts";
import { normalizeMenuItems, pickDescriptionSlot, pickSideDescriptionSlot, type RawMenuItemRow } from "../supabase/functions/_shared/normalize.ts";
import { itemEntityKey, groupEntityKey, choiceEntityKey } from "../supabase/functions/_shared/menu-entity-key.ts";
import { applyCompiledAddItem, allSlotsResolved, type CompiledCartLine, type CompiledMenuItem } from "../supabase/functions/chat-sms/ask-plan-engine.ts";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const SHOP_ID = "e0000000-0000-0000-0000-000000000001";
const PAGE_SIZE = 1000, IN_CHUNK = 100;

async function fetchAll<T>(qb: () => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = []; let from = 0;
  for (;;) {
    const { data, error } = await (qb() as any).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}
async function fetchBatchedIn<T, K>(ids: K[], qb: (batch: K[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) rows.push(...await fetchAll<T>(() => qb(ids.slice(i, i + IN_CHUNK))));
  return rows;
}

const { data: menu } = await supabase.from("menus").select("id").eq("shop_id", SHOP_ID).order("created_at", { ascending: false }).limit(1).maybeSingle();
const menuId = menu!.id;

const itemRows = await fetchAll<any>(() =>
  supabase.from("menu_items").select("id, name, description, display_name, category, price_cents, size_label, active, price_provenance, product_key, import_key, is_derived")
    .eq("menu_id", menuId).eq("active", true).eq("is_derived", false).order("display_order", { ascending: true }).order("id", { ascending: true }));

const groupRows = await fetchBatchedIn<any, string>(itemRows.map(i => i.id), batch =>
  supabase.from("option_groups").select("id, menu_item_id, name, kind, slot_key, min_select, max_select, kitchen_critical, price_critical, default_choice_id, ask_mode, provenance, display_order, import_key")
    .in("menu_item_id", batch).order("display_order", { ascending: true }).order("id", { ascending: true }));

const choiceRows = await fetchBatchedIn<any, string>(groupRows.map(g => g.id), batch =>
  supabase.from("option_choices").select("id, option_group_id, name, display_name, price_cents, is_default, provenance, import_key, not_composable")
    .in("option_group_id", batch).order("display_order", { ascending: true }).order("id", { ascending: true }));

const choicesByGroup = new Map<string, any[]>();
for (const c of choiceRows) choicesByGroup.set(c.option_group_id, [...(choicesByGroup.get(c.option_group_id) ?? []), c]);
const groupsByItem = new Map<string, any[]>();
for (const g of groupRows) groupsByItem.set(g.menu_item_id, [...(groupsByItem.get(g.menu_item_id) ?? []), g]);

const rawForNorm: RawMenuItemRow[] = itemRows.map(r => ({ id: r.id, name: r.name, description: r.description, category: r.category, price_cents: r.price_cents, size_label: r.size_label }));
const normalizedById = new Map(normalizeMenuItems(rawForNorm).map(n => [n.id, n]));

const inferSourceItems: InferSourceItem[] = itemRows.map(row => {
  const normalized = normalizedById.get(row.id);
  const nameSlot = normalized?.slots.find(s => s.source === "name");
  const descriptionSlot = normalized ? pickDescriptionSlot(normalized) : undefined;
  const sideSlot = normalized ? pickSideDescriptionSlot(normalized) : undefined;
  const extractedGroups: ExtractedGroup[] = (groupsByItem.get(row.id) ?? []).map((g: any) => ({
    name: g.name, required: g.kind === "slot", choiceNames: (choicesByGroup.get(g.id) ?? []).map((c: any) => c.display_name ?? c.name), provenance: g.provenance,
  }));
  return {
    id: row.id, name: row.name, description: row.description, category: row.category,
    productKey: normalized?.product_key ?? row.product_key, extractedGroups,
    nameSlotChoices: nameSlot ? nameSlot.choices.map((c: any) => c.display_name) : null,
    descriptionSlotChoices: descriptionSlot ? descriptionSlot.choices.map((c: any) => c.display_name) : null,
    sideSlotChoices: sideSlot ? sideSlot.choices.map((c: any) => c.display_name) : null,
    priceCents: row.price_cents,
  };
});
const freshDrafts = buildOwnerQuestionSummaries(inferSourceItems).flatMap(s => s.questions);
const { data: questionRows } = await supabase.from("owner_questions").select("scope_type, scope_id, slot_key, status, question_text, proposal").eq("menu_id", menuId);
const existingQuestions = (questionRows ?? []) as any[];
const existingQuestionKeys = new Set(existingQuestions.map(q => `${q.scope_type}|${q.scope_id}|${q.slot_key ?? ""}`));
const newDrafts = freshDrafts.filter(d => !existingQuestionKeys.has(`${d.scope_type}|${d.scope_id}|${d.slot_key}`));
const toPendingQuestion = (q: any): PendingQuestion => ({
  scope_type: q.scope_type, scope_id: q.scope_id, slot_key: q.slot_key, blocking: q.blocking ?? true, status: q.status, question_text: q.question_text,
  exclusions: Array.isArray(q.proposal?.exclusions) ? q.proposal.exclusions : [],
});
const allQuestions: PendingQuestion[] = [...existingQuestions.map(toPendingQuestion), ...newDrafts.map(d => toPendingQuestion({ ...d, status: "pending" }))];

const compileItems: CompileItem[] = itemRows.map(row => {
  const itemKey = itemEntityKey({ id: row.id, importKey: row.import_key });
  const groups: CompileGroup[] = (groupsByItem.get(row.id) ?? []).map((g: any) => {
    const gKey = groupEntityKey(itemKey, { slotKey: g.slot_key, name: g.name });
    const choices: CompileChoice[] = (choicesByGroup.get(g.id) ?? []).map((c: any) => ({
      id: c.id, name: c.name, display_name: c.display_name, price_cents: c.price_cents, is_default: c.is_default, provenance: c.provenance, not_composable: c.not_composable,
    }));
    return { id: g.id, name: g.name, kind: g.kind, slot_key: g.slot_key, min_select: g.min_select, max_select: g.max_select, kitchen_critical: g.kitchen_critical, price_critical: g.price_critical, default_choice_id: g.default_choice_id, ask_mode: g.ask_mode, provenance: g.provenance, display_order: g.display_order, choices };
  });
  const normalized = normalizedById.get(row.id);
  const derivedGroups: CompileGroup[] = (normalized?.slots ?? []).map((slot, slotIdx) => ({
    id: `derived:${row.id}:${slotIdx}`, name: "Choice", kind: "slot", slot_key: "choice", min_select: 1, max_select: 1, kitchen_critical: false, price_critical: false, default_choice_id: null, ask_mode: null, provenance: "stated", display_order: 1000 + slotIdx,
    choices: slot.choices.map((c, choiceIdx) => ({ id: `derived:${row.id}:${slotIdx}:${choiceIdx}`, name: c.display_name, display_name: c.display_name, price_cents: 0, is_default: false, provenance: "stated" })),
  }));
  return {
    id: row.id, name: row.name, display_name: normalized?.display_name ?? row.display_name, category: row.category, price_cents: row.price_cents, active: row.active,
    price_provenance: row.price_provenance, product_key: normalized?.product_key ?? row.product_key, missing_from_source_since: null, groups: [...groups, ...derivedGroups], import_key: row.import_key, size_label: row.size_label,
  };
});

const { items: compiledItems } = compileMenu(compileItems, allQuestions, "2026-09-11T00:00:00.000Z", false);
const compiledMap = new Map<string, CompiledItem>(compiledItems.map(c => [c.item_id, c]));
const itemById = new Map(compileItems.map(i => [i.id, i]));

function toEngineMenuItem(itemId: string): { menuItem: CompiledMenuItem; item: CompileItem } | null {
  const c = compiledMap.get(itemId);
  const item = itemById.get(itemId);
  if (!c || !item || c.bot_state !== "orderable") return null;
  const itemGroups = item.groups.map(g => ({ id: g.id, name: g.name, default_choice_id: g.default_choice_id }));
  return { menuItem: { ask_plan: c.ask_plan, bot_state: c.bot_state, option_groups: itemGroups }, item };
}

function pick(cat: string, n = 999): { item: CompileItem; compiled: CompiledItem }[] {
  return compileItems.filter(i => i.category === cat && compiledMap.get(i.id)?.bot_state === "orderable")
    .map(i => ({ item: i, compiled: compiledMap.get(i.id)! })).slice(0, n);
}

// Adds ONE item and then walks its open ask steps (answering each with
// choices[0].display, same convention as menu-readiness.ts's runItemWalk),
// returning the fully-resolved cart line — or throwing a descriptive error
// if resolution never converges. Mirrors a real multi-turn conversation:
// the model names the item, the engine asks, the customer answers, repeat
// until every required slot on THIS item is filled, before moving to the
// next item in the order.
function addAndFullyResolve(cart: CompiledCartLine[], itemId: string, firstMessage: string): { line: CompiledCartLine; problems: string[] } {
  const em = toEngineMenuItem(itemId)!;
  const problems: string[] = [];
  const addResult = applyCompiledAddItem(cart, em.menuItem, itemId, 1, firstMessage, null);
  const findLine = () => {
    // continuation-or-new logic inside applyCompiledAddItem always leaves
    // exactly one line for this item still open (or fully resolved) at the
    // END of the cart array (new push) or wherever the continuation line
    // already was — find by menu_item_id, preferring an unresolved one.
    const candidates = cart.filter(l => l.menu_item_id === itemId);
    return candidates.find(l => !allSlotsResolved(em.menuItem.ask_plan, new Set(Object.keys(l.ask_plan_selections ?? {})))) ?? candidates[candidates.length - 1];
  };
  if (!addResult.ok) problems.push(`add-item failed: ${JSON.stringify(addResult.result)}`);
  let line = findLine();
  const slotSteps = em.menuItem.ask_plan.steps.filter(s => s.kind === "slot");
  let guard = 0;
  for (;;) {
    if (!line) { problems.push("no cart line found after add"); break; }
    const resolvedIds = new Set(Object.keys(line.ask_plan_selections ?? {}));
    if (allSlotsResolved(em.menuItem.ask_plan, resolvedIds)) break;
    guard++;
    if (guard > slotSteps.length + 2) { problems.push(`slot resolution did not converge after ${guard} turns`); break; }
    const nextStep = slotSteps.find(s => !resolvedIds.has(s.group_id));
    if (!nextStep || nextStep.choices.length === 0) { problems.push("no answerable next step found"); break; }
    const answerText = nextStep.choices[0].display;
    const beforeSize = resolvedIds.size;
    const stepResult = applyCompiledAddItem(cart, em.menuItem, itemId, 1, answerText, null);
    line = findLine();
    const afterIds = new Set(Object.keys(line?.ask_plan_selections ?? {}));
    if (!stepResult.ok || !afterIds.has(nextStep.group_id) || afterIds.size <= beforeSize) {
      problems.push(`answering "${answerText}" for step ${nextStep.slot_key ?? nextStep.group_id} did not record a selection`);
      break;
    }
  }
  return { line: line ?? (cart[cart.length - 1] as CompiledCartLine), problems };
}

let failures: string[] = [];
let passCount = 0, totalCount = 0;

function report(caseLabel: string, cart: CompiledCartLine[], expectedLines: number, allProblems: string[]) {
  totalCount++;
  const problems = [...allProblems];
  if (cart.length !== expectedLines) problems.push(`expected ${expectedLines} lines, got ${cart.length}`);
  // Cross-item bleed check: every line's resolved selections must reference
  // choice ids that actually belong to THAT line's own ask_plan (never
  // another item's), and every required slot must be filled.
  for (let idx = 0; idx < cart.length; idx++) {
    const line = cart[idx];
    const c = compiledMap.get(line.menu_item_id)!;
    for (const step of c.ask_plan.steps) {
      if (step.kind !== "slot") continue;
      const sel = line.ask_plan_selections?.[step.group_id];
      if (!sel) { problems.push(`line ${idx} (${line.name}) missing required slot ${step.slot_key ?? step.group_id}`); continue; }
      const ids = Array.isArray(sel) ? sel : [sel];
      for (const id of ids) {
        if (!step.choices.some(ch => ch.id === id)) problems.push(`line ${idx} (${line.name}) slot ${step.slot_key ?? step.group_id} resolved to choice id ${id}, which is not one of this item's own real choices`);
      }
    }
  }
  if (problems.length === 0) {
    passCount++;
    console.log(`PASS: ${caseLabel} — ${cart.length} line(s), total $${(cart.reduce((s,l)=>s+l.price_cents*l.quantity,0)/100).toFixed(2)}`);
  } else {
    console.log(`FAIL: ${caseLabel}`);
    for (const p of problems) console.log(`   - ${p}`);
    failures.push(`${caseLabel}: ${problems.join("; ")}`);
  }
}

console.log("=".repeat(70));
console.log("Vito's targeted multi-item walk — Entrees/Pasta, Angus Burgers/Temp, Hot Sandwiches/Bread, Wraps, Homemade Paninis");
console.log("=".repeat(70));

function addAllSequentially(items: { item: CompileItem }[]): { cart: CompiledCartLine[]; problems: string[] } {
  const cart: CompiledCartLine[] = [];
  const problems: string[] = [];
  for (const { item } of items) {
    const { problems: p } = addAndFullyResolve(cart, item.id, item.display_name ?? item.name);
    problems.push(...p.map(x => `${item.name}: ${x}`));
  }
  return { cart, problems };
}

// 1. Two different Entrees (Pasta group) in one order — platter/side-slot-fix category
{
  const entrees = pick("Entrees", 2);
  if (entrees.length >= 2) {
    const { cart, problems } = addAllSequentially(entrees);
    report(`Entrees pair: "${entrees[0].item.name}" + "${entrees[1].item.name}"`, cart, 2, problems);
  } else console.log("SKIP: Entrees pair (fewer than 2 orderable entrees)");
}

// 2. All 9 Entrees in one order sequentially (stress the platter/pasta side-slot fix across the whole category)
{
  const entrees = pick("Entrees");
  const { cart, problems } = addAllSequentially(entrees);
  report(`All ${entrees.length} Entrees in one order`, cart, entrees.length, problems);
}

// 3. Two Angus Burgers with DIFFERENT Temp selections — must NOT merge into one line, must not bleed temp across lines
{
  const burgers = pick("Angus Burgers & Specialty", 2);
  if (burgers.length >= 2) {
    const b1 = toEngineMenuItem(burgers[0].item.id)!;
    // slot_key is null on this compiled menu's "Temp" group (raw DB row
    // never got a slot_key value) — identify the slot by shape (an "ask"
    // slot step with >=2 choices) rather than by slot_key string, same
    // choices the walk output above confirmed exist (Well Done/Medium/
    // Rare/Medium Well/Medium Rare).
    const tempStep1 = b1.menuItem.ask_plan.steps.find(s => s.kind === "slot" && s.ask_mode === "ask" && s.choices.length >= 2);
    if (tempStep1) {
      const cart: CompiledCartLine[] = [];
      const r1 = addAndFullyResolve(cart, burgers[0].item.id, `${burgers[0].item.display_name ?? burgers[0].item.name} ${tempStep1.choices[0].display}`);
      const r2 = addAndFullyResolve(cart, burgers[1].item.id, `${burgers[1].item.display_name ?? burgers[1].item.name} ${tempStep1.choices[1].display}`);
      totalCount++;
      const t1 = r1.line.ask_plan_selections?.[tempStep1.group_id];
      const b2 = toEngineMenuItem(burgers[1].item.id)!;
      const tempStep2 = b2.menuItem.ask_plan.steps.find(s => s.kind === "slot" && s.ask_mode === "ask" && s.choices.length >= 2);
      const t2 = r2.line.ask_plan_selections?.[tempStep2!.group_id];
      const allProblems = [...r1.problems, ...r2.problems];
      if (cart.length === 2 && t1 && t2 && t1 !== t2 && allProblems.length === 0) {
        passCount++;
        console.log(`PASS: Two Angus Burgers, different temps ("${burgers[0].item.name}" ${tempStep1.choices[0].display} / "${burgers[1].item.name}" ${tempStep2!.choices[1].display}) — 2 distinct lines, temps did not bleed`);
      } else {
        failures.push(`Angus Burgers different temps: lines=${cart.length}, t1=${t1}, t2=${t2}, problems=${allProblems.join("; ")}`);
        console.log(`FAIL: Angus Burgers different temps — lines=${cart.length}, t1=${JSON.stringify(t1)}, t2=${JSON.stringify(t2)}, problems=${allProblems.join("; ")}`);
      }
    } else console.log("SKIP: Angus Burgers temp test (no temp slot with 2+ choices found)");
  } else console.log("SKIP: Angus Burgers pair (fewer than 2 orderable)");
}

// 4. All Angus Burgers sequentially
{
  const burgers = pick("Angus Burgers & Specialty");
  const { cart, problems } = addAllSequentially(burgers);
  report(`All ${burgers.length} Angus Burgers in one order`, cart, burgers.length, problems);
}

// 5. Hot Sandwich (Bread slot) + Wrap in one order — cross-category, checks bread slot doesn't bleed to wrap
{
  const hotSandwiches = pick("Hot Sandwiches", 2);
  const wraps = pick("Wraps", 1);
  if (hotSandwiches.length >= 1 && wraps.length >= 1) {
    const { cart, problems } = addAllSequentially([hotSandwiches[0], wraps[0]]);
    report(`Hot Sandwich "${hotSandwiches[0].item.name}" + Wrap "${wraps[0].item.name}"`, cart, 2, problems);
  } else console.log("SKIP: Hot Sandwich + Wrap (missing category data)");
}

// 6. All Hot Sandwiches sequentially
{
  const hs = pick("Hot Sandwiches");
  const { cart, problems } = addAllSequentially(hs);
  report(`All ${hs.length} Hot Sandwiches in one order`, cart, hs.length, problems);
}

// 7. All Wraps sequentially
{
  const wr = pick("Wraps");
  const { cart, problems } = addAllSequentially(wr);
  report(`All ${wr.length} Wraps in one order`, cart, wr.length, problems);
}

// 8. All Homemade Paninis sequentially
{
  const hp = pick("Homemade Paninis");
  const { cart, problems } = addAllSequentially(hp);
  report(`All ${hp.length} Homemade Paninis in one order`, cart, hp.length, problems);
}

// 9. Big 5-item combo: one from each fixed category, all in one order — cross-category bleed stress test
{
  const catPicks = [pick("Entrees",1)[0], pick("Angus Burgers & Specialty",1)[0], pick("Hot Sandwiches",1)[0], pick("Wraps",1)[0], pick("Homemade Paninis",1)[0]].filter(Boolean);
  const { cart, problems } = addAllSequentially(catPicks);
  report(`One item each from Entrees/Angus Burgers/Hot Sandwiches/Wraps/Homemade Paninis (${catPicks.map(p=>p.item.name).join(" | ")})`, cart, catPicks.length, problems);
}

console.log("\n" + "=".repeat(70));
console.log(`TARGETED MULTI-ITEM RESULT: ${passCount}/${totalCount} passed`);
if (failures.length > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=".repeat(70));
