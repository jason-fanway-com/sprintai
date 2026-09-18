// 00-BN: the model reads WHICH ONE the customer meant. It can only ever pick
// from the candidates code offered, and code re-checks membership, so it can
// never add an item that was not already on the table in front of the customer.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyDisambiguationPick } from "./turn-engine.ts";
import type { TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

const MENU: TurnEngineMenuItem[] = ["bowl", "cup"].map((k, i) => ({
  id: `soup-${k}`, name: `Soup of the Day - ${k === "bowl" ? "Bowl" : "Cup"}`,
  category: "Soup", price_cents: i === 0 ? 899 : 599, bot_state: "orderable",
  ask_plan: { compiled_at: "", compiler_version: 1, display_name: `Soup ${k}`, base_price_cents: i === 0 ? 899 : 599, recap_template: "", ticket_template: "", steps: [] },
  option_groups: [],
}));

Deno.test("00-BN: a candidate the model picked is added, at the right price", () => {
  const cart: TurnEngineCartLine[] = [];
  const r = applyDisambiguationPick(cart, MENU, "soup-bowl");
  assertEquals(r.applied, true);
  assertEquals(cart.length, 1);
  assertEquals(cart[0].menu_item_id, "soup-bowl");
  assertEquals(cart[0].price_cents, 899);
});

Deno.test("00-BN: an id that is not on the menu adds NOTHING", () => {
  const cart: TurnEngineCartLine[] = [];
  assertEquals(applyDisambiguationPick(cart, MENU, "not-a-real-item").applied, false);
  assertEquals(cart.length, 0, "nothing may enter the cart");
});
