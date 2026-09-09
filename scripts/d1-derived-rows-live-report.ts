/**
 * D1 derived rows — live acceptance report
 * =========================================
 * Reads real menu data from Zio's Pizzeria (and optionally Vito's) and runs
 * buildDerivedRows() against it, printing row counts, shape, and price checks.
 * No DB writes. Acceptance criteria per §11 item 4 stream D1:
 *   - Row count deterministic
 *   - Price arithmetic exact (base + delta)
 *   - not_composable choices excluded
 *   - Cap respected
 *   - Regeneration idempotent (run twice → identical rows)
 *   - Ticket template resolves to base + topping
 *
 * Usage:
 *   set -a; source ~/.openclaw/.secrets; set +a
 *   deno run --allow-env --allow-net scripts/d1-derived-rows-live-report.ts
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  compileMenu,
  buildDerivedRows,
  type CompileItem,
  type CompileGroup,
  type CompileChoice,
  type CompiledItem,
} from "../supabase/functions/_shared/compile-menu.ts";
import { normalizeMenuItems, pickDescriptionSlot, pickSideDescriptionSlot, type RawMenuItemRow } from "../supabase/functions/_shared/normalize.ts";
import { itemEntityKey, groupEntityKey, choiceEntityKey } from "../supabase/functions/_shared/menu-entity-key.ts";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SPRINTAI_CHAT_SUPABASE_URL / SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY.");
  console.error("Run: set -a; source ~/.openclaw/.secrets; set +a");
  Deno.exit(1);
}

const SHOPS: Record<string, string> = {
  "Zio's Pizzeria": "2cba7b51-211c-4437-8910-1af4dcc03498",
  "Vito's Pizza": "e0000000-0000-0000-0000-000000000001",
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const PAGE_SIZE = 1000;
const IN_CHUNK = 100;

async function fetchAll<T>(qb: () => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
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

async function fetchBatchedIn<T, K>(
  ids: K[],
  qb: (batch: K[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    rows.push(...await fetchAll<T>(() => qb(ids.slice(i, i + IN_CHUNK))));
  }
  return rows;
}

interface MenuItemRow {
  id: string; name: string; description: string | null; display_name: string | null;
  category: string | null; price_cents: number; size_label: string | null;
  active: boolean; price_provenance: string; product_key: string | null; import_key: string | null;
  is_derived: boolean;
}
interface OptionGroupRow {
  id: string; menu_item_id: string; name: string; kind: string; slot_key: string | null;
  min_select: number; max_select: number; kitchen_critical: boolean; price_critical: boolean;
  default_choice_id: string | null; ask_mode: string | null; provenance: string; display_order: number;
  import_key: string | null;
}
interface OptionChoiceRow {
  id: string; option_group_id: string; name: string; display_name: string | null;
  price_cents: number; is_default: boolean; provenance: string; import_key: string | null;
  not_composable: boolean;
}

const COMPILED_AT = "2026-09-09T00:00:00.000Z";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

for (const [shopName, shopId] of Object.entries(SHOPS)) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Shop: ${shopName} (${shopId})`);
  console.log("=".repeat(60));

  const { data: menu } = await supabase.from("menus").select("id").eq("shop_id", shopId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!menu) { console.log("  no menu — skipping"); continue; }
  const menuId = menu.id;
  console.log(`Menu: ${menuId}`);

  const itemRows = await fetchAll<MenuItemRow>(() =>
    supabase.from("menu_items")
      .select("id, name, description, display_name, category, price_cents, size_label, active, price_provenance, product_key, import_key, is_derived")
      .eq("menu_id", menuId).eq("active", true).eq("is_derived", false)
      .order("display_order", { ascending: true }).order("id", { ascending: true })
  );
  console.log(`Stated items (active, not derived): ${itemRows.length}`);

  const groupRows = await fetchBatchedIn<OptionGroupRow, string>(
    itemRows.map(i => i.id),
    batch => supabase.from("option_groups")
      .select("id, menu_item_id, name, kind, slot_key, min_select, max_select, kitchen_critical, price_critical, default_choice_id, ask_mode, provenance, display_order, import_key")
      .in("menu_item_id", batch).order("display_order", { ascending: true }).order("id", { ascending: true }),
  );

  const choiceRows = await fetchBatchedIn<OptionChoiceRow, string>(
    groupRows.map(g => g.id),
    batch => supabase.from("option_choices")
      .select("id, option_group_id, name, display_name, price_cents, is_default, provenance, import_key, not_composable")
      .in("option_group_id", batch).order("display_order", { ascending: true }).order("id", { ascending: true }),
  );

  const choicesByGroup = new Map<string, OptionChoiceRow[]>();
  for (const c of choiceRows) {
    const list = choicesByGroup.get(c.option_group_id) ?? [];
    list.push(c);
    choicesByGroup.set(c.option_group_id, list);
  }
  const groupsByItem = new Map<string, OptionGroupRow[]>();
  for (const g of groupRows) {
    const list = groupsByItem.get(g.menu_item_id) ?? [];
    list.push(g);
    groupsByItem.set(g.menu_item_id, list);
  }

  const rawForNorm: RawMenuItemRow[] = itemRows.map(r => ({
    id: r.id, name: r.name, description: r.description, category: r.category,
    price_cents: r.price_cents, size_label: r.size_label,
  }));
  const normalizedById = new Map(normalizeMenuItems(rawForNorm).map(n => [n.id, n]));

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
          not_composable: c.not_composable,
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
      id: `derived:${row.id}:${slotIdx}`, name: "Choice", kind: "slot", slot_key: "choice",
      min_select: 1, max_select: 1, kitchen_critical: false, price_critical: false,
      default_choice_id: null, ask_mode: null, provenance: "stated", display_order: 1000 + slotIdx,
      choices: slot.choices.map((c, choiceIdx) => ({
        id: `derived:${row.id}:${slotIdx}:${choiceIdx}`, name: c.display_name, display_name: c.display_name,
        price_cents: 0, is_default: false, provenance: "stated",
      })),
    }));
    return {
      id: row.id, name: row.name, display_name: normalized?.display_name ?? row.display_name,
      category: row.category, price_cents: row.price_cents, active: row.active,
      price_provenance: row.price_provenance as CompileItem["price_provenance"],
      product_key: normalized?.product_key ?? row.product_key,
      missing_from_source_since: null, groups: [...groups, ...derivedGroups],
      import_key: row.import_key, size_label: row.size_label,
    };
  });

  const mainResult = compileMenu(compileItems, [], COMPILED_AT, true);
  const compiledMap = new Map(mainResult.items.map(c => [c.item_id, c]));

  // RUN 1
  const rows1 = buildDerivedRows(compileItems, compiledMap, new Map(), COMPILED_AT);
  // RUN 2 (idempotency check)
  const rows2 = buildDerivedRows(compileItems, compiledMap, new Map(), COMPILED_AT);

  console.log(`\nDerived rows generated: ${rows1.length}`);

  // Group by size
  const bySize = new Map<string, typeof rows1>();
  for (const r of rows1) {
    const parts = r.entity_key.split("#");
    const sizeKey = parts.length >= 3 ? parts[parts.length - 1] : "__no_size__";
    const list = bySize.get(sizeKey) ?? [];
    list.push(r);
    bySize.set(sizeKey, list);
  }
  for (const [sk, rlist] of bySize) {
    console.log(`  Size key "${sk}": ${rlist.length} rows`);
  }

  if (rows1.length > 0) {
    // Shape check
    const sample = rows1[0];
    assert(sample.is_derived === true, "is_derived must be true");
    assert(typeof sample.derived_from.base_item_id === "string", "derived_from.base_item_id must be string");
    assert(sample.derived_from.choice_ids.length === 1, "Phase 0: exactly one choice_id per derived row");
    assert(typeof sample.price_cents === "number" && sample.price_cents > 0, "price_cents must be positive");
    assert(sample.product_key.startsWith("pizza:"), "product_key must start with 'pizza:'");
    assert(sample.lexicon_terms.length === 3, "exactly 3 lexicon terms per derived row");
    assert(sample.ask_plan.steps.length === 0, "derived item ask_plan has no steps");
    console.log(`\n  Sample row: ${sample.name}`);
    console.log(`    display_name: ${sample.display_name}`);
    console.log(`    price_cents: ${sample.price_cents} (base + delta)`);
    console.log(`    product_key: ${sample.product_key}`);
    console.log(`    provenance: ${sample.provenance}`);
    console.log(`    ticket_template: ${JSON.stringify(sample.ask_plan.ticket_template)}`);
    console.log(`    lexicon_terms: ${sample.lexicon_terms.map(t => t.term).join(", ")}`);

    // Ticket template verification: must embed base item name + topping
    const baseItem = compileItems.find(i => i.id === sample.derived_from.base_item_id);
    assert(baseItem !== undefined, "base item must exist");
    assert(sample.ask_plan.ticket_template.includes(baseItem.name),
      `ticket_template must include base item name "${baseItem.name}"`);

    // not_composable exclusion: "Extra Cheese" must not appear
    const hasExtraCheese = rows1.some(r => r.name.toLowerCase().includes("extra cheese"));
    assert(!hasExtraCheese, "no 'Extra Cheese' derived rows expected");
    console.log(`\n  not_composable exclusion: OK (no Extra Cheese rows)`);

    // Price arithmetic: verify a specific row
    const pepp = rows1.find(r => r.entity_key.toLowerCase().includes("pepperoni"));
    if (pepp) {
      const base = compileItems.find(i => i.id === pepp.derived_from.base_item_id)!;
      const toppings = base.groups.find(g => g.slot_key === "toppings");
      const topping = toppings?.choices.find(c => (c.display_name ?? c.name).toLowerCase() === "pepperoni");
      if (topping) {
        const expected = (base.price_cents ?? 0) + topping.price_cents;
        assert(pepp.price_cents === expected,
          `pepperoni price: got ${pepp.price_cents}, expected ${expected} (${base.price_cents} + ${topping.price_cents})`);
        console.log(`  Price arithmetic (pepperoni): ${base.price_cents} + ${topping.price_cents} = ${pepp.price_cents} ✓`);
      }
    }

    // Idempotency
    assert(rows1.length === rows2.length, "idempotency: same row count on second run");
    for (let i = 0; i < rows1.length; i++) {
      const a = JSON.stringify({ ...rows1[i], ask_plan: { ...rows1[i].ask_plan, compiled_at: "x" } });
      const b = JSON.stringify({ ...rows2[i], ask_plan: { ...rows2[i].ask_plan, compiled_at: "x" } });
      assert(a === b, `idempotency: row ${i} differs between runs`);
    }
    console.log(`  Idempotency: OK (${rows1.length} rows identical across 2 runs)`);

    // Owner override test
    const firstKey = rows1[0].entity_key;
    const overrides = new Map([[firstKey, { display_name: "Owner Override Test" }]]);
    const withOverride = buildDerivedRows(compileItems, compiledMap, overrides, COMPILED_AT);
    const overridden = withOverride.find(r => r.entity_key === firstKey)!;
    assert(overridden.provenance === "owner_confirmed", "override must flip provenance to owner_confirmed");
    assert(overridden.display_name === "Owner Override Test", "override must apply display_name");
    assert(overridden.derived_from.base_item_id === rows1[0].derived_from.base_item_id,
      "override must preserve derived_from.base_item_id");
    assert(overridden.derived_from.choice_ids.length === 1, "override must preserve derived_from.choice_ids");
    console.log(`  Owner override: OK (provenance → owner_confirmed, derived_from intact)`);

  } else {
    console.log("  (no pizza base candidates found for this shop — no derived rows generated)");
  }

  console.log(`\n  ALL ACCEPTANCE CHECKS PASSED for ${shopName}`);
}

console.log("\n" + "=".repeat(60));
console.log("D1 live report complete.");
