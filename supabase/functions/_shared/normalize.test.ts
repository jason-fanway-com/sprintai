/**
 * normalize.ts — unit tests (docs/specs/2026-09-07-conversation-ready-menu-design.md
 * §3 stage 3, §11 item 2).
 *
 * Two groups:
 *  - Synthetic fixtures covering each rule in isolation (size folding, "X or
 *    Y" in a name, "choice of A, B or C" in a description, the negative case
 *    where a comma list with no trailing "or" must NOT become a slot,
 *    display_name rules, duplicate qualification, `name` preservation).
 *  - Live-data tests against Vito's real menu_items (shop_id
 *    e0000000-0000-0000-0000-000000000001), the acceptance bar §11 item 2
 *    states directly: pizzas fold well under their raw row count, the real
 *    "Gyro (Beef or Chicken)" rows produce a [Beef, Chicken] slot, and the
 *    real "Chicken Caesar" collision (Salads vs Wraps) gets qualified.
 *
 * Run: deno test --allow-net --allow-env --allow-read supabase/functions/_shared/normalize.test.ts
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { normalizeMenuItems, pickDescriptionSlot, type RawMenuItemRow } from "./normalize.ts";

function row(overrides: Partial<RawMenuItemRow>): RawMenuItemRow {
  return {
    id: crypto.randomUUID(),
    name: "Item",
    description: null,
    category: "Category",
    price_cents: 100,
    size_label: null,
    ...overrides,
  };
}

// ---- Size folding into product_key (general, not pizza-specific) ----------

Deno.test("size folding: three pizza-size rows fold to one product_key, each keeps its own size_label", () => {
  const rows = [
    row({ name: "Cheese - Small (10\")", category: "Pizza", size_label: "Small (10\")" }),
    row({ name: "Cheese - Medium (14\")", category: "Pizza", size_label: "Medium (14\")" }),
    row({ name: "Cheese - Large (16\")", category: "Pizza", size_label: "Large (16\")" }),
  ];
  const out = normalizeMenuItems(rows);
  const keys = new Set(out.map(i => i.product_key));
  assertEquals(keys.size, 1);
  assertEquals(out[0].product_key, "pizza:cheese");
  assertEquals(out.map(i => i.size_label), ["Small (10\")", "Medium (14\")", "Large (16\")"]);
});

Deno.test("size folding: works on a non-pizza category (soups, cup/bowl) — the rule is general", () => {
  const rows = [
    row({ name: "Chicken Noodle - Cup", category: "Soups", size_label: "Cup" }),
    row({ name: "Chicken Noodle - Bowl", category: "Soups", size_label: "Bowl" }),
  ];
  const out = normalizeMenuItems(rows);
  assertEquals(out[0].product_key, out[1].product_key);
  assertEquals(out[0].product_key, "soups:chicken-noodle");
});

Deno.test("size folding: different base names in the same category do NOT fold together", () => {
  const rows = [
    row({ name: "Cheese - Small (10\")", category: "Pizza", size_label: "Small (10\")" }),
    row({ name: "Veggie - Small (10\")", category: "Pizza", size_label: "Small (10\")" }),
  ];
  const out = normalizeMenuItems(rows);
  assert(out[0].product_key !== out[1].product_key);
});

// ---- "X or Y" in the name -> a stated slot ---------------------------------

Deno.test("'X or Y' in the name becomes a slot and display_name drops the clause", () => {
  const out = normalizeMenuItems([
    row({ name: "Gyro (Beef or Chicken)", category: "Sandwiches", price_cents: 1099 }),
  ]);
  assertEquals(out[0].display_name, "Gyro");
  assertEquals(out[0].slots.length, 1);
  assertEquals(out[0].slots[0].source, "name");
  assertEquals(out[0].slots[0].choices.map(c => c.display_name), ["Beef", "Chicken"]);
});

Deno.test("'X, Y or Z' in the name (three-way) splits into three choices", () => {
  const out = normalizeMenuItems([
    row({ name: "Wrap (Chicken, Beef or Falafel)", category: "Wraps" }),
  ]);
  assertEquals(out[0].display_name, "Wrap");
  assertEquals(out[0].slots[0].choices.map(c => c.display_name), ["Chicken", "Beef", "Falafel"]);
});

Deno.test("a parenthetical WITHOUT 'or' is not mistaken for a slot", () => {
  const out = normalizeMenuItems([
    row({ name: "Chicken Nuggets (5)", category: "Kids' Menu" }),
  ]);
  assertEquals(out[0].slots.length, 0);
  assertEquals(out[0].display_name, "Chicken Nuggets (5)");
});

// ---- "choice of A, B or C" in the description -> a stated slot ------------

Deno.test("'choice of A, B or C' in the description becomes a slot", () => {
  const out = normalizeMenuItems([
    row({ name: "Turkey Club", description: "Served with choice of white, wheat or rye.", category: "Cold Sandwiches" }),
  ]);
  assertEquals(out[0].slots.length, 1);
  assertEquals(out[0].slots[0].source, "description");
  assertEquals(out[0].slots[0].choices.map(c => c.display_name), ["White", "Wheat", "Rye"]);
});

Deno.test("'choice of A, B, C' with NO trailing 'or' does NOT become a slot (real Vito's Entrees text)", () => {
  // Real text: "Served with choice of pasta, garlic knots, side salad." Garlic
  // knots and side salad are included, not alternatives to pasta — inventing
  // a 3-way slot here would be exactly the kind of restaurant-specific
  // invention §4.3 forbids.
  const out = normalizeMenuItems([
    row({ name: "Chicken Parmesan", description: "Served with choice of pasta, garlic knots, side salad", category: "Entrees" }),
  ]);
  assertEquals(out[0].slots.length, 0);
});

Deno.test("'choice of <label> (A, B, ..., Z)' becomes a slot even with no trailing 'or' — the parenthetical is its own structural signal (real NJB text)", () => {
  // Real text, item id c56512e1-51f4-43ba-bb31-7a1069157ae8: a customer-caught
  // gap where this produced an inferred owner_questions row instead of a
  // stated slot, spending an owner tap that wasn't needed. Distinguishable
  // from the Vito's case directly above by the parenthetical enumeration
  // right after "choice of" — both rules must coexist.
  const out = normalizeMenuItems([
    row({
      name: "Bagel with Flavored Cream Cheese",
      description: "Bagel with choice of flavored cream cheese (Walnut Raisin, Scallion, Strawberry, Blueberry, Olive, Sun-Dried Tomato, Garlic Herb, Garden Vegetable, Jalapeño Cheddar, Chocolate Chip).",
      category: "Bagels",
    }),
  ]);
  assertEquals(out[0].slots.length, 1);
  assertEquals(out[0].slots[0].source, "description");
  assertEquals(out[0].slots[0].choices.map(c => c.display_name), [
    "Walnut Raisin", "Scallion", "Strawberry", "Blueberry", "Olive",
    "Sun-Dried Tomato", "Garlic Herb", "Garden Vegetable", "Jalapeño Cheddar", "Chocolate Chip",
  ]);
});

Deno.test("a bare description parenthetical list becomes a slot even with NO 'choice of' anchor at all (real NJB text, PO-flagged second instance)", () => {
  // Real text, item id 3bbc0c46-f41e-477e-a1a2-d84236bafcaf: same 10 flavors
  // as the "Bagel with Flavored Cream Cheese" case above, sold as its own
  // line item with different wording that never says "choice of" — "Flavored
  // homemade cream cheese spread (Walnut Raisin, ..., Chocolate Chip), sold
  // by the pound." The parenthetical enumeration alone is the signal.
  const out = normalizeMenuItems([
    row({
      name: "Flavored Cream Cheese Spread (per pound)",
      description: "Flavored homemade cream cheese spread (Walnut Raisin, Scallion, Strawberry, Blueberry, Olive, Sun-Dried Tomato, Garlic Herb, Garden Vegetable, Jalapeño Cheddar, Chocolate Chip), sold by the pound.",
      category: "Homemade Cream Cheese Spreads",
    }),
  ]);
  assertEquals(out[0].slots.length, 1);
  assertEquals(out[0].slots[0].source, "description");
  assertEquals(out[0].slots[0].choices.map(c => c.display_name), [
    "Walnut Raisin", "Scallion", "Strawberry", "Blueberry", "Olive",
    "Sun-Dried Tomato", "Garlic Herb", "Garden Vegetable", "Jalapeño Cheddar", "Chocolate Chip",
  ]);
});

Deno.test("Oxford-comma 'A, B, or C' does not leak a bogus 'Or C' choice (real NJB text, found auditing the parenthetical fix)", () => {
  // Real text: "on choice of bagel, bread, or roll." The comma before "or"
  // put "or roll" as its own comma segment with no *leading* whitespace for
  // the mid-segment `\s+or\s+` split to match, so it fell through unsplit
  // and title-cased to the customer-facing "Or Roll" instead of "Roll".
  const out = normalizeMenuItems([
    row({ name: "Grilled Cheese", description: "Grilled cheese on choice of bagel, bread, or roll.", category: "Sandwiches" }),
  ]);
  assertEquals(out[0].slots[0].choices.map(c => c.display_name), ["Bagel", "Bread", "Roll"]);
});

// ---- Multi-clause descriptions: 4 real NJB shapes (2026-09-08 parser extension) ---

Deno.test("'choice of A, B, or C' (Oxford comma, standalone) becomes a 3-way unlabeled slot (real NJB Breakfast Sandwiches text)", () => {
  const out = normalizeMenuItems([
    row({ name: "Turkey Bacon, Egg & Cheese", description: "Turkey bacon, egg & cheese on choice of bagel, bread, or roll.", category: "Breakfast Sandwiches" }),
  ]);
  assertEquals(out[0].slots.length, 1);
  assertEquals(out[0].slots[0].source, "description");
  assertEquals(out[0].slots[0].label, undefined);
  assertEquals(out[0].slots[0].choices.map(c => c.display_name), ["Bagel", "Bread", "Roll"]);
});

Deno.test("'choice of A or B' (no comma) becomes a 2-way unlabeled slot (real NJB Omelette Platter text)", () => {
  const out = normalizeMenuItems([
    row({ name: "Two Eggs Any Style Platter", description: "Two eggs any style served with home fries or hash brown and choice of bagel or toast.", category: "Omelette & Egg Platters" }),
  ]);
  assertEquals(out[0].slots.length, 1);
  assertEquals(out[0].slots[0].label, undefined);
  assertEquals(out[0].slots[0].choices.map(c => c.display_name), ["Bagel", "Toast"]);
});

Deno.test("'choice of X (A, B, C, or D)' becomes a slot LABELED with X (real NJB 'Meat Side' text)", () => {
  const out = normalizeMenuItems([
    row({ name: "Meat Side", description: "Choice of meat (Bacon, Ham, Sausage, or Pork Roll).", category: "Sides" }),
  ]);
  assertEquals(out[0].slots.length, 1);
  assertEquals(out[0].slots[0].label, "meat");
  assertEquals(out[0].slots[0].choices.map(c => c.display_name), ["Bacon", "Ham", "Sausage", "Pork Roll"]);
});

Deno.test("'choice of N <thing>' becomes a MODIFIER (max_select N), not a slot (real NJB 'Veggie Omelette Platter' text)", () => {
  const out = normalizeMenuItems([
    row({ name: "Veggie Omelette Platter", description: "Omelette with choice of three veggies. Served with home fries or hash brown and choice of bagel or toast.", category: "Omelette & Egg Platters" }),
  ]);
  assertEquals(out[0].modifiers.length, 1);
  assertEquals(out[0].modifiers[0].max_select, 3);
  assertEquals(out[0].modifiers[0].source_span, "choice of three veggies");
  // the OTHER "choice of" clause in the same description (bagel or toast)
  // must still land as its own slot — the modifier and the slot coexist.
  assertEquals(out[0].slots.length, 1);
  assertEquals(out[0].slots[0].choices.map(c => c.display_name), ["Bagel", "Toast"]);
});

Deno.test("a compound 'choice of 1 A, 1 B & 2 C' decomposes into 3 modifiers when every segment parses cleanly (real NJB 'Build Your Own Omelette Platter' text)", () => {
  const out = normalizeMenuItems([
    row({ name: "Build Your Own Omelette Platter", description: "3 eggs with choice of 1 meat, 1 cheese & 2 vegetables. Served with home fries or hash brown and choice of bagel or toast.", category: "Omelette & Egg Platters" }),
  ]);
  assertEquals(out[0].modifiers.map(m => [m.slot_key, m.max_select]), [
    ["meat", 1], ["cheese", 1], ["vegetable", 2],
  ]);
  assertEquals(out[0].slots.length, 1);
  assertEquals(out[0].slots[0].choices.map(c => c.display_name), ["Bagel", "Toast"]);
});

Deno.test("a comma list with no leading quantity and no trailing 'or' produces neither a slot nor a modifier (real NJB 'Chicken Cutlet Sandwich' text)", () => {
  const out = normalizeMenuItems([
    row({ name: "Chicken Cutlet Sandwich", description: "Chicken cutlet with choice of cheese, mayo, lettuce, tomatoes and onions on roll.", category: "Hot Sandwiches" }),
  ]);
  assertEquals(out[0].slots.length, 0);
  assertEquals(out[0].modifiers.length, 0);
});

Deno.test("two bare 'choice of' clauses in one description (no list, no quantity on either) produce neither a slot nor a modifier (real NJB 'Turkey Melt' text)", () => {
  const out = normalizeMenuItems([
    row({ name: "Turkey Melt", description: "Turkey with choice of cheese & grilled tomatoes on choice of bread.", category: "Hot Sandwiches" }),
  ]);
  assertEquals(out[0].slots.length, 0);
  assertEquals(out[0].modifiers.length, 0);
});

Deno.test("two-clause description picks the item's own label-then-bind: pickDescriptionSlot prefers the unlabeled bread list over the labeled meat sub-clause (real NJB 'Meat Only Breakfast Sandwich' text, root cause of the toast/bread mis-bind)", () => {
  const out = normalizeMenuItems([
    row({
      name: "Meat Only Breakfast Sandwich",
      description: "Choice of meat (Bacon, Ham, Sausage, or Pork Roll) on choice of bagel, bread, or roll.",
      category: "Breakfast Sandwiches",
    }),
  ]);
  assertEquals(out[0].slots.length, 2);
  const picked = pickDescriptionSlot(out[0]);
  assert(picked, "expected a description slot to be picked");
  assertEquals(picked!.label, undefined);
  assertEquals(picked!.choices.map(c => c.display_name), ["Bagel", "Bread", "Roll"]);
});

Deno.test("two-clause description (meat + toast) picks toast, not meat — real NJB 'Bacon, Sausage, Ham or Pork Roll Omelette Platter' text (this exact real item motivated archetypes.test.ts's 'Melvin finding, Bug 2')", () => {
  const out = normalizeMenuItems([
    row({
      name: "Bacon, Sausage, Ham or Pork Roll Omelette Platter",
      description: "Omelette with choice of meat (Bacon, Sausage, Ham, or Pork Roll). Served with home fries or hash brown and choice of bagel or toast.",
      category: "Omelette & Egg Platters",
    }),
  ]);
  const picked = pickDescriptionSlot(out[0]);
  assert(picked, "expected a description slot to be picked");
  assertEquals(picked!.label, undefined);
  assertEquals(picked!.choices.map(c => c.display_name), ["Bagel", "Toast"]);
});

// ---- display_name rules -----------------------------------------------------

Deno.test("display_name drops a category suffix that restates the item's own category", () => {
  const out = normalizeMenuItems([
    row({ name: "Chicken Caesar (Salads)", category: "Salads" }),
  ]);
  assertEquals(out[0].display_name, "Chicken Caesar");
});

Deno.test("display_name title-cases a lowercase name", () => {
  const out = normalizeMenuItems([
    row({ name: "garlic knots", category: "Appetizers" }),
  ]);
  assertEquals(out[0].display_name, "Garlic Knots");
});

Deno.test("`name` (source/POS name) is never mutated", () => {
  const out = normalizeMenuItems([
    row({ name: "Gyro (Beef or Chicken)", category: "Sandwiches" }),
  ]);
  assertEquals(out[0].name, "Gyro (Beef or Chicken)");
});

// ---- Duplicate display-name qualification (full-set pass) -----------------

Deno.test("two orderable items sharing a display_name get qualified with their category noun", () => {
  const out = normalizeMenuItems([
    row({ name: "Chicken Caesar", category: "Salads" }),
    row({ name: "Chicken Caesar", category: "Wraps" }),
  ]);
  const byCat = Object.fromEntries(out.map(i => [i.category, i.display_name]));
  assertEquals(byCat["Salads"], "Chicken Caesar Salad");
  assertEquals(byCat["Wraps"], "Chicken Caesar Wrap");
});

Deno.test("qualification only fires across categories, not between two sizes of the same folded product", () => {
  const out = normalizeMenuItems([
    row({ name: "Cheese - Small (10\")", category: "Pizza", size_label: "Small (10\")" }),
    row({ name: "Cheese - Large (16\")", category: "Pizza", size_label: "Large (16\")" }),
  ]);
  // Different size prefixes already make these distinct — no qualification needed.
  assertEquals(out[0].display_name, "Small Cheese Pizza");
  assertEquals(out[1].display_name, "Large Cheese Pizza");
});

Deno.test("qualification is a full-set pass: a 3rd unrelated item does not prevent the other two from colliding+qualifying", () => {
  const out = normalizeMenuItems([
    row({ name: "House", category: "Salads" }),
    row({ name: "Chicken Caesar", category: "Salads" }),
    row({ name: "Chicken Caesar", category: "Wraps" }),
  ]);
  assertEquals(out[0].display_name, "House"); // unaffected — no collision
  assertEquals(out[1].display_name, "Chicken Caesar Salad");
  assertEquals(out[2].display_name, "Chicken Caesar Wrap");
});

// ---- Live data: real Vito's menu_items --------------------------------------
// shop_id e0000000-0000-0000-0000-000000000001, per §11 item 2's acceptance bar.

// Deno.env.get() throws NotCapable under a bare `deno test` (no --allow-env),
// which would crash the whole file at load and take the 14 synthetic tests
// down with it. Catch that so the file always loads; no credentials just
// means the 4 live tests below evaluate `ignore: true` and self-skip.
function readEnv(name: string): string {
  try {
    return Deno.env.get(name) ?? "";
  } catch {
    return "";
  }
}

const SUPABASE_URL = readEnv("SPRINTAI_CHAT_SUPABASE_URL");
const SUPABASE_KEY = readEnv("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY");
const SHOP_ID = "e0000000-0000-0000-0000-000000000001";

async function fetchVitosRows(): Promise<RawMenuItemRow[]> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  const { data: menus, error: menuErr } = await supabase
    .from("menus")
    .select("id")
    .eq("shop_id", SHOP_ID)
    .limit(1);
  if (menuErr) throw menuErr;
  const menuId = menus?.[0]?.id;
  if (!menuId) throw new Error(`no menu found for shop ${SHOP_ID}`);

  const { data, error } = await supabase
    .from("menu_items")
    .select("id,name,description,price_cents,category,size_label")
    .eq("menu_id", menuId);
  if (error) throw error;
  return (data ?? []) as RawMenuItemRow[];
}

Deno.test({
  name: "live: Vito's pizza rows fold to well under the raw row count",
  ignore: !SUPABASE_URL || !SUPABASE_KEY,
  async fn() {
    const rows = await fetchVitosRows();
    const pizzaRows = rows.filter(r => r.category === "Pizza");
    assert(pizzaRows.length >= 62, `expected >= 62 raw pizza rows, got ${pizzaRows.length}`);

    const normalized = normalizeMenuItems(rows).filter(i => i.category === "Pizza");
    const productKeys = new Set(normalized.map(i => i.product_key));
    assert(
      productKeys.size < pizzaRows.length * 0.5,
      `expected pizza product_key count well under raw row count; got ${productKeys.size} products from ${pizzaRows.length} rows`,
    );
  },
});

Deno.test({
  name: "live: Vito's 'Gyro (Beef or Chicken)' rows produce a [Beef, Chicken] slot",
  ignore: !SUPABASE_URL || !SUPABASE_KEY,
  async fn() {
    const rows = await fetchVitosRows();
    const normalized = normalizeMenuItems(rows);
    const gyros = normalized.filter(i => i.name === "Gyro (Beef or Chicken)");
    assert(gyros.length >= 1, "expected at least one 'Gyro (Beef or Chicken)' row in Vito's live data");
    for (const g of gyros) {
      assertEquals(g.slots.length, 1);
      assertEquals(g.slots[0].choices.map(c => c.display_name), ["Beef", "Chicken"]);
      assertEquals(g.name, "Gyro (Beef or Chicken)"); // name untouched
    }
  },
});

Deno.test({
  name: "live: Vito's 'Chicken Caesar' collides across Salads/Wraps and gets qualified",
  ignore: !SUPABASE_URL || !SUPABASE_KEY,
  async fn() {
    const rows = await fetchVitosRows();
    const normalized = normalizeMenuItems(rows);
    const caesars = normalized.filter(i => i.name === "Chicken Caesar");
    assert(caesars.length >= 2, "expected 'Chicken Caesar' in more than one Vito's category");

    const salad = caesars.find(i => i.category === "Salads");
    const wrap = caesars.find(i => i.category === "Wraps");
    assert(salad, "expected a Salads 'Chicken Caesar' row");
    assert(wrap, "expected a Wraps 'Chicken Caesar' row");
    assertEquals(salad!.display_name, "Chicken Caesar Salad");
    assertEquals(wrap!.display_name, "Chicken Caesar Wrap");
  },
});

Deno.test({
  name: "live: normalizeMenuItems produces no cross-category display_name collisions across the whole Vito's menu",
  ignore: !SUPABASE_URL || !SUPABASE_KEY,
  async fn() {
    const rows = await fetchVitosRows();
    const normalized = normalizeMenuItems(rows);
    const byName = new Map<string, Set<string>>();
    for (const item of normalized) {
      const key = item.display_name.toLowerCase();
      const cats = byName.get(key) ?? new Set<string>();
      cats.add(item.category ?? "");
      byName.set(key, cats);
    }
    const stillColliding = [...byName.entries()].filter(([, cats]) => cats.size > 1);
    assertEquals(stillColliding, [], `display_name collisions survived qualification: ${JSON.stringify(stillColliding.map(([n]) => n))}`);
  },
});
