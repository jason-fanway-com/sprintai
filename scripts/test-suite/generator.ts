/**
 * generator.ts — Builds menu-DERIVED test cases grounded in the shop's real
 * menus/menu_items rows. Every referenced item + expected price MUST come
 * from the DB. Never hallucinates an item name or price.
 *
 * Target: ~85 single-turn (menu-derived + library) + ~15 conversational = ~100 total.
 *
 * Returns AnyCase[] combining menu-derived cases + the static library + the
 * conversational suite (the NEW standard — multi-turn LLM-driven cases).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { LIBRARY_CASES, CONVERSATIONAL_CASES, type TestCase, type ConversationalCase, type AnyCase, type Turn, type SuccessCriterion } from "./library.ts";
import { buildCartOpsCases } from "./cart-ops.ts";
import { HOURS_CLOSED_CASES } from "./hours-closed.ts";

// ── DB Types ────────────────────────────────────────────────────────────────

interface MenuItemRow {
  id: string;
  name: string;
  description: string | null;
  price_cents: number;
  category: string;
  modifiers_json: Array<{ name: string; price_cents: number }> | null;
  active: boolean;
}

interface MenuRow {
  id: string;
  shop_id: string;
}

interface ShopRow {
  id: string;
  tenant_id: string;
  name: string;
  phone_number_e164: string | null;
  timezone: string;
  open_hours: Record<string, Array<{ open: string; close: string }>> | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function asDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function pickItem(items: MenuItemRow[], offset: number): MenuItemRow {
  return items[offset % items.length];
}

function pickItems(items: MenuItemRow[], count: number, offset: number): MenuItemRow[] {
  if (items.length === 0) return [];
  const step = Math.max(1, Math.floor(items.length / count));
  const selected: MenuItemRow[] = [];
  for (let i = 0; i < count; i++) {
    selected.push(items[(offset + i * step) % items.length]);
  }
  return selected;
}

function priceTotal(...cents: number[]): string {
  return asDollars(cents.reduce((a, b) => a + b, 0));
}

// ── Menu-derived case builders ──────────────────────────────────────────────

function singleItem(items: MenuItemRow[], offset: number, counter: number): TestCase {
  const item = pickItem(items, offset);
  const price = asDollars(item.price_cents);
  return {
    id: `menu-single-${counter}`,
    category: "happy-path",
    criticality: "critical",
    label: `Order single: ${item.name} (${price})`,
    turns: [{ role: "customer", message: `I'd like a ${item.name} please` }],
    success_criteria: [
      { id: "item_recognized", description: `Bot recognizes "${item.name}"`, check_id: "invented_item" },
      { id: "correct_price", description: `Bot acknowledges ${price}`, check_id: "wrong_total" },
    ],
    expectedItemCents: item.price_cents,
  };
}

function twoItems(items: MenuItemRow[], offset: number, counter: number): TestCase {
  const [a, b] = pickItems(items, 2, offset);
  const sum = a.price_cents + b.price_cents;
  const total = priceTotal(a.price_cents, b.price_cents);
  return {
    id: `menu-two-${counter}`,
    category: "happy-path",
    criticality: "critical",
    label: `Order two: ${a.name} + ${b.name}`,
    turns: [{ role: "customer", message: `I'd like a ${a.name} and a ${b.name}` }],
    success_criteria: [
      { id: "both_recognized", description: `Bot recognizes both items`, check_id: "ignored_modifier" },
      { id: "correct_total", description: `Total ~${total} plus service fee`, check_id: "wrong_total" },
    ],
    expectedItemCents: sum,
  };
}

function threeItems(items: MenuItemRow[], offset: number, counter: number): TestCase {
  const [a, b, c] = pickItems(items, 3, offset);
  const sum = a.price_cents + b.price_cents + c.price_cents;
  const total = priceTotal(a.price_cents, b.price_cents, c.price_cents);
  return {
    id: `menu-three-${counter}`,
    category: "happy-path",
    criticality: "critical",
    label: `Order three: ${a.name}, ${b.name}, ${c.name}`,
    turns: [{ role: "customer", message: `I'll take a ${a.name}, a ${b.name}, and a ${c.name}` }],
    success_criteria: [
      { id: "all_recognized", description: `Bot recognizes all 3 items`, check_id: "lost_cart" },
      { id: "correct_total", description: `Total ~${total} plus service fee`, check_id: "wrong_total" },
    ],
    expectedItemCents: sum,
  };
}

function withModifier(items: MenuItemRow[], offset: number, counter: number): TestCase {
  // Find an item that has modifiers
  const modItems = items.filter(i => i.modifiers_json && i.modifiers_json.length > 0);
  if (modItems.length === 0) return singleItem(items, offset, counter);
  const item = modItems[offset % modItems.length];
  const mods = item.modifiers_json!;
  const mod = mods[offset % mods.length];
  const sum = item.price_cents + mod.price_cents;
  const total = priceTotal(item.price_cents, mod.price_cents);
  return {
    id: `menu-modifier-${counter}`,
    category: "happy-path",
    criticality: "normal",
    label: `Order with modifier: ${item.name} + ${mod.name} (${total})`,
    turns: [{ role: "customer", message: `I'll have a ${item.name} with ${mod.name}` }],
    success_criteria: [
      { id: "modifier_applied", description: `Bot recognizes modifier "${mod.name}"`, check_id: "ignored_modifier" },
      { id: "correct_price", description: `Total reflects base + modifier`, check_id: "wrong_total" },
    ],
    expectedItemCents: sum,
  };
}

function checkoutFlow(items: MenuItemRow[], offset: number, counter: number): TestCase {
  const item = pickItem(items, offset);
  return {
    id: `menu-checkout-${counter}`,
    category: "happy-path",
    criticality: "critical",
    label: `Checkout flow: ${item.name} → yes → checkout`,
    turns: [
      { role: "customer", message: `I'll take a ${item.name}` },
      { role: "customer", message: "yes" },
      { role: "customer", message: "checkout" },
      // A pickup order requires a name; a real customer provides one when asked.
      // Without this turn the bot can never reach checkout (it must not invent a name),
      // making the case unwinnable — this supplies the name the bot correctly requires.
      { role: "customer", message: "Jason" },
    ],
    success_criteria: [
      { id: "reaches_checkout", description: "Bot reaches checkout phase", check_id: "order_not_completed" },
      { id: "no_wrong_price", description: "Price is correct", check_id: "wrong_total" },
    ],
    expects_checkout: true,
    expectedItemCents: item.price_cents,
  };
}

function greetingThenOrder(items: MenuItemRow[], offset: number, counter: number): TestCase {
  const item = pickItem(items, offset);
  return {
    id: `menu-greet-order-${counter}`,
    category: "happy-path",
    criticality: "normal",
    label: `Greeting → order: ${item.name}`,
    turns: [
      { role: "customer", message: "Hi!" },
      { role: "customer", message: `I'd like a ${item.name}` },
    ],
    success_criteria: [
      { id: "greeting_acknowledged", description: "Bot responds warmly" },
      { id: "order_accepted", description: `Bot correctly adds ${item.name}`, check_id: "invented_item" },
    ],
  };
}

function askForMenu(): TestCase {
  return {
    id: "menu-discover-ask-menu",
    category: "happy-path",
    criticality: "normal",
    label: "Customer asks what's on the menu",
    turns: [{ role: "customer", message: "What do you have?" }],
    success_criteria: [
      { id: "lists_menu_items", description: "Bot lists real menu items", check_id: "invented_item" },
      { id: "no_hallucination", description: "All mentioned items exist", check_id: "invented_item" },
    ],
  };
}

function dozenBagels(items: MenuItemRow[]): TestCase | null {
  const dozen = items.find(i => i.name.toLowerCase().includes("dozen bagels"));
  if (!dozen) return null;
  const price = asDollars(dozen.price_cents);
  return {
    id: "menu-baker-dozen",
    category: "happy-path",
    criticality: "normal",
    label: `Order a dozen bagels: ${price} (14-bagel quirk)`,
    turns: [
      { role: "customer", message: "I'd like a dozen bagels — mix of plain, everything, and sesame" },
    ],
    success_criteria: [
      { id: "offers_dozen", description: `Bot recognizes dozen order, may route to mix selection`, check_id: "ignored_modifier" },
      { id: "correct_price", description: `Price from menu: ${price}`, check_id: "wrong_total" },
    ],
  };
}

function creamCheeseByPound(items: MenuItemRow[]): TestCase | null {
  const cc = items.find(i => i.name.toLowerCase().includes("cream cheese") && i.name.toLowerCase().includes("pound"));
  if (!cc) return null;
  const price = asDollars(cc.price_cents);
  return {
    id: "menu-cream-cheese-pound",
    category: "happy-path",
    criticality: "normal",
    label: `Order cream cheese by the pound: ${cc.name} (${price})`,
    turns: [{ role: "customer", message: `Can I get a pound of ${cc.name.split("(")[0].trim().toLowerCase()}?` }],
    success_criteria: [
      { id: "recognizes_pound", description: `Bot recognizes cream cheese by-the-pound order`, check_id: "invented_item" },
    ],
  };
}

function halfDozen(items: MenuItemRow[]): TestCase | null {
  const hd = items.find(i => i.name.toLowerCase().includes("half dozen"));
  if (!hd) return null;
  return {
    id: "menu-half-dozen",
    category: "happy-path",
    criticality: "normal",
    label: `Order half-dozen bagels: ${asDollars(hd.price_cents)}`,
    turns: [{ role: "customer", message: "I'll take a half dozen bagels — 3 plain, 3 everything" }],
    success_criteria: [
      { id: "handles_half_dozen", description: "Bot handles half-dozen order", check_id: "invented_item" },
    ],
  };
}

function greekCorner(items: MenuItemRow[]): TestCase | null {
  const greek = items.filter(i => i.category?.toLowerCase().includes("greek"));
  if (greek.length === 0) return null;
  const item = greek[0];
  return {
    id: "menu-greek-corner",
    category: "happy-path",
    criticality: "normal",
    label: `Greek corner order: ${item.name} (${asDollars(item.price_cents)})`,
    turns: [{ role: "customer", message: `I'll try the ${item.name}` }],
    success_criteria: [
      { id: "greek_recognized", description: `Bot recognizes ${item.name}`, check_id: "invented_item" },
    ],
  };
}

function breakfastSandwich(items: MenuItemRow[]): TestCase | null {
  const bfast = items.filter(i => i.category?.toLowerCase().includes("breakfast"));
  if (bfast.length === 0) return null;
  const item = bfast[bfast.length > 1 ? 1 : 0]; // second item for variety
  return {
    id: "menu-breakfast-sandwich",
    category: "happy-path",
    criticality: "normal",
    label: `Breakfast sandwich: ${item.name} (${asDollars(item.price_cents)})`,
    turns: [{ role: "customer", message: `Can I get the ${item.name}?` }],
    success_criteria: [
      { id: "breakfast_recognized", description: `Bot recognizes ${item.name}`, check_id: "invented_item" },
    ],
  };
}

function omlettePlatter(items: MenuItemRow[]): TestCase | null {
  const omelettes = items.filter(i => i.category?.toLowerCase().includes("omelette"));
  if (omelettes.length === 0) return null;
  const item = omelettes[0];
  return {
    id: "menu-omelette",
    category: "happy-path",
    criticality: "normal",
    label: `Omelette platter: ${item.name} (${asDollars(item.price_cents)})`,
    turns: [{ role: "customer", message: `I'll have the ${item.name}` }],
    success_criteria: [
      { id: "omelette_recognized", description: `Bot recognizes ${item.name}`, check_id: "invented_item" },
    ],
  };
}

function coldSandwich(items: MenuItemRow[]): TestCase | null {
  const cold = items.filter(i => i.category?.toLowerCase().includes("cold sandwich"));
  if (cold.length === 0) return null;
  const item = cold[0];
  return {
    id: "menu-cold-sandwich",
    category: "happy-path",
    criticality: "normal",
    label: `Cold sandwich: ${item.name} (${asDollars(item.price_cents)})`,
    turns: [{ role: "customer", message: `I'll take a ${item.name} on a plain bagel` }],
    success_criteria: [
      { id: "cold_sandwich_recognized", description: `Bot recognizes ${item.name}`, check_id: "invented_item" },
    ],
  };
}

function hotSandwich(items: MenuItemRow[]): TestCase | null {
  const hot = items.filter(i => i.category?.toLowerCase().includes("hot sandwich"));
  if (hot.length === 0) return null;
  const item = hot[0];
  return {
    id: "menu-hot-sandwich",
    category: "happy-path",
    criticality: "normal",
    label: `Hot sandwich: ${item.name} (${asDollars(item.price_cents)})`,
    turns: [{ role: "customer", message: `Let me get a ${item.name}` }],
    success_criteria: [
      { id: "hot_sandwich_recognized", description: `Bot recognizes ${item.name}`, check_id: "invented_item" },
    ],
  };
}

function wrap(items: MenuItemRow[]): TestCase | null {
  const wraps = items.filter(i => i.category?.toLowerCase().includes("wrap"));
  if (wraps.length === 0) return null;
  const item = wraps[0];
  return {
    id: "menu-wrap",
    category: "happy-path",
    criticality: "normal",
    label: `Wrap: ${item.name} (${asDollars(item.price_cents)})`,
    turns: [{ role: "customer", message: `I'll have the ${item.name} please` }],
    success_criteria: [
      { id: "wrap_recognized", description: `Bot recognizes ${item.name}`, check_id: "invented_item" },
    ],
  };
}

function salad(items: MenuItemRow[]): TestCase | null {
  const salads = items.filter(i => i.category?.toLowerCase().includes("salad"));
  if (salads.length === 0) return null;
  const item = salads[0];
  return {
    id: "menu-salad",
    category: "happy-path",
    criticality: "normal",
    label: `Salad: ${item.name} (${asDollars(item.price_cents)})`,
    turns: [{ role: "customer", message: `Can I get a ${item.name}?` }],
    success_criteria: [
      { id: "salad_recognized", description: `Bot recognizes ${item.name}`, check_id: "invented_item" },
    ],
  };
}

function fryerItem(items: MenuItemRow[]): TestCase | null {
  const fryer = items.filter(i => i.category?.toLowerCase().includes("fryer"));
  if (fryer.length === 0) return null;
  const item = fryer[0];
  return {
    id: "menu-fryer",
    category: "happy-path",
    criticality: "normal",
    label: `Fryer item: ${item.name} (${asDollars(item.price_cents)})`,
    turns: [{ role: "customer", message: `I'll take the ${item.name}` }],
    success_criteria: [
      { id: "fryer_recognized", description: `Bot recognizes ${item.name}`, check_id: "invented_item" },
    ],
  };
}

function combo(items: MenuItemRow[]): TestCase | null {
  // Pick items from 3 different categories for a combo-style order
  const byCat: Record<string, MenuItemRow[]> = {};
  for (const item of items) {
    const cat = item.category ?? "Other";
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(item);
  }
  const catKeys = Object.keys(byCat).filter(k => k !== "Extras & Add-Ins" && k !== "Sides");
  if (catKeys.length < 3) return null;
  const a = byCat[catKeys[0]][0];
  const b = byCat[catKeys[1]][0];
  const c = byCat[catKeys[2]][0];
  const total = priceTotal(a.price_cents, b.price_cents, c.price_cents);
  return {
    id: "menu-combo",
    category: "happy-path",
    criticality: "normal",
    label: `Combo order across categories: ${a.name}, ${b.name}, ${c.name}`,
    turns: [{ role: "customer", message: `I want a ${a.name}, a ${b.name}, and a ${c.name}` }],
    success_criteria: [
      { id: "combo_recognized", description: "Bot handles multi-category order", check_id: "lost_cart" },
      { id: "correct_total", description: `Total ~${total} plus service fee`, check_id: "wrong_total" },
    ],
  };
}

function bagelWithSpread(items: MenuItemRow[]): TestCase | null {
  const bw = items.filter(i =>
    i.category?.toLowerCase().includes("bagel with") &&
    !i.name.toLowerCase().includes("butter")
  );
  if (bw.length === 0) return null;
  const item = bw[0];
  return {
    id: "menu-bagel-with-spread",
    category: "happy-path",
    criticality: "normal",
    label: `Bagel with spread: ${item.name} (${asDollars(item.price_cents)})`,
    turns: [{ role: "customer", message: `I'll have an ${item.name.toLowerCase()} on an everything bagel` }],
    success_criteria: [
      { id: "spread_recognized", description: `Bot recognizes bagel-with-spread order`, check_id: "invented_item" },
    ],
  };
}

function drinkCase(items: MenuItemRow[]): TestCase | null {
  // Look for drinks/beverages — word-boundary match to avoid false positives like "Steak" matching "tea"
  const drinkWords = /\b(coffee|soda|drink|snapple|bottled water|juice|tea|latte|espresso|cappuccino|smoothie|lemonade|milk)\b/i;
  const drinks = items.filter(i => drinkWords.test(i.name));
  if (drinks.length === 0) {
    // No drinks in menu — make a generic case about asking for a drink
    return {
      id: "menu-drink-request",
      category: "happy-path",
      criticality: "normal",
      label: "Customer asks for a drink — bot handles availability",
      turns: [{ role: "customer", message: "Do you have any coffee or drinks?" }],
      success_criteria: [
        { id: "drinks_answered", description: "Bot answers drink question truthfully", check_id: "invented_item" },
      ],
    };
  }
  const drink = drinks[0];
  return {
    id: "menu-drink",
    category: "happy-path",
    criticality: "normal",
    label: `Drink: ${drink.name} (${asDollars(drink.price_cents)})`,
    turns: [{ role: "customer", message: `Can I get a ${drink.name}?` }],
    success_criteria: [
      { id: "drink_recognized", description: `Bot recognizes ${drink.name}`, check_id: "invented_item" },
    ],
  };
}

function buildCrossCategorySingles(items: MenuItemRow[]): TestCase[] {
  const byCat: Record<string, MenuItemRow[]> = {};
  for (const item of items) {
    const cat = item.category ?? "Other";
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(item);
  }

  const cases: TestCase[] = [];
  let counter = items.length + 100; // high offset
  for (const [cat, catItems] of Object.entries(byCat)) {
    // One single-item case per category beyond the first few
    if (cat === "Extras & Add-Ins" || cat === "Sides") continue; // too trivial alone
    const item = catItems[0];
    cases.push({
      id: `menu-cat-${cat.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      category: "happy-path",
      criticality: "normal",
      label: `${cat}: ${item.name} (${asDollars(item.price_cents)})`,
      turns: [{ role: "customer", message: `I'd like the ${item.name}` }],
      success_criteria: [
        { id: "cat_item_recognized", description: `Bot recognizes "${item.name}"`, check_id: "invented_item" },
      ],
    });
    counter++;
  }
  return cases;
}

function bagelVarietySampler(items: MenuItemRow[]): TestCase[] {
  const bagels = items.filter(i => i.category?.toLowerCase() === "bagels" && !i.name.toLowerCase().includes("dozen") && !i.name.toLowerCase().includes("half"));
  if (bagels.length < 3) return [];

  const cases: TestCase[] = [];

  // Single bagel with specific type
  for (let i = 0; i < Math.min(6, bagels.length); i++) {
    const bg = bagels[i];
    cases.push({
      id: `menu-bagel-${i}`,
      category: "happy-path",
      criticality: "normal",
      label: `Bagel: ${bg.name} (${asDollars(bg.price_cents)})`,
      turns: [{ role: "customer", message: `Let me get a ${bg.name.toLowerCase()}` }],
      success_criteria: [
        { id: "bagel_recognized", description: `Bot recognizes ${bg.name}`, check_id: "invented_item" },
      ],
    });
  }

  return cases;
}

function loukoumadesVariety(items: MenuItemRow[]): TestCase[] {
  const louks = items.filter(i => i.category?.toLowerCase() === "loukoumades" && !i.name.toLowerCase().includes("additional"));
  if (louks.length < 2) return [];

  const cases: TestCase[] = [];
  for (let i = 0; i < Math.min(4, louks.length); i++) {
    const l = louks[i];
    cases.push({
      id: `menu-loukoumades-${i}`,
      category: "happy-path",
      criticality: "normal",
      label: `Loukoumades: ${l.name} (${asDollars(l.price_cents)})`,
      turns: [{ role: "customer", message: `I'll have the ${l.name.toLowerCase()}` }],
      success_criteria: [
        { id: "loukoumades_recognized", description: `Bot recognizes ${l.name}`, check_id: "invented_item" },
      ],
    });
  }
  return cases;
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface GenerateCasesInput {
  supabaseUrl: string;
  serviceRoleKey: string;
  shopId: string;
}

export interface GenerateCasesResult {
  cases: AnyCase[];
  shop: { id: string; name: string; tenant_id: string };
  menuItemCount: number;
  libraryCount: number;
  cartOpsCount: number;
  conversationalCount: number;
  derivedCount: number;
  hoursClosedCount: number;
}

/** Optional helper to avoid duplicates while building */
function pushCase(list: TestCase[], tc: TestCase | null) {
  if (!tc) return;
  if (list.some(c => c.id === tc.id)) return;
  list.push(tc);
}

export async function generateCases(input: GenerateCasesInput): Promise<GenerateCasesResult> {
  const supabase = createClient(input.supabaseUrl, input.serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data: shop, error: shopErr } = await supabase
    .from("shops")
    .select("id, tenant_id, name, phone_number_e164, timezone, open_hours")
    .eq("id", input.shopId)
    .single();
  if (shopErr || !shop) throw new Error(`Shop not found: ${input.shopId}`);

  const { data: menu } = await supabase
    .from("menus")
    .select("id")
    .eq("shop_id", input.shopId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!menu) {
    return {
      cases: [...LIBRARY_CASES, ...buildCartOpsCases([]), ...HOURS_CLOSED_CASES, ...CONVERSATIONAL_CASES],
      shop: { id: shop.id, name: shop.name, tenant_id: shop.tenant_id },
      menuItemCount: 0,
      libraryCount: LIBRARY_CASES.length,
      cartOpsCount: 0,
      conversationalCount: CONVERSATIONAL_CASES.length,
      derivedCount: 0,
      hoursClosedCount: HOURS_CLOSED_CASES.length,
    };
  }

  const { data: items } = await supabase
    .from("menu_items")
    .select("id, name, description, price_cents, category, modifiers_json, active")
    .eq("menu_id", menu.id)
    .eq("active", true)
    .order("display_order");
  const activeItems = (items ?? []) as MenuItemRow[];

  // ── Orderable standalone items ────────────────────────────────────────
  // Add-on / extra items ("Extras & Add-Ins" category, "Additional
  // Topping/Sauce/Filling" loukoumades, "Sides" like standalone turkey bacon)
  // are NOT valid standalone orders — the bot correctly treats them as add-ons
  // requiring a base item. Exclude them from single/multi-item happy-path
  // cases so we don't generate cases the product is right to decline.
  const orderableItems = activeItems.filter((i) => {
    const cat = (i.category ?? "").toLowerCase();
    if (cat === "extras & add-ins" || cat === "sides") return false;
    if (/additional topping\/sauce\/filling/i.test(i.name)) return false;
    return true;
  });
  // Fall back to all items if filtering emptied the pool (tiny menus).
  const orderPool = orderableItems.length > 0 ? orderableItems : activeItems;

  const derivedCases: TestCase[] = [];

  // ── Core happy-path (always) ───────────────────────────────────────────
  let ctr = 0;

  // Single-item orders from different positions across the menu
  pushCase(derivedCases, singleItem(orderPool, 0, ctr++));
  pushCase(derivedCases, singleItem(orderPool, Math.floor(orderPool.length / 8), ctr++));
  pushCase(derivedCases, singleItem(orderPool, Math.floor(orderPool.length / 4), ctr++));
  pushCase(derivedCases, singleItem(orderPool, Math.floor(orderPool.length / 2), ctr++));
  pushCase(derivedCases, singleItem(orderPool, Math.floor(orderPool.length * 3 / 4), ctr++));

  // Two-item orders
  pushCase(derivedCases, twoItems(orderPool, 0, ctr++));
  pushCase(derivedCases, twoItems(orderPool, Math.floor(orderPool.length / 3), ctr++));
  pushCase(derivedCases, twoItems(orderPool, Math.floor(orderPool.length * 2 / 3), ctr++));

  // Three-item order
  pushCase(derivedCases, threeItems(orderPool, 0, ctr++));

  // Modifier cases (pick from items with modifiers)
  pushCase(derivedCases, withModifier(orderPool, 0, ctr++));
  pushCase(derivedCases, withModifier(orderPool, 3, ctr++));

  // Checkout flows
  pushCase(derivedCases, checkoutFlow(orderPool, 0, ctr++));
  pushCase(derivedCases, checkoutFlow(orderPool, Math.floor(orderPool.length / 3), ctr++));

  // Greeting + order
  pushCase(derivedCases, greetingThenOrder(orderPool, 0, ctr++));
  pushCase(derivedCases, greetingThenOrder(orderPool, Math.floor(orderPool.length / 2), ctr++));

  // Ask for menu
  pushCase(derivedCases, askForMenu());

  // ── Category-specific cases ─────────────────────────────────────────────
  pushCase(derivedCases, dozenBagels(activeItems));
  pushCase(derivedCases, halfDozen(activeItems));
  pushCase(derivedCases, creamCheeseByPound(activeItems));
  pushCase(derivedCases, greekCorner(activeItems));
  pushCase(derivedCases, breakfastSandwich(activeItems));
  pushCase(derivedCases, omlettePlatter(activeItems));
  pushCase(derivedCases, coldSandwich(activeItems));
  pushCase(derivedCases, hotSandwich(activeItems));
  pushCase(derivedCases, wrap(activeItems));
  pushCase(derivedCases, salad(activeItems));
  pushCase(derivedCases, fryerItem(activeItems));
  pushCase(derivedCases, combo(activeItems));
  pushCase(derivedCases, bagelWithSpread(activeItems));
  pushCase(derivedCases, drinkCase(activeItems));

  // ── Cross-category singles ─────────────────────────────────────────────
  for (const tc of buildCrossCategorySingles(activeItems)) {
    pushCase(derivedCases, tc);
  }

  // ── Bagel variety ──────────────────────────────────────────────────────
  for (const tc of bagelVarietySampler(activeItems)) {
    pushCase(derivedCases, tc);
  }

  // ── Loukoumades variety ────────────────────────────────────────────────
  for (const tc of loukoumadesVariety(activeItems)) {
    pushCase(derivedCases, tc);
  }

  // ── More single-item orders for reach to ~69 derived ─────────────────────
  // 69 menu-derived + 16 library = 85 single-turn; + 15 conversational = 100.
  let fillCtr = 500;
  while (derivedCases.length < 69 && fillCtr < 600) {
    const pos = (fillCtr - 500) * Math.floor(orderPool.length / 20);
    const tc = singleItem(orderPool, pos, fillCtr);
    if (!derivedCases.some(c => c.id === tc.id)) {
      derivedCases.push(tc);
    }
    fillCtr++;
  }

  // ═══ CartOps cases (shop-aware, built from real menu items) ══════════
  const cartOpsCases = buildCartOpsCases(activeItems);

  return {
    cases: [...derivedCases, ...LIBRARY_CASES, ...cartOpsCases, ...HOURS_CLOSED_CASES, ...CONVERSATIONAL_CASES],
    shop: { id: shop.id, name: shop.name, tenant_id: shop.tenant_id },
    menuItemCount: activeItems.length,
    libraryCount: LIBRARY_CASES.length,
    cartOpsCount: cartOpsCases.length,
    conversationalCount: CONVERSATIONAL_CASES.length,
    derivedCount: derivedCases.length,
    hoursClosedCount: HOURS_CLOSED_CASES.length,
  };
}