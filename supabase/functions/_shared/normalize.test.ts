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
import { normalizeMenuItems, type RawMenuItemRow } from "./normalize.ts";

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
