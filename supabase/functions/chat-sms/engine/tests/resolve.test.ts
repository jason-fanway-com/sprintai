import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fixtureMenu, IDS, zioFixtureMenu } from "./fixture-menu.ts";
import { bindLine, narrow, pickFacet, resolveSpan } from "../resolve.ts";
import { facetsFromName } from "../menu.ts";
import type { Line } from "../form.ts";

const menu = fixtureMenu();
const line = (span: string, held: string[] = []): Line => ({ line_id: 1, span, item_id: null, qty: 1, choices: {}, modifiers: [], held, notes: [], slot_candidates: {}, status: { kind: "unresolved" } });

Deno.test("facets from live-shaped names", () => {
  assertEquals(facetsFromName('Pepperoni Pizza - Large (16")'), { kind: "pepperoni pizza", size: "large" });
  assertEquals(facetsFromName('Cheese - Small (10")'), { kind: "cheese", size: "small" });
  assertEquals(facetsFromName("Cheese Burger"), { kind: "cheese burger", size: null });
});

Deno.test("longest match: cheeseburger is the $8.49 item, not the bacon one", () => {
  assertEquals(resolveSpan("cheeseburger", menu), { kind: "item", id: IDS.cheeseburger });
  assertEquals(resolveSpan("a bacon cheeseburger please", menu), { kind: "item", id: IDS.baconCheeseburger });
});

Deno.test("ambiguous means ask: pepperoni is three sizes; fries is two items", () => {
  const r = resolveSpan("pepperoni pizzas", menu);
  assertEquals(r.kind, "ambiguous");
  assertEquals(pickFacet((r as { ids: string[] }).ids, menu), "size");
  assertEquals(resolveSpan("fries", menu).kind, "ambiguous");
});

Deno.test("category word narrows by kind first", () => {
  const r = resolveSpan("pizza", menu);
  assertEquals(r.kind, "ambiguous");
  assertEquals(pickFacet((r as { ids: string[] }).ids, menu), "kind");
  const n = narrow((r as { ids: string[] }).ids, "pepperoni", menu);
  assertEquals(n.sort(), [IDS.pepPizzaL, IDS.pepPizzaM, IDS.pepPizzaS].sort());
});

Deno.test("held size binds a derived row: 2 large pepperoni", () => {
  const l = line("pepperoni pizzas", ["large"]);
  bindLine(l, menu);
  assertEquals(l.item_id, IDS.pepPizzaL);
  assertEquals(l.status.kind, "complete");
});

Deno.test("canon: cheese pizza + pepperoni becomes the Pepperoni Pizza row", () => {
  const l = line("cheese pizza", ["large", "pepperoni"]);
  bindLine(l, menu);
  assertEquals(l.item_id, IDS.pepPizzaL);
  assertEquals(l.modifiers, []);
  assertEquals(l.status.kind, "complete");
});

Deno.test("required slot: cheeseburger needs a temp; 'medium' matches exactly", () => {
  const l = line("cheeseburger");
  bindLine(l, menu);
  assertEquals(l.status, { kind: "needs_slot", group_id: IDS.tempGroup });
  l.held.push("medium");
  bindLine(l, menu);
  assertEquals(l.choices[IDS.tempGroup], IDS.tempMedium);
  assertEquals(l.status.kind, "complete");
});

Deno.test("unknown span stays unresolved, never guessed", () => {
  const l = line("lobster thermidor");
  bindLine(l, menu);
  assertEquals(l.status.kind, "unresolved");
});

Deno.test("modifier with price: margherita with bacon stays margherita (no canon row)", () => {
  const l = line("margherita", ["small", "bacon"]);
  bindLine(l, menu);
  assertEquals(l.item_id, IDS.margheritaS);
  assertEquals(l.modifiers, ["mgBacS"]);
});

Deno.test("leading size in the name is a facet (Zio's naming)", () => {
  assertEquals(facetsFromName("Small 14'' Neapolitan Cheese Pizza"), { kind: "neapolitan cheese pizza", size: "small" });
  assertEquals(facetsFromName("Large 18'' Neapolitan Cheese Pizza"), { kind: "neapolitan cheese pizza", size: "large" });
});

Deno.test("a single-choice slot is applied, not asked", () => {
  const l = line("knots zio");
  bindLine(l, zioFixtureMenu());
  assertEquals(l.status.kind, "complete");
  assertEquals(l.choices["zkSize"], "zk6");
});

Deno.test("leading-size names narrow by size: neapolitan + medium/large", () => {
  const zm = zioFixtureMenu();
  const l = line("neapolitan cheese pizza", ["large"]);
  bindLine(l, zm);
  assertEquals(l.item_id, "zpL");
  assertEquals(l.status.kind, "complete");
});
