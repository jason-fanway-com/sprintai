/**
 * category-coverage.ts — one realistic, multi-item-capable order per menu
 * category, built entirely from the shop's own live menu/option data.
 *
 * Menu-AGNOSTIC (same principle library.ts states about itself): never
 * hardcodes an item name, option-group name, or choice name. Every case is
 * derived at generation time from menu_items/option_groups/option_choices
 * for the given shopId, so this works for any shop's category set, not just
 * Vito's.
 *
 * Each case scripts:
 *   a. order the item in natural language
 *   b. one follow-up turn per required option group, in display order,
 *      naming a real choice from option_choices
 *   c. a closing turn ("that's it") to reach checkout, plus the pickup name
 *      turn the bot requires to actually finalize (see checkoutFlow() in
 *      generator.ts for the same convention — "checkout" alone cannot
 *      complete without a name, so the case would be unwinnable without it)
 *
 * expectedLineCount: 1 and expects_checkout: true so the new
 * verifyRequiredOptionsCovered + expectedLineCount invariants, plus the
 * existing verifyStatedTotal/verifyCheckoutFinalize, all grade the case.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import type { TestCase, Turn } from "./library.ts";

interface ActiveItemRow {
  id: string;
  name: string;
  category: string;
  price_cents: number;
  display_order: number;
}

interface OptionGroupRow {
  id: string;
  name: string;
  display_order: number;
  menu_item_id: string;
}

interface OptionChoiceRow {
  id: string;
  name: string;
  is_default: boolean;
  display_order: number;
  option_group_id: string;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
}

/**
 * Natural, singular phrase to disambiguate an item by category in a customer
 * message — e.g. "the House salad" vs "the House stromboli". Vito's real
 * menu reuses bare names across categories ("House" is both a Salad and a
 * Stromboli; "Buffalo Chicken" is both a Pizza and a Flatbread; "Buffalo
 * Chicken Cheesesteak" is a Homemade Panini AND a Hot Sandwich) — ordering by
 * the bare name alone is genuinely ambiguous on the real menu, not just to
 * this harness, and the bot correctly asks a clarifying question the script
 * doesn't anticipate (2026-09-07 investigation of category-coverage-salads /
 * -flatbreads / -homemade-paninis: all three failed this way, not from a
 * missing-required-option gap).
 */
const CATEGORY_ORDER_QUALIFIER: Record<string, string> = {
  "Pizza": "pizza",
  "Wings": "wings",
  "Angus Burgers & Specialty": "burger",
  "Cold Sandwiches": "cold sandwich",
  "Hot Sandwiches": "hot sandwich",
  "Homemade Paninis": "panini",
  "Wraps": "wrap",
  "Salads": "salad",
  "Flatbreads": "flatbread",
  "Stromboli": "stromboli",
  "Appetizers": "appetizer",
};

/**
 * True when another active item on the shop's menu, in a DIFFERENT category,
 * shares (or is prefixed by) this item's exact name — e.g. "Buffalo Chicken"
 * (Flatbreads) vs "Buffalo Chicken - Small (10")" (Pizza). A prefix match
 * counts because that's exactly the pattern the bot's own disambiguation
 * questions reveal it collides on.
 */
function isNameAmbiguousAcrossCategories(item: ActiveItemRow, allItems: ActiveItemRow[]): boolean {
  const name = item.name.trim().toLowerCase();
  return allItems.some((other) => {
    if (other.id === item.id || other.category === item.category) return false;
    const otherName = other.name.trim().toLowerCase();
    return otherName === name || otherName.startsWith(`${name} `) || name.startsWith(`${otherName} `);
  });
}

export async function buildCategoryCoverageCases(
  shopId: string,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<TestCase[]> {
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data: menu } = await supabase
    .from("menus")
    .select("id")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (!menu) return [];

  // Real gap, found running this harness against Zio's/NJB for the first
  // time tonight (2026-09-08): CATEGORY_COVERAGE_TARGET_CATEGORIES is a
  // literal list of Vito's own category names. Filtering by it here meant
  // only a shop's categories that happen to share Vito's EXACT spelling
  // ("Pizza," "Wraps," "Salads") were ever covered — Zio's "Burgers" (not
  // "Angus Burgers & Specialty"), "Cold Subs"/"Hot Subs" (not "Cold/Hot
  // Sandwiches"), "Paninis" (not "Homemade Paninis") would have been
  // silently skipped, and the file's own header claims "menu-agnostic...
  // works for any shop's category set, not just Vito's" — the
  // implementation didn't match that claim. Fixed by deriving the category
  // set from the shop's own active items instead of a fixed list — every
  // real category with at least one active item gets a case, for any shop.
  const { data: items } = await supabase
    .from("menu_items")
    .select("id, name, category, price_cents, display_order")
    .eq("menu_id", menu.id)
    .eq("active", true)
    .order("display_order");
  const activeItems = (items ?? []) as ActiveItemRow[];
  if (activeItems.length === 0) return [];
  const targetCategories = [...new Set(activeItems.map((i) => i.category))];

  const itemIds = activeItems.map((i) => i.id);
  const { data: groups } = await supabase
    .from("option_groups")
    .select("id, name, display_order, menu_item_id")
    .in("menu_item_id", itemIds)
    .eq("required", true)
    .order("display_order");
  const groupRows = (groups ?? []) as OptionGroupRow[];

  const groupIds = groupRows.map((g) => g.id);
  const choiceRows: OptionChoiceRow[] = groupIds.length
    ? (((await supabase
        .from("option_choices")
        .select("id, name, is_default, display_order, option_group_id")
        .in("option_group_id", groupIds)
        .order("display_order")).data ?? []) as OptionChoiceRow[])
    : [];

  const choicesByGroup = new Map<string, OptionChoiceRow[]>();
  for (const c of choiceRows) {
    const arr = choicesByGroup.get(c.option_group_id) ?? [];
    arr.push(c);
    choicesByGroup.set(c.option_group_id, arr);
  }

  const groupsByItem = new Map<string, OptionGroupRow[]>();
  for (const g of groupRows) {
    const arr = groupsByItem.get(g.menu_item_id) ?? [];
    arr.push(g);
    groupsByItem.set(g.menu_item_id, arr);
  }
  for (const arr of groupsByItem.values()) {
    arr.sort((a, b) => a.display_order - b.display_order);
  }

  const cases: TestCase[] = [];

  for (const category of targetCategories) {
    const itemsInCategory = activeItems
      .filter((i) => i.category === category)
      .sort((a, b) => a.display_order - b.display_order);
    if (itemsInCategory.length === 0) continue;

    // Exclude price_cents=0 rows — these are modifier/finish CHOICES stored
    // as standalone menu_items rows (e.g. Vito's "Bleu Cheese" under "Pizza
    // Finish (Buffalo Chicken)"), not independently orderable products. The
    // live bot correctly refuses to add them as a standalone order, so
    // scripting "can I get a Bleu Cheese?" as a direct order produces
    // whatever ad-hoc conversation the bot actually has — not the order this
    // case assumes — and expectedItemCents: 0 combined with the real $0.99
    // service-fee-only cart then trips the cartops quoted-total invariant on
    // an assertion this case was never entitled to make (2026-09-10 Vito's
    // run 9bc5adab, case category-coverage-pizza-finish-buffalo-chicken).
    const orderableItems = itemsInCategory.filter((i) => i.price_cents > 0);
    if (orderableItems.length === 0) {
      console.log(
        `category-coverage: skipping category "${category}" — all ${itemsInCategory.length} active item(s) ` +
        `have price_cents=0 (modifier-choice rows, not independently orderable)`,
      );
      continue;
    }

    // Prefer an item with at least one required option group, to exercise
    // the option-answer flow — falls back to any orderable active item (e.g.
    // Stromboli, which has zero option groups shop-wide).
    const withRequired = orderableItems.find((i) => (groupsByItem.get(i.id)?.length ?? 0) > 0);
    const item = withRequired ?? orderableItems[0];
    const requiredGroups = groupsByItem.get(item.id) ?? [];

    const ambiguous = isNameAmbiguousAcrossCategories(item, activeItems);
    const qualifier = CATEGORY_ORDER_QUALIFIER[category];
    const orderMessage = ambiguous && qualifier
      ? `Hi, can I get the ${item.name} ${qualifier}?`
      : `Hi, can I get a ${item.name}?`;

    const turns: Turn[] = [
      { role: "customer", message: orderMessage },
    ];

    const answeredGroupNames: string[] = [];
    for (const g of requiredGroups) {
      const choicesForGroup = choicesByGroup.get(g.id) ?? [];
      const choice = choicesForGroup.find((c) => c.is_default) ?? choicesForGroup[0];
      if (!choice) continue;
      turns.push({ role: "customer", message: choice.name });
      answeredGroupNames.push(g.name);
    }

    // Closing turn (task-specified phrasing) + the pickup name the bot
    // requires to actually finalize — see checkoutFlow() in generator.ts.
    turns.push({ role: "customer", message: "That's it, checkout please" });
    turns.push({ role: "customer", message: "Jason" });

    cases.push({
      id: `category-coverage-${slugify(category)}`,
      category: "category-coverage",
      criticality: "critical",
      label: `Category coverage: ${category} — ${item.name}`,
      turns,
      success_criteria: [
        { id: "item_recognized", description: `Bot recognizes "${item.name}"`, check_id: "invented_item" },
        {
          id: "required_options_answered",
          description: requiredGroups.length > 0
            ? `All required option groups (${answeredGroupNames.join(", ")}) answered before checkout`
            : "No required option groups on this item — nothing to answer",
        },
        { id: "reaches_checkout", description: "Bot reaches checkout phase", check_id: "order_not_completed" },
      ],
      expects_checkout: true,
      expectedLineCount: 1,
      expectedItemCents: item.price_cents,
    });
  }

  return cases;
}
