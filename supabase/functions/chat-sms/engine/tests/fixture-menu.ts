// fixture-menu.ts — a Vito's-shaped test menu built through the real adapter.
// Shapes mirror live rows pulled 2026-09-20: Cheese Burger (temp slot),
// Garlic Knots (no options), derived Pepperoni Pizza rows (size in name,
// derived_from -> Cheese base + Pepperoni topping), House Salad (dressing slot).
import { buildMenu, type LexiconEntry, type RawMenuItem, type ShopConfig } from "../menu.ts";

export const IDS = {
  cheeseburger: "cb", baconCheeseburger: "bcb", knots: "knots", fries: "fries", cheeseFries: "cfries",
  cheesePizzaS: "cpS", cheesePizzaM: "cpM", cheesePizzaL: "cpL",
  pepPizzaS: "ppS", pepPizzaM: "ppM", pepPizzaL: "ppL",
  margheritaS: "mgS", margheritaL: "mgL",
  houseSalad: "hs", greekSalad: "gs", cheesesteak: "cs",
  toppingsS: "topS", toppingsM: "topM", toppingsL: "topL",
  pepChoiceS: "pepS", pepChoiceM: "pepM", pepChoiceL: "pepL",
  mushChoiceS: "mushS", mushChoiceM: "mushM", mushChoiceL: "mushL",
  baconChoiceS: "bacS", baconChoiceL: "bacL",
  tempGroup: "tempG", tempMedium: "tMed", tempMedWell: "tMW", tempWell: "tWell", tempRare: "tRare", tempMedRare: "tMR",
  dressingGroup: "dressG", ranch: "dRanch", italian: "dItal", bleu: "dBleu",
  saladAddons: "saladAdd", grilledChicken: "aChk",
  sizeFriesGroup: "friesSize", friesSmall: "fS", friesLarge: "fL",
};

const temp = { group_id: IDS.tempGroup, slot_key: null, kind: "slot" as const, ask_mode: "ask", prompt_template: "temp.ask",
  choices: [
    { id: IDS.tempWell, display: "Well Done", price_delta_cents: 0 },
    { id: IDS.tempMedium, display: "Medium", price_delta_cents: 0 },
    { id: IDS.tempRare, display: "Rare", price_delta_cents: 0 },
    { id: IDS.tempMedWell, display: "Medium Well", price_delta_cents: 0 },
    { id: IDS.tempMedRare, display: "Medium Rare", price_delta_cents: 0 },
  ] };

const toppings = (gid: string, pep: string, mush: string, bacon: string | null, delta: number) => ({
  group_id: gid, slot_key: "toppings", kind: "modifier" as const, ask_mode: "on_request", prompt_template: "toppings.ask",
  choices: [
    { id: pep, display: "Pepperoni", price_delta_cents: delta },
    { id: pep + "H", display: "Pepperoni (Half pizza)", price_delta_cents: delta },
    { id: mush, display: "Mushroom", price_delta_cents: delta },
    { id: mush + "H", display: "Mushroom (Half pizza)", price_delta_cents: delta },
    ...(bacon ? [{ id: bacon, display: "Bacon", price_delta_cents: delta + 150 }] : []),
  ] });

function item(id: string, name: string, category: string, price: number, extra: Partial<RawMenuItem> = {}, steps: RawMenuItem["ask_plan"] extends infer _ ? any[] : never = []): RawMenuItem {
  return { id, name, display_name: extra.display_name ?? name, category, price_cents: price, bot_state: "orderable",
    ask_plan: { base_price_cents: price, display_name: extra.display_name ?? name, steps }, ...extra };
}

export const RAW_ITEMS: RawMenuItem[] = [
  item(IDS.cheeseburger, "Cheese Burger", "Angus Burgers & Specialty", 849, {}, [temp]),
  item(IDS.baconCheeseburger, "Bacon Cheeseburger", "Angus Burgers & Specialty", 1099, {}, [temp]),
  item(IDS.knots, "Garlic Knots (6)", "Appetizers", 599),
  item(IDS.fries, "French Fries", "Sides", 399, {}, [{ group_id: IDS.sizeFriesGroup, slot_key: "size", kind: "slot", ask_mode: "ask", prompt_template: "size.ask",
    choices: [{ id: IDS.friesSmall, display: "Small", price_delta_cents: 0 }, { id: IDS.friesLarge, display: "Large", price_delta_cents: 200 }] }]),
  item(IDS.cheeseFries, "Cheese Fries", "Sides", 599),
  item("bcf", "Bacon Cheese Fries", "Sides", 799), item("pzf", "Pizza Fries", "Sides", 699), item("bcfr", "Buffalo Chicken Fries", "Sides", 899), item("crz", "Crazy Fries", "Sides", 749, { description: "Chicken steak meat, onions, nacho cheese, mild sauce" }),
  item(IDS.cheesePizzaS, "Cheese - Small (10\")", "Pizza", 1099, { display_name: "Small Cheese Pizza" }, [toppings(IDS.toppingsS, IDS.pepChoiceS, IDS.mushChoiceS, IDS.baconChoiceS, 200)]),
  item(IDS.cheesePizzaM, "Cheese - Medium (14\")", "Pizza", 1499, { display_name: "Medium Cheese Pizza" }, [toppings(IDS.toppingsM, IDS.pepChoiceM, IDS.mushChoiceM, null, 250)]),
  item(IDS.cheesePizzaL, "Cheese - Large (16\")", "Pizza", 1800, { display_name: "Large Cheese Pizza" }, [toppings(IDS.toppingsL, IDS.pepChoiceL, IDS.mushChoiceL, IDS.baconChoiceL, 300)]),
  item(IDS.pepPizzaS, "Pepperoni Pizza - Small (10\")", "Pizza", 1299, { display_name: "Small Pepperoni Pizza", description: "Our cheese pizza with pepperoni", is_derived: true, derived_from: { base_item_id: IDS.cheesePizzaS, choice_ids: [IDS.pepChoiceS] } }),
  item(IDS.pepPizzaM, "Pepperoni Pizza - Medium (14\")", "Pizza", 1749, { display_name: "Medium Pepperoni Pizza", is_derived: true, derived_from: { base_item_id: IDS.cheesePizzaM, choice_ids: [IDS.pepChoiceM] } }),
  item(IDS.pepPizzaL, "Pepperoni Pizza - Large (16\")", "Pizza", 2100, { display_name: "Large Pepperoni Pizza", is_derived: true, derived_from: { base_item_id: IDS.cheesePizzaL, choice_ids: [IDS.pepChoiceL] } }),
  item("mushS", "Mushrooms Pizza - Small (10\")", "Pizza", 1299, { display_name: "Small Mushrooms Pizza", is_derived: true, derived_from: { base_item_id: IDS.cheesePizzaS, choice_ids: [IDS.mushChoiceS] } }),
  item("mushM", "Mushrooms Pizza - Medium (14\")", "Pizza", 1749, { display_name: "Medium Mushrooms Pizza", is_derived: true, derived_from: { base_item_id: IDS.cheesePizzaM, choice_ids: [IDS.mushChoiceM] } }),
  item("mushL", "Mushrooms Pizza - Large (16\")", "Pizza", 2100, { display_name: "Large Mushrooms Pizza", is_derived: true, derived_from: { base_item_id: IDS.cheesePizzaL, choice_ids: [IDS.mushChoiceL] } }),
  item("hawL", "Hawaiian - Large (16\")", "Pizza", 2100, { display_name: "Large Hawaiian Pizza" }),
  item("mlL", "Meat Lover - Large (16\")", "Pizza", 2300, { display_name: "Large Meat Lover Pizza" }),
  item(IDS.margheritaS, "Margherita - Small (10\")", "Pizza", 1295, { display_name: "Small Margherita Pizza" }, [toppings("mgTopS", "mgPepS", "mgMushS", "mgBacS", 200)]),
  item(IDS.margheritaL, "Margherita - Large (16\")", "Pizza", 1895, { display_name: "Large Margherita Pizza" }, [toppings("mgTopL", "mgPepL", "mgMushL", "mgBacL", 300)]),
  item(IDS.houseSalad, "House Salad", "Salads", 799, {}, [
    { group_id: IDS.dressingGroup, slot_key: "dressing", kind: "slot", ask_mode: "ask", prompt_template: "dressing.ask",
      choices: [{ id: IDS.ranch, display: "Ranch", price_delta_cents: 0 }, { id: IDS.italian, display: "Italian", price_delta_cents: 0 }, { id: IDS.bleu, display: "Bleu Cheese", price_delta_cents: 0 }] },
    { group_id: IDS.saladAddons, slot_key: "add_ons", kind: "modifier", ask_mode: "on_request", prompt_template: "addons.ask",
      choices: [{ id: IDS.grilledChicken, display: "Grilled Chicken", price_delta_cents: 400 }] },
  ]),
  item("chparm", "Chicken Parmesan", "Hot Sandwiches", 1199, {}, [
    { group_id: "breadG", slot_key: "bread", kind: "slot", ask_mode: "ask", prompt_template: "bread.ask",
      choices: [{ id: "brWhite", display: "White", price_delta_cents: 0 }, { id: "brRye", display: "Rye", price_delta_cents: 0 }, { id: "brWheat", display: "Wheat", price_delta_cents: 0 }] },
  ]),
  item("chq", "Chicken", "Quesadillas", 1249),
  item("gyroS", "Gyro (Beef or Chicken)", "Hot Sandwiches", 1099, { display_name: "Gyro Sandwich" }, [
    { group_id: "gyroA", slot_key: "choice", kind: "slot", ask_mode: "ask", prompt_template: "choice.ask", choices: [{ id: "gA-beef", display: "Beef", price_delta_cents: 0 }, { id: "gA-chk", display: "Chicken", price_delta_cents: 0 }] },
    { group_id: "gyroB", slot_key: "beef_or_chicken", kind: "slot", ask_mode: "ask", prompt_template: "beef_or_chicken.ask", choices: [{ id: "gB-chk", display: "Chicken", price_delta_cents: 0 }, { id: "gB-beef", display: "Beef", price_delta_cents: 0 }] },
  ]),
  item("bbb", "Big Boy Burger", "Angus Burgers & Specialty", 1295, {}, [temp]),
  item("swb", "Swiss Burger", "Angus Burgers & Specialty", 1099, {}, [temp]),
  item("lbCup", "Cup Lobster Bisque Soup", "Soups", 499, { display_name: "Cup Lobster Bisque Soup" }),
  item("lbBowl", "Bowl Lobster Bisque Soup", "Soups", 799, { display_name: "Bowl Lobster Bisque Soup" }),
  item("chparmE", "Chicken Parmesan", "Entrees", 1795),
  item(IDS.greekSalad, "Greek Salad", "Salads", 899, {}, [
    { group_id: "gsDress", slot_key: "dressing", kind: "slot", ask_mode: "ask", prompt_template: "dressing.ask",
      choices: [{ id: "gsRanch", display: "Ranch", price_delta_cents: 0 }, { id: "gsGreek", display: "Greek", price_delta_cents: 0 }] },
  ]),
  item(IDS.cheesesteak, "Cheesesteak", "Hoagies", 1049),
  item("roll", "Pepperoni", "Stromboli Rolls", 999),
  item("wbi", "Wings Bone-In - 10 Pieces", "Appetizers", 1299, { display_name: "Wings Bone-In - 10 Pieces" }),
  item("wbo", "Wings Boneless - 10 Pieces", "Appetizers", 1199, { display_name: "Wings Boneless - 10 Pieces" }),
  item("coke", "Coke", "Beverages", 299), item("dcoke", "Diet Coke", "Beverages", 299),
  item("bg-plain", "Plain Bagel", "Bagels", 150),
  item("bg-every", "Everything Bagel", "Bagels", 150),
  item("bg-egg-every", "Egg Everything Bagel", "Bagels", 150),
  item("bg-ww-every", "Whole Wheat Everything Bagel", "Bagels", 150),
  item("bg-sesame", "Sesame Bagel", "Bagels", 150),
  item("bg-dozen", "One Dozen Bagels", "Bagels", 1500, { meta: { bundle: { count: 12, category: "Bagels", unit: "bagel" } } }),
  item("bg-half", "Half Dozen Bagels", "Bagels", 750, { meta: { bundle: { count: 6, category: "Bagels", unit: "bagel" } } }),
];

export const RAW_LEXICON: LexiconEntry[] = [
  ["cheese burger", IDS.cheeseburger], ["cheeseburger", IDS.cheeseburger], ["cheeseburgers", IDS.cheeseburger], ["cheese burgers", IDS.cheeseburger],
  ["bacon cheeseburger", IDS.baconCheeseburger], ["bacon cheeseburgers", IDS.baconCheeseburger],
  ["garlic knots", IDS.knots], ["garlic knot", IDS.knots], ["knots", IDS.knots],
  ["french fries", IDS.fries], ["fries", IDS.fries], ["fries", IDS.cheeseFries], ["cheese fries", IDS.cheeseFries],
  ["fries", "bcf"], ["bacon cheese fries", "bcf"], ["fries", "pzf"], ["pizza fries", "pzf"], ["fries", "bcfr"], ["buffalo chicken fries", "bcfr"], ["fries", "crz"], ["crazy fries", "crz"],
  ["cheese pizza", IDS.cheesePizzaS], ["cheese pizza", IDS.cheesePizzaM], ["cheese pizza", IDS.cheesePizzaL],
  ["plain pizza", IDS.cheesePizzaS], ["plain pizza", IDS.cheesePizzaM], ["plain pizza", IDS.cheesePizzaL],
  ["small cheese pizza", IDS.cheesePizzaS], ["medium cheese pizza", IDS.cheesePizzaM], ["large cheese pizza", IDS.cheesePizzaL],
  ["pepperoni pizza", IDS.pepPizzaS], ["pepperoni pizza", IDS.pepPizzaM], ["pepperoni pizza", IDS.pepPizzaL],
  ["pepperoni pizzas", IDS.pepPizzaS], ["pepperoni pizzas", IDS.pepPizzaM], ["pepperoni pizzas", IDS.pepPizzaL],
  ["pepperoni", IDS.pepPizzaS], ["pepperoni", IDS.pepPizzaM], ["pepperoni", IDS.pepPizzaL],
  ["small pepperoni pizza", IDS.pepPizzaS], ["medium pepperoni pizza", IDS.pepPizzaM], ["large pepperoni pizza", IDS.pepPizzaL],
  ["large pepperoni", IDS.pepPizzaL], ["medium pepperoni", IDS.pepPizzaM], ["small pepperoni", IDS.pepPizzaS],
  ["mushrooms pizza", "mushL"], ["mushroom pizza", "mushL"], ["mushrooms", "mushL"], ["large mushrooms pizza", "mushL"],
  ["mushrooms pizza", "mushS"], ["mushroom pizza", "mushS"], ["mushrooms", "mushS"], ["small mushrooms pizza", "mushS"],
  ["mushrooms pizza", "mushM"], ["mushroom pizza", "mushM"], ["mushrooms", "mushM"], ["medium mushrooms pizza", "mushM"],
  ["hawaiian", "hawL"], ["hawaiian pizza", "hawL"], ["meat lover", "mlL"], ["meat lovers", "mlL"], ["meat lover pizza", "mlL"],
  ["plain", IDS.cheesePizzaS], ["plain", IDS.cheesePizzaM], ["plain", IDS.cheesePizzaL],
  ["margherita", IDS.margheritaS], ["margherita", IDS.margheritaL], ["margherita pizza", IDS.margheritaS], ["margherita pizza", IDS.margheritaL],
  ["house salad", IDS.houseSalad], ["house", IDS.houseSalad], ["greek salad", IDS.greekSalad],
  ["cheesesteak", IDS.cheesesteak], ["cheese steak", IDS.cheesesteak], ["sandwich", IDS.cheesesteak], ["sandwiches", IDS.cheesesteak],
  ["chicken", "chq"], ["chicken quesadilla", "chq"], ["quesadilla", "chq"],
  ["gyro sandwich", "gyroS"], ["gyro", "gyroS"],
  ["burger", "bbb"], ["burgers", "bbb"], ["big boy burger", "bbb"], ["burger", "swb"], ["burgers", "swb"], ["swiss burger", "swb"],
  ["lobster bisque", "lbCup"], ["lobster bisque", "lbBowl"], ["lobster bisque soup", "lbCup"], ["lobster bisque soup", "lbBowl"], ["soup", "lbCup"], ["soup", "lbBowl"],
  ["chicken parmesan", "chparmE"], ["chicken parmesan entree", "chparmE"],
  ["chicken parmesan", "chparm"], ["chicken parmesan sandwich", "chparm"], ["chicken parmesan sandwiches", "chparm"], ["parmesan sandwich", "chparm"], ["sandwich", "chparm"], ["sandwiches", "chparm"],
  ["pepperoni stromboli", "roll"], ["pepperoni", "roll"], ["pepperoni roll", "roll"],
  ["wings", "wbi"], ["wings", "wbo"], ["bone in wings", "wbi"], ["boneless wings", "wbo"], ["boneless", "wbo"], ["bone in", "wbi"],
  ["coke", "coke"], ["diet coke", "dcoke"], ["diet", "dcoke"],
  ["plain bagel", "bg-plain"], ["everything bagel", "bg-every"], ["everything", "bg-every"], ["sesame bagel", "bg-sesame"],
  ["egg everything bagel", "bg-egg-every"], ["everything", "bg-egg-every"], ["whole wheat everything bagel", "bg-ww-every"], ["everything", "bg-ww-every"],
  ["dozen bagels", "bg-dozen"], ["one dozen bagels", "bg-dozen"], ["a dozen bagels", "bg-dozen"], ["dozen", "bg-dozen"],
  ["half dozen bagels", "bg-half"], ["half dozen", "bg-half"], ["dozen bagels", "bg-half"],
].map(([term, id]) => ({ term, target_type: "item", target_id: id })).concat([
  { term: "pizza", target_type: "category", target_id: "Pizza" },
  { term: "pizzas", target_type: "category", target_id: "Pizza" },
  { term: "pie", target_type: "category", target_id: "Pizza" },
  { term: "pies", target_type: "category", target_id: "Pizza" },
  { term: "salad", target_type: "category", target_id: "Salads" },
  { term: "salads", target_type: "category", target_id: "Salads" },
  { term: "bagels", target_type: "category", target_id: "Bagels" },
  { term: "bagel", target_type: "category", target_id: "Bagels" },
]);

export const SHOP: ShopConfig = {
  shop_id: "vitos", name: "Vito's Pizza", delivery_enabled: true, delivery_fee_cents: 300, tax_rate_bps: 600,
  service_fee_cents: 99, phone_display: "(610) 555-0100",
  ask_order: ["fulfillment", "address", "items", "tip", "confirm"],
};

export function fixtureMenu(overrides: Partial<ShopConfig> = {}) {
  return buildMenu({ version: "test-v1", items: RAW_ITEMS, lexicon: RAW_LEXICON, shop: { ...SHOP, ...overrides } });
}

/** Zio's-shaped extras: leading-size names and single-choice slots. Kept out of the Vito's fixture. */
export const ZIO_EXTRA_ITEMS: RawMenuItem[] = [
  item("zk", "Garlic Knots Zio", "Appetizers", 475, { display_name: "Garlic Knots Zio" }, [{ group_id: "zkSize", slot_key: null, kind: "slot", ask_mode: "auto_single", prompt_template: "size.ask", choices: [{ id: "zk6", display: "6 Pieces", price_delta_cents: 0 }] }]),
  item("zpS", "Small 14'' Neapolitan Cheese Pizza", "Pizza", 1525),
  item("zpL", "Large 18'' Neapolitan Cheese Pizza", "Pizza", 1799),
];
export const ZIO_EXTRA_LEXICON: LexiconEntry[] = [
  ["knots zio", "zk"], ["neapolitan cheese pizza", "zpS"], ["neapolitan cheese pizza", "zpL"], ["neapolitan", "zpS"], ["neapolitan", "zpL"],
].map(([term, id]) => ({ term, target_type: "item", target_id: id }));
export function zioFixtureMenu() {
  return buildMenu({ version: "zio-v1", items: [...RAW_ITEMS, ...ZIO_EXTRA_ITEMS], lexicon: [...RAW_LEXICON, ...ZIO_EXTRA_LEXICON], shop: { ...SHOP, name: "Zio's" } });
}
