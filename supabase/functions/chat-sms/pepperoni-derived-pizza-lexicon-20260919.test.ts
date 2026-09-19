// 2026-09-19 PO dispatch — "why does this system have such a hard time with
// pepperoni pizza?" Root cause (confirmed against LIVE Vito's data via
// probe): Vito's menu has NO pepperoni pizza item at all. Pepperoni only
// exists as (a) a topping choice on the Cheese pizza's "Toppings" group, and
// (b) an unrelated $9.99 Stromboli Roll item literally named "Pepperoni".
// The existing D1 compile-time derived-row mechanism (compile-menu.ts's
// buildDerivedRows, §11 item 4) was never producing rows for Vito's because
// its "Toppings" group has slot_key=null (owner-created via the admin
// dashboard, never ran through archetypes.ts's classifier) — see
// compile-menu.test.ts's "Vito's shape" suite for the compiler-level fix and
// its own unit tests. This file is the RESOLVER-level check the dispatch
// asked for: once buildDerivedRows emits the real lexicon terms, does
// resolveItem (chat-sms/resolve-item.ts) actually resolve a customer's
// pepperoni/sausage phrasing the way Jason's live test expected?
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveItem, type LexiconTerm as ResolveLexiconTerm } from "./resolve-item.ts";
import { buildDerivedRows, type CompileItem, type CompileGroup, type CompiledItem } from "../_shared/compile-menu.ts";

const T_COMPILED_AT = "2026-09-19T00:00:00.000Z";

// Mirrors real Vito's data (live probe, 2026-09-19): a "Toppings" group with
// slot_key NULL, each of 16 toppings carrying a not_composable=false
// "(Half pizza)" AND "(Whole pizza)" choice pair.
function vitosPortionChoice(base: string, portion: "half" | "whole", id: string): CompileGroup["choices"][0] {
  const name = `${base} (${portion === "half" ? "Half pizza" : "Whole pizza"})`;
  return {
    id, name, display_name: name,
    price_cents: portion === "half" ? 350 : 450,
    is_default: false, provenance: "owner_confirmed", not_composable: false,
  };
}

function vitosToppingsGroup(): CompileGroup {
  const bases = ["Pepperoni", "Sausage", "Steak", "Gyro Meat"]; // Steak/Gyro Meat: real toppings, NOT on the standard list
  const choices = bases.flatMap((base, i) => [
    vitosPortionChoice(base, "half", `vito-${i}-half`),
    vitosPortionChoice(base, "whole", `vito-${i}-whole`),
  ]);
  return {
    id: "vito-toppings-group", name: "Toppings", kind: "modifier", slot_key: null,
    min_select: 0, max_select: 32, kitchen_critical: false, price_critical: false,
    default_choice_id: null, ask_mode: null, provenance: "owner_confirmed", display_order: 0,
    choices,
  };
}

function vitosCheeseItem(name: string, price_cents: number, size_label: string): CompileItem {
  return {
    id: `vito-item-${name.replace(/\W+/g, "-").toLowerCase()}`,
    display_name: name,
    category: "Pizza",
    active: true,
    price_provenance: "stated",
    product_key: null,
    missing_from_source_since: null,
    import_key: `vito-import-${name.replace(/\W+/g, "-").toLowerCase()}`,
    groups: [vitosToppingsGroup()],
    name, price_cents, size_label,
  } as CompileItem;
}

function orderable(itemId: string): [string, CompiledItem] {
  return [itemId, {
    item_id: itemId, bot_state: "orderable", bot_state_reason: null,
    ask_plan: { compiled_at: T_COMPILED_AT, compiler_version: 1, display_name: "", base_price_cents: 0, steps: [], recap_template: "", ticket_template: "" },
    lexicon_terms: [],
  }];
}

const small = vitosCheeseItem(`Cheese - Small (10")`, 849, `Small (10")`);
const medium = vitosCheeseItem(`Cheese - Medium (14")`, 1250, `Medium (14")`);
const large = vitosCheeseItem(`Cheese - Large (16")`, 1650, `Large (16")`);
const compiled = new Map([orderable(small.id), orderable(medium.id), orderable(large.id)]);

const derivedRows = buildDerivedRows([small, medium, large], compiled, new Map(), T_COMPILED_AT);
const derivedLexicon: ResolveLexiconTerm[] = derivedRows.flatMap(r =>
  r.lexicon_terms.map(t => ({ term: t.term, target_id: t.target_id })),
);

const pepperoniIds = derivedRows.filter(r => r.product_key === "pizza:pepperoni").map(r => r.entity_key);
const sausageIds = derivedRows.filter(r => r.product_key === "pizza:sausage").map(r => r.entity_key);

Deno.test("BEFORE: with the empty lexicon that live Vito's actually had (no pepperoni-pizza terms at all), 'pepperoni pizza' is unresolved — this is the exact live defect Jason hit", () => {
  const result = resolveItem("pepperoni pizza", []);
  assertEquals(result, { kind: "unresolved" });
});

Deno.test("BEFORE: the live lexicon's only 'pepperoni' term pointed at the unrelated Stromboli Roll — a bare 'pepperoni' resolved to the wrong item, never a pizza", () => {
  const strombolERoll = "item-stromboli-pepperoni-roll";
  const liveVitosLexicon: ResolveLexiconTerm[] = [
    { term: "pepperoni", target_id: strombolERoll },
    { term: "pepperonis", target_id: strombolERoll },
  ];
  const result = resolveItem("pepperoni", liveVitosLexicon);
  assertEquals(result, { kind: "resolved", menu_item_id: strombolERoll });
});

Deno.test("AFTER: buildDerivedRows produced a pepperoni-pizza row for each of the 3 sizes (not zero, per the slot_key=null fix)", () => {
  assertEquals(pepperoniIds.length, 3);
  assertEquals(sausageIds.length, 3);
});

Deno.test("AFTER: Steak and Gyro Meat — real toppings NOT on the standard six-topping list — never get a derived pizza row", () => {
  const productKeys = new Set(derivedRows.map(r => r.product_key));
  assertEquals(productKeys.has("pizza:steak"), false);
  assertEquals(productKeys.has("pizza:gyro meat"), false);
});

Deno.test("AFTER: 'pepperoni pizza' with no size stated resolves to the pizza family, ambiguous across the 3 sizes — never unresolved, never the wrong item", () => {
  const result = resolveItem("pepperoni pizza", derivedLexicon);
  assertEquals(result.kind, "ambiguous");
  assertEquals(result.kind === "ambiguous" ? new Set(result.candidates) : null, new Set(pepperoniIds));
});

Deno.test("AFTER: 'large pepperoni pizza' resolves to exactly the Large Pepperoni Pizza — the size-qualified lexicon term does the narrowing resolveItem's plain longest-match couldn't do on its own", () => {
  const result = resolveItem("large pepperoni pizza", derivedLexicon);
  const wantId = derivedRows.find(r => r.product_key === "pizza:pepperoni" && r.name.includes("Large"))!.entity_key;
  assertEquals(result, { kind: "resolved", menu_item_id: wantId });
});

Deno.test("AFTER: bare 'pepperoni' (pizza-only lexicon) resolves to the pizza family, ambiguous across the 3 sizes", () => {
  const result = resolveItem("pepperoni", derivedLexicon);
  assertEquals(result.kind, "ambiguous");
  assertEquals(result.kind === "ambiguous" ? new Set(result.candidates) : null, new Set(pepperoniIds));
});

Deno.test("AFTER: 'sausage pizza' resolves the same way as pepperoni — this is a general compiler fix, not a pepperoni special case", () => {
  const result = resolveItem("sausage pizza", derivedLexicon);
  assertEquals(result.kind, "ambiguous");
  assertEquals(result.kind === "ambiguous" ? new Set(result.candidates) : null, new Set(sausageIds));
});

Deno.test("AFTER: 'you missed the large pepperoni pizza' (full sentence, real phrasing from Jason's live test) still resolves via the embedded size-qualified term", () => {
  const result = resolveItem("you missed the large pepperoni pizza", derivedLexicon);
  const wantId = derivedRows.find(r => r.product_key === "pizza:pepperoni" && r.name.includes("Large"))!.entity_key;
  assertEquals(result, { kind: "resolved", menu_item_id: wantId });
});
