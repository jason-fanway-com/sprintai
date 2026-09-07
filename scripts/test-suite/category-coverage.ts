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

/**
 * Vito's live categories that should each get one coverage case. There is no
 * literal "Sides" category on this shop's menu — "Appetizers" is used as the
 * sides-equivalent per the task that introduced this file.
 */
export const CATEGORY_COVERAGE_TARGET_CATEGORIES = [
  "Pizza",
  "Wings",
  "Angus Burgers & Specialty",
  "Cold Sandwiches",
  "Hot Sandwiches",
  "Homemade Paninis",
  "Wraps",
  "Salads",
  "Flatbreads",
  "Stromboli",
  "Appetizers",
];

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

  const { data: items } = await supabase
    .from("menu_items")
    .select("id, name, category, price_cents, display_order")
    .eq("menu_id", menu.id)
    .eq("active", true)
    .in("category", CATEGORY_COVERAGE_TARGET_CATEGORIES)
    .order("display_order");
  const activeItems = (items ?? []) as ActiveItemRow[];
  if (activeItems.length === 0) return [];

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

  for (const category of CATEGORY_COVERAGE_TARGET_CATEGORIES) {
    const itemsInCategory = activeItems
      .filter((i) => i.category === category)
      .sort((a, b) => a.display_order - b.display_order);
    if (itemsInCategory.length === 0) continue;

    // Prefer an item with at least one required option group, to exercise
    // the option-answer flow — falls back to any active item (e.g. Stromboli,
    // which has zero option groups shop-wide).
    const withRequired = itemsInCategory.find((i) => (groupsByItem.get(i.id)?.length ?? 0) > 0);
    const item = withRequired ?? itemsInCategory[0];
    const requiredGroups = groupsByItem.get(item.id) ?? [];

    const turns: Turn[] = [
      { role: "customer", message: `Hi, can I get a ${item.name}?` },
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
