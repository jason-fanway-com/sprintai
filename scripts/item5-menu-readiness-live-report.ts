/**
 * Item 5 — menu-readiness gate: live acceptance report
 * =====================================================
 * Reads real menu data from Zio's Pizzeria and Vito's Pizza and runs the
 * full readiness gate against it: §8.1 item state (compile-menu.ts's
 * bot_state, item 4), §8.2 the 8 menu-level invariants (compile-menu.ts's
 * computeMenuInvariants, item 4), and §8.3 the generated menu walk
 * (menu-readiness.ts's runMenuWalk, item 5 — new).
 *
 * READ-ONLY. No writes to any table — this is a reporting/testing gate
 * only. Does not call the compile-menu edge function (which writes
 * bot_state/ask_plan/lexicon back to menu_items) — reads the same raw
 * snapshot rows itself and runs the pure compiler in-process, same pattern
 * as scripts/d1-derived-rows-live-report.ts.
 *
 * Usage:
 *   set -a; source ~/.openclaw/.secrets; set +a
 *   deno run --allow-env --allow-net scripts/item5-menu-readiness-live-report.ts
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  compileMenu,
  type CompileItem,
  type CompileGroup,
  type CompileChoice,
  type CompiledItem,
} from "../supabase/functions/_shared/compile-menu.ts";
import { normalizeMenuItems, pickDescriptionSlot, pickSideDescriptionSlot, type RawMenuItemRow } from "../supabase/functions/_shared/normalize.ts";
import { itemEntityKey, groupEntityKey, choiceEntityKey } from "../supabase/functions/_shared/menu-entity-key.ts";
import { summarizeItemStates, runMenuWalk } from "../supabase/functions/_shared/menu-readiness.ts";

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

interface ShopSummary {
  shop: string;
  orderable: number;
  blocked: number;
  display_only: number;
  stale: number;
  total_active: number;
  orderable_pct: string;
  invariant_failures: { invariant: number; description: string; violation_count: number; sample: string[] }[];
  walk_total: number;
  walk_passed: number;
  walk_failed: number;
  walk_failure_samples: { item_id: string; display_name: string; failures: { step: string; detail: string }[] }[];
}

const summaries: ShopSummary[] = [];

for (const [shopName, shopId] of Object.entries(SHOPS)) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Shop: ${shopName} (${shopId})`);
  console.log("=".repeat(70));

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

  // acknowledgedDisplayOnly=false — we want to SEE invariant 8's real ratio,
  // not have it silently pass via acknowledgement.
  const { items: compiledItems, invariants } = compileMenu(compileItems, [], COMPILED_AT, false);
  const compiledMap = new Map<string, CompiledItem>(compiledItems.map(c => [c.item_id, c]));

  const states = summarizeItemStates(compileItems, compiledMap);
  console.log(`\n§8.1 item states:`);
  console.log(`  orderable:     ${states.orderable}`);
  console.log(`  blocked:       ${states.blocked}`);
  console.log(`  display_only:  ${states.display_only}`);
  console.log(`  stale:         ${states.stale}`);
  console.log(`  total active:  ${states.total_active}`);
  const orderablePct = states.total_active === 0 ? "n/a" : `${((states.orderable / states.total_active) * 100).toFixed(1)}%`;
  console.log(`  orderable %:   ${orderablePct}`);

  console.log(`\n§8.2 menu-level invariants (8 checks):`);
  const invariantFailures: ShopSummary["invariant_failures"] = [];
  for (const inv of invariants) {
    const status = inv.pass ? "PASS" : "FAIL";
    console.log(`  [${status}] #${inv.invariant} ${inv.description} (${inv.violations.length} violation(s))`);
    if (!inv.pass) {
      invariantFailures.push({ invariant: inv.invariant, description: inv.description, violation_count: inv.violations.length, sample: inv.violations.slice(0, 5) });
      for (const v of inv.violations.slice(0, 5)) console.log(`      - ${v}`);
      if (inv.violations.length > 5) console.log(`      ... and ${inv.violations.length - 5} more`);
    }
  }

  console.log(`\n§8.3 generated menu walk (every orderable item, real resolver + ask-plan-engine + pricing + itemizer code):`);
  const walk = runMenuWalk(compileItems, compiledMap);
  console.log(`  total orderable items walked: ${walk.total_orderable}`);
  console.log(`  passed: ${walk.passed}`);
  console.log(`  failed: ${walk.failed}`);
  const walkFailureSamples: ShopSummary["walk_failure_samples"] = [];
  const failedResults = walk.results.filter(r => !r.pass);
  const dumpLimit = Deno.env.get("FULL_DUMP") ? failedResults.length : 10;
  for (const r of failedResults.slice(0, dumpLimit)) {
    console.log(`  FAIL: ${r.display_name} (${r.item_id})`);
    for (const f of r.failures) console.log(`      [${f.step}] ${f.detail}`);
    walkFailureSamples.push({ item_id: r.item_id, display_name: r.display_name, failures: r.failures });
  }
  if (failedResults.length > dumpLimit) console.log(`  ... and ${failedResults.length - dumpLimit} more failing walk cases`);

  summaries.push({
    shop: shopName,
    orderable: states.orderable,
    blocked: states.blocked,
    display_only: states.display_only,
    stale: states.stale,
    total_active: states.total_active,
    orderable_pct: orderablePct,
    invariant_failures: invariantFailures,
    walk_total: walk.total_orderable,
    walk_passed: walk.passed,
    walk_failed: walk.failed,
    walk_failure_samples: walkFailureSamples,
  });
}

console.log(`\n${"=".repeat(70)}`);
console.log("TOP-LINE REPORT");
console.log("=".repeat(70));
for (const s of summaries) {
  console.log(`\n${s.shop}:`);
  console.log(`  ${s.orderable}/${s.total_active} orderable (${s.orderable_pct})  [blocked=${s.blocked} display_only=${s.display_only} stale=${s.stale}]`);
  console.log(`  invariants: ${8 - s.invariant_failures.length}/8 passing${s.invariant_failures.length > 0 ? ` — FAILING: ${s.invariant_failures.map(f => `#${f.invariant}`).join(", ")}` : ""}`);
  console.log(`  walk: ${s.walk_passed}/${s.walk_total} passed${s.walk_failed > 0 ? ` (${s.walk_failed} FAILED)` : ""}`);
}
console.log("\nDone. Read-only run — no rows were written.");
