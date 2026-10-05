// conversations.test.ts — scripted conversations through the pure turn().
// Moves are hand-written (what a correct interpreter returns); no model here.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fixtureMenu, IDS, RAW_ITEMS, RAW_LEXICON, SHOP, steakFixtureMenu } from "./fixture-menu.ts";
import { buildMenu } from "../menu.ts";
const await_import = () => ({ buildMenu });
import { newForm, type Move, type OrderForm } from "../form.ts";
import { turn } from "../turn.ts";
import { narrow } from "../resolve.ts";
import { closedAnswer } from "../vocab.ts";
import { totals } from "../price.ts";
import { words, closestWord, faithfulRewrite } from "../normalize.ts";
import { streetChanged, localityOf, googleGeocoder } from "../address.ts";

const menu = fixtureMenu();
const addr = (text: string) => ({ kind: "answer", field: "address", value: { text, formatted: text, validated: true, zone_ok: true } } as Move);

/** Drive one turn: closed vocabulary first, else the supplied "model" moves. */
function say(form: OrderForm, message: string, modelMoves: Move[] = []) {
  const closed = closedAnswer(form, message, menu);
  const out = turn({ form, menu, message, moves: closed ?? modelMoves, closed: closed !== null });
  return out;
}

Deno.test("worked conversation: delivery, three items, narrowing, tip, confirm", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "hi");
  assertStringIncludes(o.reply, "Pickup or delivery?");
  f = o.form;

  o = say(f, "delivery to 123 Main St, 2 large pepperoni and an order of garlic knots", [
    { kind: "answer", field: "fulfillment", value: "delivery" },
    addr("123 Main St"),
    { kind: "add_line", item_span: "pepperoni", qty: 2, option_spans: ["large"] },
    { kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] },
  ]);
  f = o.form;
  assertEquals(f.lines.length, 2);
  assertEquals(f.lines[0].item_id, IDS.pepPizzaL);
  assertEquals(f.lines[0].qty, 2);
  assertEquals(f.lines[1].item_id, IDS.knots);
  assertStringIncludes(o.reply, "2 x Large Pepperoni Pizza");
  assertStringIncludes(o.reply, "2 x Large Pepperoni Pizza");
  assertStringIncludes(o.reply, "Anything else?");
  assertEquals(f.open?.kind, "items");

  o = say(f, "make the knots 2 and add a small cheese", [
    { kind: "change_line", ref: { span: "knots" }, qty: 2 },
    { kind: "add_line", item_span: "cheese", qty: 1, option_spans: ["small"] },
  ]);
  f = o.form;
  assertEquals(f.lines[1].qty, 2);
  // "small cheese": partial match over cheese items, "small" narrows to the one sized small
  assertEquals(f.lines[2].item_id, IDS.cheesePizzaS, o.reply);
  assertStringIncludes(o.reply, "Updated: 2 x Garlic Knots (6).");
  assertStringIncludes(o.reply, "Small Cheese Pizza");
  assertStringIncludes(o.reply, "Added 1 x Small Cheese Pizza.");
  assertEquals(f.open?.kind, "items");

  o = say(f, "thats it");
  f = o.form;
  assert(f.items_done);
  assertEquals(f.open?.kind, "tip");

  o = say(f, "20");
  f = o.form;
  assertEquals(f.tip, { kind: "percent", value: 20 });
  assertEquals(f.status, "confirming");
  const t = totals(f, menu);
  assertEquals(t.subtotal_cents, 4200 + 1198 + 1099);
  assertEquals(t.delivery_fee_cents, 300);
  assertEquals(t.tax_cents, Math.round(6497 * 0.06));
  assertEquals(t.tip_cents, Math.round(6497 * 0.2));
  assertStringIncludes(o.reply, "Total $");
  assertStringIncludes(o.reply, "Reply YES");

  o = say(f, "yes");
  f = o.form;
  assert(o.handoff);
  assertEquals(f.status, "awaiting_payment");
});

Deno.test("live probe 2026-09-20: three items in one message are never dropped silently", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "hi").form;
  const o = say(f, "delivery, 2 large pepperoni pizzas and an order of garlic knots", [
    { kind: "answer", field: "fulfillment", value: "delivery" },
    { kind: "add_line", item_span: "pepperoni pizzas", qty: 2, option_spans: ["large"] },
    { kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] },
  ]);
  assertEquals(o.form.lines.map((l) => [l.item_id, l.qty]), [[IDS.pepPizzaL, 2], [IDS.knots, 1]]);
  assertStringIncludes(o.reply, "Added");
  assertStringIncludes(o.reply, "What's the delivery address?");
});

Deno.test("partial drop: model returns one of two items; the second becomes a question, not silence", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "a cheeseburger and garlic knots", [
    { kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] },
  ]);
  assertEquals(o.form.lines.length, 1);
  assert(o.form.omissions.some((x) => x.span === "garlic knots"), JSON.stringify(o.form.omissions));
  assertEquals(o.form.omissions.length, 1);
  // the slot question outranks the omission; both get asked, one per turn
  assertEquals(o.form.open?.kind, "line_slot");
  const o2 = say(o.form, "medium");
  assertEquals(o2.form.open?.kind, "omission");
  assertStringIncludes(o2.reply, "Did you also want garlic knots?");
  const o3 = say(o2.form, "yes");
  assertEquals(o3.form.lines.length, 2);
  assertEquals(o3.form.lines[1].item_id, IDS.knots);
});

Deno.test("invented item: a span not in the message is rejected and nothing is added", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "a cheeseburger medium", [
    { kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: ["medium"] },
    { kind: "add_line", item_span: "french fries", qty: 1, option_spans: [] },
  ]);
  assertEquals(o.form.lines.length, 1);
  assert(o.ledger.some((e) => e.event === "rejected_span_not_in_message"));
});

Deno.test("narrowing: pizza -> what kind -> pepperoni -> what size -> large", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "I want a pizza", [{ kind: "add_line", item_span: "pizza", qty: 1, option_spans: [] }]);
  assertEquals(o.form.open?.kind, "line_ambiguous");
  assertStringIncludes(o.reply, "What kind of pizza? We have Cheese, Hawaiian, Margherita, Meat Lover, Mushrooms, Pepperoni.");
  o = say(o.form, "pepperoni");
  assertStringIncludes(o.reply, "What size");
  assertStringIncludes(o.reply, "Small, Medium, or Large");
  o = say(o.form, "large");
  assertEquals(o.form.lines[0].item_id, IDS.pepPizzaL);
  assertStringIncludes(o.reply, "Added 1 x Large Pepperoni Pizza");
});

Deno.test("corrections: X not Y, quantity change, remove with one line and with two", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "large cheese pizza and garlic knots", [
    { kind: "add_line", item_span: "large cheese pizza", qty: 1, option_spans: [] },
    { kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] },
  ]);
  assertEquals(o.form.lines.length, 2);
  o = say(o.form, "make that 3 knots", [{ kind: "change_line", ref: { span: "knots" }, qty: 3 }]);
  assertEquals(o.form.lines[1].qty, 3);
  o = say(o.form, "actually pepperoni not cheese", [
    { kind: "remove_line", ref: { span: "cheese" } },
    { kind: "add_line", item_span: "pepperoni", qty: 1, option_spans: [] },
  ]);
  // the pizza was removed; the new pepperoni needs a size (no size stated)
  assertEquals(o.form.lines.map((l) => l.item_id ?? l.status.kind), [IDS.knots, "ambiguous"]);
  o = say(o.form, "large");
  assertEquals(o.form.lines[1].item_id, IDS.pepPizzaL);
  o = say(o.form, "remove the knots", [{ kind: "remove_line", ref: { span: "knots" } }]);
  assertEquals(o.form.lines.length, 1);
  assertStringIncludes(o.reply, "Removed Garlic Knots (6).");
  // remove with two identical-ish refs asks which one
  o = say(o.form, "add a small cheese pizza", [{ kind: "add_line", item_span: "small cheese pizza", qty: 1, option_spans: [] }]);
  o = say(o.form, "remove the pizza", [{ kind: "remove_line", ref: { span: "pizza" } }]);
  assertEquals(o.form.open?.kind, "line_ref");
  assertStringIncludes(o.reply, "Which one do you mean?");
  o = say(o.form, "2");
  assertEquals(o.form.lines.length, 1);
  assertEquals(o.form.lines[0].item_id, IDS.pepPizzaL);
});

Deno.test("repeat ladder: same question, no progress, escalates and resolves safely", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "delivery");
  assertEquals(o.form.open?.kind, "address");
  const replies: string[] = [];
  for (let i = 0; i < 4; i++) { o = say(o.form, "asdf qwerty", [{ kind: "control", what: "unclear" }]); replies.push(o.reply); }
  // never the same text twice in a row before escalation
  assert(replies[0] !== replies[1], "rephrased on second ask");
  assertEquals(o.form.fulfillment, "pickup");
  assertStringIncludes(replies[2], "pickup instead");
});

Deno.test("what's in my cart is answered with the cart, not the open question alone", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "delivery").form;
  let o = say(f, "cheeseburger medium", [{ kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: ["medium"] }]);
  o = say(o.form, "whats in my cart");
  assertStringIncludes(o.reply, "Your order so far:");
  assertStringIncludes(o.reply, "Cheese Burger");
  assertStringIncludes(o.reply, "$8.49");
  assertEquals(o.form.open?.kind, "address");
});

Deno.test("canary: cheeseburger / medium / thats it = one line, $8.49 + $0.99", () => {
  const m = fixtureMenu({ delivery_enabled: false, tax_rate_bps: 0 });
  let f = newForm("vitos", "test-v1");
  let o = turn({ form: f, menu: m, message: "cheeseburger", moves: [{ kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] }] });
  assertEquals(o.form.open?.kind, "line_slot");
  o = turn({ form: o.form, menu: m, message: "medium", moves: closedAnswer(o.form, "medium", m)! });
  assertEquals(o.form.lines[0].status.kind, "complete");
  o = turn({ form: o.form, menu: m, message: "thats it", moves: closedAnswer(o.form, "thats it", m)! });
  assertEquals(o.form.status, "confirming");
  const t = totals(o.form, m);
  assertEquals(t.subtotal_cents, 849);
  assertEquals(t.total_cents, 948);
  assertEquals(o.form.lines.length, 1);
});

Deno.test("edit after confirm reopens and re-reads back; totals recomputed", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "garlic knots", [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  o = say(o.form, "thats it");
  assertEquals(o.form.status, "confirming");
  o = say(o.form, "add a cheesesteak", [{ kind: "add_line", item_span: "cheesesteak", qty: 1, option_spans: [] }]);
  assertEquals(o.form.status, "confirming");
  assertEquals(totals(o.form, menu).subtotal_cents, 599 + 1049);
  assertStringIncludes(o.reply, "Reply YES");
});

Deno.test("bare 'cheese' asks which, and a size answer picks the sized one", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "cheese", [{ kind: "add_line", item_span: "cheese", qty: 1, option_spans: [] }]);
  assertEquals(o.form.open?.kind, "line_ambiguous");
  assertStringIncludes(o.reply, "Which");
  o = say(o.form, "the pizza", [{ kind: "answer_option", value_span: "pizza" }]);
  assertEquals(o.form.open?.kind, "line_ambiguous");
  assertStringIncludes(o.reply, "What size");
  o = say(o.form, "medium");
  assertEquals(o.form.lines[0].item_id, IDS.cheesePizzaM);
});

Deno.test("focus conversion: the model returns add_line for a size word while a size question is open", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "pepperoni pizza", [{ kind: "add_line", item_span: "pepperoni pizza", qty: 1, option_spans: [] }]);
  assertStringIncludes(o.reply, "What size");
  o = say(o.form, "large please", [{ kind: "add_line", item_span: "large", qty: 1, option_spans: [] }]);
  assertEquals(o.form.lines.length, 1);
  assertEquals(o.form.lines[0].item_id, IDS.pepPizzaL);
  // "large please" is now a closed answer (filler words no longer block narrowing), so no model call was needed
  assert(o.ledger.some((e) => e.event === "add_reclassified_as_answer" || e.event === "answer_option"));
});

Deno.test("invalid address three times offers pickup; a valid one is acknowledged", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "delivery");
  const bad = (t: string) => ({ kind: "answer", field: "address", value: { text: t, formatted: null, validated: false, zone_ok: false } } as Move);
  o = say(o.form, "the moon", [bad("the moon")]);
  assertStringIncludes(o.reply, `I couldn't find "the moon"`);
  o = say(o.form, "mars", [bad("mars")]);
  o = say(o.form, "pluto", [bad("pluto")]);
  o = say(o.form, "saturn", [bad("saturn")]);
  assertEquals(o.form.fulfillment, "pickup");
  f = newForm("vitos", "test-v1");
  o = say(f, "delivery");
  o = say(o.form, "45 N 7th St", [addr("45 N 7th St, Allentown, PA")]);
  assertStringIncludes(o.reply, "Delivery to 45 N 7th St, Allentown, PA.");
  assertEquals(o.form.open?.kind, "items");
});

Deno.test("pickup-only shop never asks pickup or delivery", () => {
  const m = fixtureMenu({ delivery_enabled: false });
  const o = turn({ form: newForm("vitos", "test-v1"), menu: m, message: "garlic knots", moves: [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }] });
  assertEquals(o.form.fulfillment, "pickup");
  assertEquals(o.form.open?.kind, "items");
});

Deno.test("batch normalization: option emitted as a separate answer_option or change_line folds into the add", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "cheeseburger, medium please", [
    { kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] },
    { kind: "answer_option", value_span: "medium" },
  ]);
  assertEquals(o.form.lines[0].status.kind, "complete");
  assertEquals(o.form.lines[0].choices[IDS.tempGroup], IDS.tempMedium);
  o = say(o.form, "and a margherita small, add bacon to that", [
    { kind: "add_line", item_span: "margherita", qty: 1, option_spans: ["small"] },
    { kind: "change_line", ref: { last: true }, qty: null, add_option_spans: ["bacon"], remove_option_spans: [] },
  ]);
  assertEquals(o.form.lines[1].item_id, IDS.margheritaS);
  assertEquals(o.form.lines[1].modifiers, ["mgBacS"]);
});

Deno.test("closure while pickup/delivery is open marks items done and re-asks the open question", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "cheeseburger medium", [{ kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: ["medium"] }]);
  assertEquals(o.form.open?.kind, "fulfillment");
  o = say(o.form, "thats it");
  assert(o.form.items_done);
  assertEquals(o.form.open?.kind, "fulfillment");
  o = say(o.form, "pickup");
  assertEquals(o.form.status, "confirming");
  assertStringIncludes(o.reply, "Reply YES");
});

Deno.test("a size word alone is not an item: no line is opened, the open question is re-asked", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "garlic knots", [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  o = say(o.form, "large", [{ kind: "add_line", item_span: "large", qty: 1, option_spans: [] }]);
  assertEquals(o.form.lines.length, 1);
  assert(o.ledger.some((e) => e.event === "ignored_non_item_span"));
  assertStringIncludes(o.reply, "Anything else");
});

Deno.test("closure while an unknown item is pending drops it and moves on", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "garlic knots and a unicorn steak", [
    { kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] },
    { kind: "add_line", item_span: "unicorn steak", qty: 1, option_spans: [] },
  ]);
  assertEquals(o.form.open?.kind, "line_unresolved");
  o = say(o.form, "thats it");
  assertEquals(o.form.lines.length, 1);
  assertEquals(o.form.status, "confirming");
});

Deno.test("bare pepperoni: which kind is asked with full names, then size", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "pepperoni", [{ kind: "add_line", item_span: "pepperoni", qty: 1, option_spans: [] }]);
  assertStringIncludes(o.reply, "What kind of pepperoni? We have Pepperoni Pizza, Pepperoni (Stromboli Rolls).");
  o = say(o.form, "pizza");
  assertStringIncludes(o.reply, "What size Pepperoni Pizza? Small, Medium, or Large?");
});

Deno.test("an option the customer never typed is stripped; the size is asked instead of assumed", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "large cheese pizza", [{ kind: "add_line", item_span: "cheese pizza", qty: 1, option_spans: ["large"] }]);
  o = say(o.form, "actually pepperoni not cheese", [
    { kind: "remove_line", ref: { span: "cheese" } },
    { kind: "add_line", item_span: "pepperoni", qty: 1, option_spans: ["large"] },
  ]);
  assertEquals(o.form.lines.length, 1);
  assertEquals(o.form.lines[0].item_id, null);
  assertStringIncludes(o.reply, "Removed Large Cheese Pizza.");
  assertStringIncludes(o.reply, "What kind of pepperoni?");
});

Deno.test("'make that 3' with a vague reference resolves to the only line", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "garlic knots", [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  o = say(o.form, "make that 3", [{ kind: "change_line", ref: { span: "that" }, qty: 3 }]);
  assertEquals(o.form.lines[0].qty, 3);
  o = say(o.form, "and a cheesesteak", [{ kind: "add_line", item_span: "cheesesteak", qty: 1, option_spans: [] }]);
  o = say(o.form, "make that 2", [{ kind: "change_line", ref: { span: "that" }, qty: 2 }]);
  assertEquals(o.form.open?.kind, "line_ref");
});

Deno.test("answering a kind question with the category word works too", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "pepperoni", [{ kind: "add_line", item_span: "pepperoni", qty: 1, option_spans: [] }]);
  o = say(o.form, "the stromboli", [{ kind: "answer_option", value_span: "stromboli" }]);
  assertEquals(o.form.lines[0].item_id, "roll");
  assertStringIncludes(o.reply, "Added 1 x Pepperoni");
  assert(!o.reply.split("\n")[0].includes("$"), "no price in the acknowledgement");
});

Deno.test("leftover words in the item span act as options: 'house salad ranch' binds the dressing", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "house salad ranch", [{ kind: "add_line", item_span: "house salad ranch", qty: 1, option_spans: [] }]);
  assertEquals(o.form.lines[0].item_id, IDS.houseSalad);
  assertEquals(o.form.lines[0].choices[IDS.dressingGroup], IDS.ranch);
  assertEquals(o.form.lines[0].status.kind, "complete");
});

Deno.test("an add that duplicates another add's option is folded, not a second line (gyro incident)", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "a small margherita pizza with mushroom and bacon", [
    { kind: "add_line", item_span: "margherita pizza", qty: 1, option_spans: ["small", "with mushroom", "bacon"] },
    { kind: "add_line", item_span: "mushroom", qty: 1, option_spans: [] },
    { kind: "add_line", item_span: "bacon", qty: 1, option_spans: [] },
  ]);
  assertEquals(o.form.lines.length, 1);
  assertEquals(o.form.lines[0].item_id, IDS.margheritaS);
  assertEquals(o.form.lines[0].modifiers.sort(), ["mgBacS", "mgMushS"]);
});

Deno.test("bundle: a dozen bagels asks for flavors, takes counts across turns, prices flat", () => {
  let f = newForm("njb", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "a dozen bagels", [{ kind: "add_line", item_span: "dozen bagels", qty: 1, option_spans: [] }]);
  assertEquals(o.form.open?.kind, "line_picks");
  assertStringIncludes(o.reply, "One Dozen Bagels: which bagels?");
  assertStringIncludes(o.reply, "Plain, Everything, Egg Everything, Whole Wheat Everything, Sesame");
  o = say(o.form, "6 plain and 4 everything", [{ kind: "answer_option", value_span: "6 plain and 4 everything" }]);
  assertEquals(o.form.open?.kind, "line_picks");
  assertStringIncludes(o.reply, "10 of 12 picked. Which 2 more?");
  o = say(o.form, "sesame", [{ kind: "answer_option", value_span: "sesame" }]);
  assertEquals(o.form.lines[0].status.kind, "complete");
  assertEquals(o.form.lines[0].selections, { "bg-plain": 6, "bg-every": 4, "bg-sesame": 2 });
  assertStringIncludes(o.reply, "1 x One Dozen Bagels (6 Plain Bagel, 4 Everything Bagel, 2 Sesame Bagel)");
  assertEquals(totals(o.form, menu).subtotal_cents, 1500);
});

Deno.test("bundle: flavors given in the same message bind immediately", () => {
  let f = newForm("njb", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "half dozen bagels, 3 plain 3 sesame", [{ kind: "add_line", item_span: "half dozen bagels", qty: 1, option_spans: ["3 plain", "3 sesame"] }]);
  assertEquals(o.form.lines[0].status.kind, "complete");
  assertEquals(o.form.lines[0].selections, { "bg-plain": 3, "bg-sesame": 3 });
});

Deno.test("model drops everything: one question covers all missed items with their counts; yes adds them all", () => {
  let f = newForm("vitos", "test-v1");
  const o = say(f, "delivery, 2 large pepperoni pizzas and an order of garlic knots", [
    { kind: "answer", field: "fulfillment", value: "delivery" },
  ]);
  assertEquals(o.form.lines.length, 0);
  assertStringIncludes(o.reply, "Did you also want 2 large pepperoni");
  assertStringIncludes(o.reply, "and garlic knots? Reply YES or NO.");
  const o2 = say(o.form, "yes");
  assertEquals(o2.form.lines.map((l) => [l.item_id, l.qty]), [[IDS.pepPizzaL, 2], [IDS.knots, 1]]);
  assertStringIncludes(o2.reply, "What's the delivery address?");
});

Deno.test("a dozen bagels read as qty 12 of 'bagels' becomes the dozen bundle", () => {
  let f = newForm("njb", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "a dozen bagels", [{ kind: "add_line", item_span: "bagels", qty: 12, option_spans: [] }]);
  assertEquals(o.form.lines.length, 1);
  assertEquals(o.form.lines[0].item_id, "bg-dozen");
  assertEquals(o.form.lines[0].qty, 1);
  assertStringIncludes(o.reply, "One Dozen Bagels: which bagels?");
});

Deno.test("'and' inside an item name does not break matching", () => {
  assertEquals(words("bacon egg and cheese"), ["bacon", "egg", "cheese"]);
  assertEquals(words("mac & cheese"), ["mac", "cheese"]);
});

Deno.test("a lexicon term made only of filler words never becomes an omission question", () => {
  const { buildMenu } = await_import();
  const m = buildMenu({ version: "t", items: RAW_ITEMS, lexicon: [...RAW_LEXICON, { term: "order", target_type: "item", target_id: IDS.knots }], shop: SHOP });
  let f = newForm("vitos", "test-v1");
  f = turn({ form: f, menu: m, message: "pickup", moves: closedAnswer(f, "pickup", m)! }).form;
  const o = turn({ form: f, menu: m, message: "an order of garlic knots", moves: [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }] });
  assertEquals(o.form.omissions, []);
  assertStringIncludes(o.reply, "Anything else?");
});

Deno.test("'a dozen bagels' picks the one-dozen bundle even when 'dozen bagels' is a term on both; picks that sum to 6 pick the half", () => {
  let f = newForm("njb", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "a dozen bagels", [{ kind: "add_line", item_span: "dozen bagels", qty: 1, option_spans: [] }]);
  assertEquals(o.form.lines[0].item_id, "bg-dozen");
  f = newForm("njb", "test-v1");
  f = say(f, "pickup").form;
  o = say(f, "half a dozen bagels, 3 plain 3 sesame", [{ kind: "add_line", item_span: "half a dozen bagels", qty: 1, option_spans: ["3 plain", "3 sesame"] }]);
  assertEquals(o.form.lines[0].item_id, "bg-half");
  assertEquals(o.form.lines[0].status.kind, "complete");
});

Deno.test("a one-word item term is never a kitchen note ('cheeseburger' vs 'Cheese Burger')", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "cheeseburger", [{ kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] }]);
  assertEquals(o.form.lines[0].notes, []);
  assert(!o.reply.includes("Noted"));
});

Deno.test("bundle picks match flavors without the unit word: 'everything' = Everything Bagel", () => {
  let f = newForm("njb", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "a dozen bagels, 6 plain and 6 everything", [{ kind: "add_line", item_span: "dozen bagels", qty: 1, option_spans: ["6 plain", "6 everything"] }]);
  assertEquals(o.form.lines[0].selections, { "bg-plain": 6, "bg-every": 6 });
  assertEquals(o.form.lines[0].status.kind, "complete");
});

Deno.test("'everything bagels' over the bagel category narrows by the span's own word", () => {
  let f = newForm("njb", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "2 everything bagels", [{ kind: "add_line", item_span: "everything bagels", qty: 2, option_spans: [] }]);
  assertEquals(o.form.lines[0].item_id, "bg-every");
  assertEquals(o.form.lines[0].qty, 2);
});

Deno.test("second reader upgrades 'bagel' + 'plain cream cheese' to the unique longer term", () => {
  const m = buildMenu({ version: "t", items: [...RAW_ITEMS, { id: "bwpcc", name: "Bagel With Plain Cream Cheese", display_name: "Bagel With Plain Cream Cheese", category: "Bagel With", price_cents: 350, bot_state: "orderable", ask_plan: { base_price_cents: 350, steps: [] } }],
    lexicon: [...RAW_LEXICON, { term: "bagel with plain cream cheese", target_type: "item", target_id: "bwpcc" }, { term: "plain cream cheese", target_type: "item", target_id: "bwpcc" }], shop: SHOP });
  let f = newForm("njb", "test-v1");
  f = turn({ form: f, menu: m, message: "pickup", moves: closedAnswer(f, "pickup", m)! }).form;
  const o = turn({ form: f, menu: m, message: "and a bagel with plain cream cheese", moves: [{ kind: "add_line", item_span: "bagel", qty: 1, option_spans: ["plain cream cheese"] }] });
  assertEquals(o.form.lines[0].item_id, "bwpcc");
  assertEquals(o.form.lines[0].status.kind, "complete");
});

Deno.test("'that's it' while a slot is open is remembered: once answered, straight to the readback", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "cheeseburger", [{ kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] }]);
  o = say(o.form, "thats it");
  assert(o.form.items_done);
  assertEquals(o.form.open?.kind, "line_slot");
  o = say(o.form, "medium");
  assertEquals(o.form.status, "confirming");
  assertStringIncludes(o.reply, "Reply YES");
});

Deno.test("option phrases with filler still match a choice: 'half anchovies on it'", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "small margherita with bacon on it", [{ kind: "add_line", item_span: "margherita", qty: 1, option_spans: ["small", "bacon on it"] }]);
  assertEquals(o.form.lines[0].modifiers, ["mgBacS"]);
  assertEquals(o.form.lines[0].notes, []);
});

Deno.test("an order with nothing priced never reaches the readback; 'that's it' on an unknown item asks again", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "a unicorn steak", [{ kind: "add_line", item_span: "unicorn steak", qty: 1, option_spans: [] }]);
  o = say(o.form, "thats it");
  assertEquals(o.form.lines.length, 0);
  assertStringIncludes(o.reply, `I'll leave "unicorn steak" off for now.`);
  o = say(o.form, "pickup");
  assertEquals(o.form.open?.kind, "items");
  assert(!o.form.items_done);
  assertStringIncludes(o.reply, "What can I get for you?");
});

Deno.test("toppings: 'bacon' goes on the whole pizza; 'half anchovies' picks the half variant", () => {
  const m = buildMenu({ version: "t", items: [...RAW_ITEMS, { id: "cbrM", name: "Chicken Bacon Ranch - Medium (14\")", display_name: "Medium Chicken Bacon Ranch Pizza", category: "Pizza", price_cents: 1999, bot_state: "orderable",
    ask_plan: { base_price_cents: 1999, steps: [{ group_id: "cbrTop", slot_key: "toppings", kind: "modifier", ask_mode: "on_request", prompt_template: "toppings.ask",
      choices: [{ id: "ancH", display: "Anchovies (Half pizza)", price_delta_cents: 250 }, { id: "ancW", display: "Anchovies (Whole pizza)", price_delta_cents: 250 }, { id: "bacH", display: "Bacon (Half pizza)", price_delta_cents: 250 }, { id: "bacW", display: "Bacon (Whole pizza)", price_delta_cents: 250 }] }] } }],
    lexicon: [...RAW_LEXICON, { term: "chicken bacon ranch pizza", target_type: "item", target_id: "cbrM" }, { term: "chicken bacon ranch", target_type: "item", target_id: "cbrM" }], shop: SHOP });
  let f = newForm("vitos", "test-v1");
  f = turn({ form: f, menu: m, message: "pickup", moves: closedAnswer(f, "pickup", m)! }).form;
  let o = turn({ form: f, menu: m, message: "a medium chicken bacon ranch pizza with half anchovies and bacon", moves: [{ kind: "add_line", item_span: "chicken bacon ranch pizza", qty: 1, option_spans: ["medium", "half anchovies", "bacon"] }] });
  assertEquals(o.form.lines[0].modifiers.sort(), ["ancH", "bacW"]);
  assertEquals(o.form.lines[0].status.kind, "complete");
});

Deno.test("plurals resolve: 'house salads' finds House Salad; a digit answers any list", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "2 house salads with ranch", [{ kind: "add_line", item_span: "house salads", qty: 2, option_spans: ["ranch"] }]);
  assertEquals(o.form.lines[0].item_id, IDS.houseSalad);
  assertEquals(o.form.lines[0].status.kind, "complete");
  o = say(o.form, "cheese", [{ kind: "add_line", item_span: "cheese", qty: 1, option_spans: [] }]);
  assertEquals(o.form.open?.kind, "line_ambiguous");
  o = say(o.form, "2");
  assertEquals(o.form.lines[1].item_id !== null, true);
});

Deno.test("a note-only answer does not count as progress; the ladder still escalates", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "cheeseburger", [{ kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] }]);
  for (let i = 0; i < 3; i++) o = say(o.form, "purple", [{ kind: "answer_option", value_span: "purple" }]);
  assertEquals(o.form.lines.length, 0);
  assertStringIncludes(o.reply, "leave");
});

Deno.test("'steak' among steak and chicken-steak placements picks Steak (Whole); the size in the span is not a note", () => {
  const m = buildMenu({ version: "t", items: [...RAW_ITEMS, { id: "cbrS", name: 'Chicken Bacon Ranch - Small (10")', display_name: "Small Chicken Bacon Ranch Pizza", category: "Pizza", price_cents: 1495, bot_state: "orderable",
    ask_plan: { base_price_cents: 1495, steps: [{ group_id: "cbrTopS", slot_key: "toppings", kind: "modifier", ask_mode: "on_request", prompt_template: "toppings.ask",
      choices: [{ id: "stH", display: "Steak (Half pizza)", price_delta_cents: 200 }, { id: "cstH", display: "Chicken Steak (Half pizza)", price_delta_cents: 200 }, { id: "cstW", display: "Chicken Steak (Whole pizza)", price_delta_cents: 200 }, { id: "stW", display: "Steak (Whole pizza)", price_delta_cents: 200 }] }] } }],
    lexicon: [...RAW_LEXICON, { term: "chicken bacon ranch pizza", target_type: "item", target_id: "cbrS" }, { term: "chicken bacon ranch", target_type: "item", target_id: "cbrS" }], shop: SHOP });
  let f = newForm("vitos", "t");
  f = turn({ form: f, menu: m, message: "pickup", moves: closedAnswer(f, "pickup", m)! }).form;
  const o = turn({ form: f, menu: m, message: 'Chicken Bacon Ranch - Small (10") with steak', moves: [{ kind: "add_line", item_span: "Chicken Bacon Ranch", qty: 1, option_spans: ['Small (10")', "steak"] }] });
  assertEquals(o.form.lines[0].modifiers, ["stW"]);
  assertEquals(o.form.lines[0].notes, []);
  assertEquals(o.form.lines[0].status.kind, "complete");
});

Deno.test("Jason's phone test: four large pizzas, one of each kind, becomes four lines", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "delivery").form;
  f = say(f, "5620 cetronia rd", [addr("5620 Cetronia Rd, Allentown, PA 18106, USA")]).form;
  let o = say(f, "Four large pizzas", [{ kind: "add_line", item_span: "pizzas", qty: 4, option_spans: ["large"] }]);
  assertStringIncludes(o.reply, "What kind of pizzas? We have ");
  o = say(o.form, "One plain one pepperoni one Hawaii one meat lovers", [
    { kind: "answer_option", value_span: "plain" }, { kind: "answer_option", value_span: "pepperoni" },
    { kind: "answer_option", value_span: "Hawaii" }, { kind: "answer_option", value_span: "meat lovers" },
  ]);
  const got = o.form.lines.map((l) => [l.item_id, l.qty]);
  assertEquals(got, [[IDS.cheesePizzaL, 1], [IDS.pepPizzaL, 1], ["hawL", 1], ["mlL", 1]]);
  assertEquals(o.form.lines.every((l) => l.notes.length === 0), true);
  assertEquals(totals(o.form, menu).subtotal_cents, 1800 + 2100 + 2100 + 2300);
  assertStringIncludes(o.reply, "Anything else?");
});

Deno.test("the same answer as one string, with counts: 'two plain and two pepperoni'", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "4 large pizzas", [{ kind: "add_line", item_span: "pizzas", qty: 4, option_spans: ["large"] }]);
  o = say(o.form, "two plain and two pepperoni", [{ kind: "answer_option", value_span: "two plain and two pepperoni" }]);
  assertEquals(o.form.lines.map((l) => [l.item_id, l.qty]), [[IDS.cheesePizzaL, 2], [IDS.pepPizzaL, 2]]);
});

Deno.test("Jason's fries: a non-narrowing answer lists what's left, 'options' lists the question's choices, and the answer is never a note", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "some fries", [{ kind: "add_line", item_span: "fries", qty: 1, option_spans: [] }]);
  assertStringIncludes(o.reply, "What kind of fries? We have ");
  assertStringIncludes(o.reply, "French");
  o = say(o.form, "Plain fries.", [{ kind: "answer_option", value_span: "Plain fries" }]);
  assertStringIncludes(o.reply, "What kind of fries? We have ");
  o = say(o.form, "what are the options");
  assert(o.reply.includes("We have ") || o.reply.includes("Which one?"), o.reply); // the question carries the list (numbered on the second re-ask)
  assertEquals(o.reply.split("French").length, 2); // listed once, not twice
  assert(!o.reply.includes("Categories"));
  o = say(o.form, "french fries?", [{ kind: "answer_option", value_span: "french fries" }]);
  assertEquals(o.form.lines[0].item_id, IDS.fries);
  assertEquals(o.form.lines[0].notes, []);
  assert(!o.reply.includes("Noted"));
});

Deno.test("the model answers a kind question with an invented item word: the verbatim kinds still split the line", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "Four large pizzas", [{ kind: "add_line", item_span: "pizzas", qty: 4, option_spans: ["large"] }]);
  o = say(o.form, "One plain one pepperoni one Hawaii one meat lovers", [
    { kind: "remove_line", ref: { span: "pizzas" } },
    { kind: "add_line", item_span: "pizza", qty: 1, option_spans: ["cheese"] },
    { kind: "add_line", item_span: "pizza", qty: 1, option_spans: ["pepperoni"] },
    { kind: "add_line", item_span: "pizza", qty: 1, option_spans: ["Hawaii"] },
    { kind: "add_line", item_span: "pizza", qty: 1, option_spans: ["meat lovers"] },
  ]);
  assertEquals(o.form.lines.map((l) => [l.item_id, l.qty]), [[IDS.cheesePizzaL, 1], [IDS.pepPizzaL, 1], ["hawL", 1], ["mlL", 1]]);
  assertEquals(o.form.omissions, []);
});

Deno.test("Jason's fourth test: words that name the item are never kitchen notes; a size on a sizeless item is dropped", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "cheese steak, large cheese fries", [
    { kind: "add_line", item_span: "cheese steak", qty: 1, option_spans: [] },
    { kind: "add_line", item_span: "large cheese fries", qty: 1, option_spans: [] },
  ]);
  assertEquals(o.form.lines.map((l) => [l.item_id, l.notes]), [[IDS.cheesesteak, []], [IDS.cheeseFries, []]]);
  assert(!o.reply.includes("Noted"));
});

Deno.test("talk: a remark gets a short reply before the open question, and is not 'didn't catch that'", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "garlic knots", [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  o = say(o.form, "what does that mean? weird thing to say", [{ kind: "talk", text: "Sorry about that, I worded it badly. Nothing changes on your order." }]);
  assert(o.reply.startsWith("Sorry about that, I worded it badly."));
  assert(!o.reply.includes("didn't catch"));
  assertStringIncludes(o.reply, "Anything else");
  assertEquals(o.form.asked.count, 0);
  o = say(o.form, "so close. but now you failed", [{ kind: "talk", text: "I hear you. Tell me what's wrong and I'll fix the order." }]);
  assert(!o.reply.includes("didn't catch"));
});

Deno.test("talk validator refuses money and action claims", () => {
  const m = buildMenu({ version: "t", items: RAW_ITEMS, lexicon: RAW_LEXICON, shop: SHOP });
  let f = newForm("vitos", "t"); f = turn({ form: f, menu: m, message: "pickup", moves: closedAnswer(f, "pickup", m)! }).form;
  const o = turn({ form: f, menu: m, message: "hmm", moves: [{ kind: "talk", text: "I added a free pizza for $0.00!" }] });
  assert(!o.reply.includes("free pizza"));
});

Deno.test("half and half: 'large pie half pepperoni half mushroom' is one large cheese pizza with two half toppings", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "gimme a large pie half pepperoni half mushroom", [{ kind: "add_line", item_span: "pie", qty: 1, option_spans: ["large", "half pepperoni", "half mushroom"] }]);
  assertEquals(o.form.lines.length, 1);
  assertEquals(o.form.lines[0].item_id, IDS.cheesePizzaL);
  assertEquals(o.form.lines[0].modifiers.sort(), [IDS.mushChoiceL + "H", IDS.pepChoiceL + "H"].sort());
  assertEquals(o.form.lines[0].status.kind, "complete");
});

Deno.test("half and half as ONE option span: 'half pepperoni half mushroom' still binds the base pizza", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "large pie half pepperoni half mushroom", [{ kind: "add_line", item_span: "pie", qty: 1, option_spans: ["large", "half pepperoni half mushroom"] }]);
  assertEquals(o.form.lines.length, 1);
  assertEquals(o.form.lines[0].item_id, IDS.cheesePizzaL);
  assertEquals(o.form.lines[0].modifiers.sort(), [IDS.mushChoiceL + "H", IDS.pepChoiceL + "H"].sort());
  assertEquals(o.form.lines[0].status.kind, "complete");
  assert(!o.reply.includes("What kind"));
});

Deno.test("half and half without a size asks the size, not the kind", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "a pie half pepperoni half mushroom", [{ kind: "add_line", item_span: "pie", qty: 1, option_spans: ["half pepperoni half mushroom"] }]);
  assertStringIncludes(o.reply, "What size");
  o = say(o.form, "large", [{ kind: "answer_option", value_span: "large" }]);
  assertEquals(o.form.lines[0].item_id, IDS.cheesePizzaL);
  assertEquals(o.form.lines[0].modifiers.sort(), [IDS.mushChoiceL + "H", IDS.pepChoiceL + "H"].sort());
  assertEquals(o.form.lines[0].status.kind, "complete");
});

Deno.test("'large pie with pepperoni and mushrooms' is the large cheese base with two whole toppings", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "large pie with pepperoni and mushrooms", [{ kind: "add_line", item_span: "pie", qty: 1, option_spans: ["large", "pepperoni and mushrooms"] }]);
  assertEquals(o.form.lines.length, 1);
  // canon form: Large Pepperoni Pizza + Mushroom; same price as the cheese base with two toppings
  assertEquals(o.form.lines[0].status.kind, "complete");
  assertEquals(totals(o.form, menu).subtotal_cents, 2400);
  assertStringIncludes(o.reply, "Mushroom");
  assertStringIncludes(o.reply, "Pepperoni");
});

Deno.test("plural drift and a stem: '2 chicken parm sandwiches one on white one on wheat' keeps both sandwiches", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "2 chicken parm sandwiches one on white one on wheat and a side of fries extra crispy", [
    { kind: "add_line", item_span: "chicken parm sandwich", qty: 1, option_spans: ["white"] },
    { kind: "add_line", item_span: "chicken parm sandwich", qty: 1, option_spans: ["wheat"] },
    { kind: "add_line", item_span: "fries", qty: 1, option_spans: [], note: "extra crispy" },
  ]);
  assertEquals(o.form.lines.map((l) => l.item_id), ["chparm", "chparm", null]);
  assertEquals(Object.values(o.form.lines[0].choices).flat(), ["brWhite"]);
  assertEquals(Object.values(o.form.lines[1].choices).flat(), ["brWheat"]);
  assert(!o.reply.includes("Did you also want"), o.reply);
  assertStringIncludes(o.reply, "Chicken Parmesan");
  assertStringIncludes(o.reply, "What kind of fries"); // the fixture has six kinds of fries
});

Deno.test("'actually pepperoni not cheese' as an empty change_line beside an add is a replacement", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "a large cheese pizza and garlic knots", [
    { kind: "add_line", item_span: "large cheese pizza", qty: 1, option_spans: [] },
    { kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] },
  ]);
  o = say(o.form, "actually pepperoni not cheese", [
    { kind: "change_line", ref: { line_id: 1 }, qty: null, add_option_spans: [], remove_option_spans: [] },
    { kind: "add_line", item_span: "pepperoni", qty: 1, option_spans: [] },
  ]);
  assertEquals(o.form.lines.map((l) => l.item_id).filter((x) => x === IDS.cheesePizzaL), []);
  assertEquals(o.form.lines.length, 2);
  o = say(o.form, "large", [{ kind: "answer_option", value_span: "large" }]);
  assertEquals(o.form.lines.map((l) => l.item_id).sort(), [IDS.knots, IDS.pepPizzaL].sort());
  // an empty change_line on its own changes nothing
  const before = o.form.lines.length;
  o = say(o.form, "the knots", [{ kind: "change_line", ref: { span: "knots" }, add_option_spans: [], remove_option_spans: [] }]);
  assertEquals(o.form.lines.length, before);
});

Deno.test("an answer that fits another pending line goes to that line: 'boneless' while we ask about the garlic bread", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "20 wings buffalo, and garlic bread", [
    { kind: "add_line", item_span: "wings", qty: 20, option_spans: ["buffalo"] },
    { kind: "add_line", item_span: "garlic bread", qty: 1, option_spans: [] },
  ]);
  assertEquals(o.form.open?.kind, "line_unresolved");
  o = say(o.form, "boneless", [{ kind: "answer_option", value_span: "boneless" }]);
  assertEquals(o.form.lines.find((l) => l.span === "wings")?.item_id, "wbo");
  assertEquals(o.form.lines.find((l) => l.span === "garlic bread")?.status.kind, "unresolved"); // still asked about, not replaced
  assertStringIncludes(o.reply, "garlic bread");
  // the same word as a model add_line routes the same way
  let p = say(f, "20 wings buffalo, and garlic bread", [
    { kind: "add_line", item_span: "wings", qty: 20, option_spans: ["buffalo"] },
    { kind: "add_line", item_span: "garlic bread", qty: 1, option_spans: [] },
  ]);
  p = say(p.form, "boneless", [{ kind: "add_line", item_span: "boneless", qty: 1, option_spans: [] }]);
  assertEquals(p.form.lines.length, 2);
  assertEquals(p.form.lines.find((l) => l.span === "wings")?.item_id, "wbo");
});

Deno.test("a closed answer is the whole message: 'thats everything' never asks about an 'everything' item", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "garlic knots", [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  o = say(o.form, "thats everything");
  assert(!o.reply.includes("Did you also want"), o.reply);
  assertEquals(o.form.items_done, true);
});

Deno.test("phone test 5: 'Chicken parm' never becomes the $12.49 'Chicken' quesadilla that owns the bare word", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "Four large pizzas. Chicken parm. And some fries", [
    { kind: "add_line", item_span: "pizzas", qty: 4, option_spans: ["large"] },
    { kind: "add_line", item_span: "Chicken parm", qty: 1, option_spans: [] },
    { kind: "add_line", item_span: "fries", qty: 1, option_spans: [] },
  ]);
  const parm = o.form.lines.find((l) => l.span === "Chicken parm")!;
  assert(parm.item_id !== "chq", "bare 'chicken' term must not win");
  assertEquals(parm.status.kind, "ambiguous"); // sandwich vs entree: a question, never a guess
  assert(!o.reply.includes("Added 1 x Chicken "), o.reply);
  // the bare word alone still finds the quesadilla
  const q = say(f, "a chicken", [{ kind: "add_line", item_span: "chicken", qty: 1, option_spans: [] }]);
  assertEquals(q.form.lines[0].item_id, "chq");
});

Deno.test("Jev eval findings: a size word in the span resolves ('bowl of lobster bisque'); 'medium size' narrows by medium", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "can I get a bowl of lobster bisque", [{ kind: "add_line", item_span: "bowl of lobster bisque", qty: 1, option_spans: [] }]);
  assertEquals(o.form.lines[0].item_id, "lbBowl");
  assertEquals(o.form.lines[0].status.kind, "complete");
  o = say(f, "a cup of lobster bisque please", [{ kind: "add_line", item_span: "lobster bisque", qty: 1, option_spans: ["a cup"] }]);
  assertEquals(o.form.lines[0].item_id, "lbCup");
  o = say(f, "pepperoni pizza, medium size", [{ kind: "add_line", item_span: "pepperoni pizza", qty: 1, option_spans: ["medium size"] }]);
  assertEquals(o.form.lines[0].item_id, IDS.pepPizzaM);
  assertEquals(o.form.lines[0].status.kind, "complete");
  // a bare 'lobster bisque' still asks the size, and names it as a size question
  o = say(f, "lobster bisque", [{ kind: "add_line", item_span: "lobster bisque", qty: 1, option_spans: [] }]);
  assertStringIncludes(o.reply, "What size");
  assertStringIncludes(o.reply, "Cup or Bowl");
});

Deno.test("judge: an omission below the threshold is not asked; at or above it, or with no judge, it is", () => {
  const m = buildMenu({ version: "t", items: RAW_ITEMS, lexicon: RAW_LEXICON, shop: SHOP });
  let f = newForm("vitos", "t"); f = turn({ form: f, menu: m, message: "pickup", moves: closedAnswer(f, "pickup", m)! }).form;
  const moves: Move[] = [{ kind: "add_line", item_span: "pepperoni pizza", qty: 2, option_spans: ["large"] }]; // the model dropped the knots
  const msg = "2 large pepperoni pizzas and an order of garlic knots";
  const plain = turn({ form: f, menu: m, message: msg, moves });
  assert(plain.ledger.some((e) => e.event === "possible_omission"));
  assertEquals(plain.form.omissions.map((o) => o.span), ["garlic knots"]);
  const dropped = turn({ form: f, menu: m, message: msg, moves, judgments: { omission_asked_p: { "garlic knots": 0.1 } } });
  assertEquals(dropped.form.omissions, []);
  assert(dropped.ledger.some((e) => e.event === "omission_dropped_by_judge"));
  assert(!dropped.reply.includes("Did you also want"));
  const kept = turn({ form: f, menu: m, message: msg, moves, judgments: { omission_asked_p: { "garlic knots": 0.9 } } });
  assertEquals(kept.form.omissions.map((o) => o.span), ["garlic knots"]);
});

Deno.test("phone test 6: 'what is crazy fries' answers with the menu description, not a price alone or an invention", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "wait, what is crazy fries?", [{ kind: "ask_menu", about_span: "crazy fries" }]);
  assertStringIncludes(o.reply, "Crazy Fries: Chicken steak meat, onions, nacho cheese, mild sauce.");
  assert(!o.reply.includes("$"), o.reply);
  const p = say(f, "how much is crazy fries?", [{ kind: "ask_menu", about_span: "crazy fries" }]);
  assertStringIncludes(p.reply, "Crazy Fries: Chicken steak meat, onions, nacho cheese, mild sauce. $7.49.");
});

Deno.test("phone test 6: a generic word inside a remark is not an omission; the same word while ordering still is", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const remark = say(f, "You dont have to text me when it's ready, it will just show up at my house", [{ kind: "talk", text: "Got it, no text." }]);
  assert(!remark.reply.includes("Did you also want"), remark.reply);
  assertEquals(remark.form.omissions, []);
  assert(remark.ledger.some((e) => e.event === "omission_ignored_in_remark"));
  const ordering = say(f, "a large pepperoni pizza and a house", [{ kind: "add_line", item_span: "large pepperoni pizza", qty: 1, option_spans: [] }]);
  assertStringIncludes(ordering.reply, "Did you also want house");
  const knots = say(f, "oh and garlic knots", [{ kind: "talk", text: "Sure." }]);
  assertStringIncludes(knots.reply, "Did you also want garlic knots"); // a multi-word item name is evidence even in a remark
});

Deno.test("phone test 6: the pay line promises a wait, not a text", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "garlic knots", [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  o = say(o.form, "thats it"); o = say(o.form, "yes");
  assert(!o.reply.includes("text you"), o.reply);
  assertStringIncludes(o.reply, "10-15 min");
});

Deno.test("tester pass 1: 'chicken wings' is the wings category, never the 'Chicken' quesadilla", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const q = say(f, "do you guys have like chicken wings or anything", [{ kind: "ask_menu", about_span: "chicken wings" }]);
  assert(!q.reply.includes("Quesadilla") && !q.reply.includes("Chicken:"), q.reply);
  assertStringIncludes(q.reply, "Wings");
  const o = say(f, "chicken wings", [{ kind: "add_line", item_span: "chicken wings", qty: 1, option_spans: [] }]);
  assert(o.form.lines[0].item_id !== "chq");
  assertEquals(o.form.lines[0].status.kind, "ambiguous");
});

Deno.test("tester pass 1: one answer fills a gyro's duplicate Beef/Chicken slots; no second question, no loop", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "a gyro sandwich", [{ kind: "add_line", item_span: "gyro sandwich", qty: 1, option_spans: [] }]);
  assertEquals(o.form.open?.kind, "line_slot");
  o = say(o.form, "beef gyro sandwich please", [{ kind: "answer_option", value_span: "beef gyro sandwich please" }]);
  assertEquals(o.form.lines[0].status.kind, "complete", o.reply);
  assertEquals(o.form.lines[0].choices, { gyroA: "gA-beef", gyroB: "gB-beef" });
  assert(!o.reply.includes("Beef or Chicken") && !o.reply.includes("beef or chicken"), o.reply);
});

Deno.test("tester pass 1: answering a kind question with an item the list missed takes that item", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "a burger", [{ kind: "add_line", item_span: "burger", qty: 1, option_spans: [] }]);
  assertStringIncludes(o.reply, "What kind of burger");
  o = say(o.form, "bacon cheeseburger", [{ kind: "answer_option", value_span: "bacon cheeseburger" }]);
  assertEquals(o.form.lines[0].item_id, IDS.baconCheeseburger);
  assert(!o.reply.includes("couldn't find") && !o.reply.includes("didn't follow"), o.reply);
});

Deno.test("tester pass 1: an answer that IS a candidate's name wins over names that contain it (no calzone / everything-bagel loop)", () => {
  const m = fixtureMenu();
  // Everything Bagel vs Egg Everything vs Whole Wheat Everything share the word; the exact name wins
  assertEquals(narrow(["bg-every", "bg-egg-every", "bg-ww-every"], "everything", m), ["bg-every"]);
  assertEquals(narrow(["bg-every", "bg-egg-every", "bg-ww-every"], "egg everything", m), ["bg-egg-every"]);
  assertEquals(narrow(["bg-every", "bg-egg-every", "bg-ww-every"], "bagel", m).length, 3); // a word they all share narrows nothing
});

Deno.test("tester pass 1: 'no wraps' is a decline, not an omission; 'yes' never double-adds what the message already added", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "a cheeseburger, and no fries for me thanks", [{ kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] }]);
  assertEquals(o.form.omissions, []);
  let p = say(f, "2 large pepperoni pizzas and an order of garlic knots", [{ kind: "add_line", item_span: "pepperoni pizza", qty: 2, option_spans: ["large"] }]);
  assertStringIncludes(p.reply, "Did you also want garlic knots");
  p = say(p.form, "yes the garlic knots", [{ kind: "answer_yes" }, { kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  assertEquals(p.form.lines.filter((l) => l.item_id === IDS.knots).length, 1);
});

Deno.test("tester pass 1: '12 inch' restating the item's own size is never a kitchen note", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "a medium 14 inch pepperoni pizza", [{ kind: "add_line", item_span: "pepperoni pizza", qty: 1, option_spans: ["medium 14 inch"] }]);
  assertEquals(o.form.lines[0].item_id, IDS.pepPizzaM);
  assertEquals(o.form.lines[0].notes, []);
});

Deno.test("tester pass 2: 'medium pepperoni pizza. small pepperoni pizza' is one of each, never two mediums", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "a medium pepperoni pizza. small pepperoni pizza", [
    { kind: "add_line", item_span: "pepperoni pizza", qty: 1, option_spans: ["medium"] },
    { kind: "add_line", item_span: "pepperoni pizza", qty: 1, option_spans: ["small"] },
  ]);
  assertEquals(o.form.lines.map((l) => l.item_id).sort(), [IDS.pepPizzaM, IDS.pepPizzaS].sort());
  assertEquals(o.form.omissions, []);
});

Deno.test("tester pass 2: 'hawaiian pie' is the Hawaiian pizza, not every pizza", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "a hawaiian pie", [{ kind: "add_line", item_span: "hawaiian pie", qty: 1, option_spans: [] }]);
  assertEquals(o.form.lines[0].item_id, "hawL");
});

Deno.test("tester pass 2: 'what comes on the pepperoni' answers once with the description and the size prices", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "what comes on the pepperoni pizza", [{ kind: "ask_menu", about_span: "pepperoni pizza" }]);
  assertStringIncludes(o.reply, "Pepperoni Pizza: Our cheese pizza with pepperoni. Sizes: Small, Medium, Large.");
  const p = say(f, "how much is a pepperoni pizza", [{ kind: "ask_menu", about_span: "pepperoni pizza" }]);
  assertStringIncludes(p.reply, "Pepperoni Pizza: Our cheese pizza with pepperoni. Small $12.99, Medium $17.49, Large $21.00.");
});

Deno.test("tester pass 2: two identical lines never ask 'which one do you mean'; removing a line never asks 'did you also want' it", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "garlic knots", [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  o = say(o.form, "another garlic knots", [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  assertEquals(o.form.lines.map((l) => l.qty), [2]); // identical lines merge (2026-09-25)
  o = say(o.form, "make the knots 3", [{ kind: "change_line", ref: { span: "knots" }, qty: 3 }]);
  assert(!o.reply.includes("Which one do you mean"), o.reply);
  let p = say(f, "a cup of lobster bisque and garlic knots", [{ kind: "add_line", item_span: "cup of lobster bisque", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  p = say(p.form, "actually scratch the soup", [{ kind: "remove_line", ref: { span: "soup" } }]);
  assertEquals(p.form.lines.map((l) => l.item_id), [IDS.knots]);
  assert(!p.reply.includes("Did you also want"), p.reply);
});

Deno.test("tester pass 2: a slot answer with more in the message is not a closed answer; the removal in it reaches the model", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "a cheeseburger and garlic knots", [{ kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  assertEquals(o.form.open?.kind, "line_slot");
  assertEquals(closedAnswer(o.form, "medium well", menu)?.[0]?.kind, "answer_option"); // the whole message is the option
  assertEquals(closedAnswer(o.form, "medium well. actually scratch the knots", menu), null); // more in it: the model must read it
  o = say(o.form, "medium well. actually scratch the knots", [{ kind: "answer_option", value_span: "medium well" }, { kind: "remove_line", ref: { span: "knots" } }]);
  assertEquals(o.form.lines.map((l) => l.item_id), [IDS.cheeseburger]);
  assertEquals(o.form.lines[0].status.kind, "complete");
});

Deno.test("tester pass 2: 'grilled chicken salad please' picks Grilled Chicken Salad over Buffalo Grilled Chicken Salad", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "a salad", [{ kind: "add_line", item_span: "salad", qty: 1, option_spans: [] }]);
  assertStringIncludes(o.reply, "What kind of salad");
  o = say(o.form, "grilled chicken salad please", [{ kind: "answer_option", value_span: "grilled chicken salad please" }]);
  assertEquals(o.form.lines[0].item_id, "gcs");
});

Deno.test("tester pass 3: 'meatball sub' is not Nonas Meatballs; 'pepperoni pie' still finds the pepperoni pizzas", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "a meatball sub", [{ kind: "add_line", item_span: "meatball sub", qty: 1, option_spans: [] }]);
  assertEquals(o.form.lines[0].item_id, null);
  assertStringIncludes(o.reply, `couldn't find "meatball sub"`);
  const p = say(f, "a pepperoni pie", [{ kind: "add_line", item_span: "pepperoni pie", qty: 1, option_spans: [] }]);
  assertStringIncludes(p.reply, "What size Pepperoni Pizza");
});

Deno.test("tester pass 3: 'medium well on the burger' never asks 'did you also want burger'", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "a bacon cheeseburger", [{ kind: "add_line", item_span: "bacon cheeseburger", qty: 1, option_spans: [] }]);
  o = say(o.form, "medium well on the burger please", [{ kind: "answer_option", value_span: "medium well" }]);
  assertEquals(o.form.lines[0].status.kind, "complete");
  assert(!o.reply.includes("Did you also want"), o.reply);
});

Deno.test("tester pass 3: a customer correcting the ZIP wins over the geocoder's ZIP", () => {
  const geo = (text: string) => ({ kind: "answer", field: "address", value: { text, formatted: "3300 Hamilton Blvd, Allentown, PA 18104, USA", validated: true, zone_ok: true } } as Move);
  let f = newForm("vitos", "test-v1");
  let o = say(f, "delivery");
  o = say(o.form, "3300 Hamilton Blvd, Allentown, PA 18103", [geo("3300 Hamilton Blvd, Allentown, PA 18103")]);
  assertStringIncludes(o.reply, "18104"); // the geocoder's answer stands the first time
  o = say(o.form, "wait that zip code is wrong. should be 18103 not 18104", [geo("wait that zip code is wrong. should be 18103 not 18104")]);
  assertEquals(o.form.address?.formatted, "3300 Hamilton Blvd, Allentown, PA 18103, USA");
  assertStringIncludes(o.reply, "18103");
  assert(!o.reply.includes("18104"), o.reply);
});

Deno.test("phone test 7: 'one of each except pizza fries' as seven adds of 'fries' is a split of the fries line, never a drop", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "six orders of fries and a cheeseburger", [{ kind: "add_line", item_span: "fries", qty: 6, option_spans: [] }, { kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] }]);
  assertStringIncludes(o.reply, "What kind of fries");
  const kinds = ["french", "cheese", "bacon cheese", "buffalo chicken", "crazy"];
  o = say(o.form, "ill have one of each except for pizza fries. i dont want that", [
    ...kinds.map((k) => ({ kind: "add_line", item_span: "fries", qty: 1, option_spans: [k] }) as Move),
    { kind: "remove_line", ref: { line_id: 1 } },
  ]);
  assert(!o.reply.includes("leave"), o.reply);
  const friesLines = o.form.lines.filter((l) => l.line_id !== 2);
  assertEquals(friesLines.length, 5);
  assertEquals(friesLines.filter((l) => l.status.kind === "ambiguous").length, 0);
  assertEquals(new Set(friesLines.map((l) => l.item_id)).size, 5);
});

Deno.test("phone test 7: 'one of each' is a closed answer to a kind question", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "six orders of fries", [{ kind: "add_line", item_span: "fries", qty: 6, option_spans: [] }]);
  const closed = closedAnswer(o.form, "One of each", menu);
  assertEquals(closed?.[0]?.kind, "split_line");
  o = say(o.form, "One of each");
  assertEquals(o.form.lines.filter((l) => l.status.kind === "ambiguous").length, 0);
  assertEquals(new Set(o.form.lines.map((l) => l.item_id).filter(Boolean)).size, 6);
});

Deno.test("phone test 8: the kinds named as full items plus one answered kind are a split; 'one of each except X' inside a sentence too", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "cheeseburger and some fries", [{ kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "fries", qty: 1, option_spans: [] }]);
  o = say(o.form, "medium", [{ kind: "answer_option", value_span: "medium" }]);
  assertStringIncludes(o.reply, "What kind of fries");
  const a = say(o.form, "those all sound good. give me one of each except the pizza fries", [
    ...["french fries", "cheese fries", "bacon cheese fries", "buffalo chicken fries"].map((n) => ({ kind: "add_line", item_span: n, qty: 1, option_spans: [] }) as Move),
    { kind: "answer_option", value_span: "Crazy" }, { kind: "remove_line", ref: { line_id: 2 } },
  ]);
  const fries = a.form.lines.filter((l) => l.line_id !== 1);
  assertEquals(new Set(fries.map((l) => l.item_id)).size, 5, a.reply);
  assert(!fries.some((l) => l.item_id === "pzf"));
  // the same words with a useless model answer: the phrase alone carries it
  const b = say(o.form, "I already told you one of each, except pizza fries", [{ kind: "change_line", ref: { line_id: 2 }, qty: 7 }]);
  assertEquals(new Set(b.form.lines.filter((l) => l.line_id !== 1).map((l) => l.item_id)).size, 5, b.reply);
});

Deno.test("phone test 9: 'hawiaan' is the Hawaiian; a kind the model dropped ('plain') still joins the split", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "4 large pizzas", [{ kind: "add_line", item_span: "pizzas", qty: 4, option_spans: ["large"] }]);
  o = say(o.form, "One plain, one pepperoni, one meat lover and one hawiaan", [
    { kind: "add_line", item_span: "pepperoni", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "meat lover", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "hawiaan", qty: 1, option_spans: [] },
  ]);
  assertEquals(o.form.lines.map((l) => l.item_id).sort(), [IDS.cheesePizzaL, IDS.pepPizzaL, "hawL", "mlL"].sort(), o.reply);
  assert(!o.reply.includes("couldn't find"), o.reply);
  // the model's own shape from the live ledger: answered kinds, one of them misspelt
  let m2 = say(f, "4 large pizzas", [{ kind: "add_line", item_span: "pizzas", qty: 4, option_spans: ["large"] }]);
  m2 = say(m2.form, "One plain, one pepperoni, one meat lover and one hawiaan", [
    { kind: "answer_option", value_span: "plain" }, { kind: "add_line", item_span: "pepperoni", qty: 1, option_spans: [] }, { kind: "answer_option", value_span: "meat lover" }, { kind: "answer_option", value_span: "hawiaan" },
  ]);
  assertEquals(m2.form.lines.map((l) => l.item_id).sort(), [IDS.cheesePizzaL, IDS.pepPizzaL, "hawL", "mlL"].sort(), m2.reply);
  let m3 = say(f, "4 large pizzas", [{ kind: "add_line", item_span: "pizzas", qty: 4, option_spans: ["large"] }]);
  m3 = say(m3.form, "one plain, one pepperoni and one zzzzqq", [{ kind: "answer_option", value_span: "plain" }, { kind: "answer_option", value_span: "pepperoni" }, { kind: "answer_option", value_span: "zzzzqq" }]);
  assertStringIncludes(m3.reply, `couldn't find "zzzzqq"`); // an unknown kind is asked about, never dropped
  const p = say(f, "a peperoni pizza", [{ kind: "add_line", item_span: "peperoni pizza", qty: 1, option_spans: [] }]);
  assertStringIncludes(p.reply, "What size Pepperoni Pizza");
  const q = say(f, "a zzzzqq", [{ kind: "add_line", item_span: "zzzzqq", qty: 1, option_spans: [] }]);
  assertStringIncludes(q.reply, `couldn't find "zzzzqq"`); // no near word: still honest
});

Deno.test("tester pass 4: 'parm' is a stem, never a typo; '3 pizzas, one pepperoni, one mushroom, one plain' is three lines; a slot answer may name the item", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const a = say(f, "a chicken parm sandwich", [{ kind: "add_line", item_span: "chicken parm sandwich", qty: 1, option_spans: [] }]);
  assertEquals(a.form.lines[0].item_id, "chparm", a.reply);
  const b = say(f, "3 large cheese pizzas. one pepperoni, one mushroom, one plain", [{ kind: "add_line", item_span: "large cheese pizzas", qty: 3, option_spans: ["pepperoni", "mushroom", "plain"] }]);
  assertEquals(b.form.lines.map((l) => [l.item_id, l.qty]), [[IDS.pepPizzaL, 1], ["mushL", 1], [IDS.cheesePizzaL, 1]], b.reply);
  assertEquals(b.form.lines[2].notes, []);
  let c = say(f, "a cheeseburger", [{ kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] }]);
  assertEquals(closedAnswer(c.form, "medium well for the cheese burger please", menu)?.[0]?.kind, "answer_option");
  c = say(c.form, "medium well for the cheese burger please");
  assertEquals(c.form.lines[0].status.kind, "complete");
});

Deno.test("tester pass 5: a bare 'cheesesteak' beside 'chicken cheesesteak salad' stays its own item; fillers, 4-letter typos and split compounds resolve", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const a = say(f, "a cheesesteak, chicken cheesesteak salad and garlic knots", [
    { kind: "add_line", item_span: "cheesesteak", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "chicken cheesesteak salad", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] },
  ]);
  assertEquals(a.form.lines.filter((l) => l.item_id === "cssal").length, 1, a.reply);
  assertEquals(a.form.lines[0].item_id, IDS.cheesesteak);
  const b = say(f, "a bacon cheeseburger thing", [{ kind: "add_line", item_span: "bacon cheeseburger thing", qty: 1, option_spans: [] }]);
  assertEquals(b.form.lines[0].item_id, IDS.baconCheeseburger, b.reply);
  const c = say(f, "a peperoni piza", [{ kind: "add_line", item_span: "peperoni piza", qty: 1, option_spans: [] }]);
  assertStringIncludes(c.reply, "What size Pepperoni Pizza");
  const d = say(f, "a bacon cheese burger", [{ kind: "add_line", item_span: "bacon cheese burger", qty: 1, option_spans: [] }]);
  assertEquals(d.form.lines[0].item_id, IDS.baconCheeseburger, d.reply);
  assert(!menu.itemTerms.some((t) => t.target_id === "louk" && t.words.length < 3), "Topping/Sauce/Filling is one phrase, never the terms 'sauce' and 'filling'");
  assert(menu.itemTerms.some((t) => t.target_id === "cssal" && t.words.join(" ") === "cheesesteak salad"));
  assert(!menu.itemTerms.some((t) => t.target_id === "cssal" && t.words.join(" ").startsWith("cheesesteak chicken")), "the compiler's slash-name-as-one-run rows are dropped at load");
  // a squashed lexicon row ("frenchfries") never joins "french fries" into one word: only words an item NAME writes as one do
  const g = say(f, "french fries", [{ kind: "add_line", item_span: "french fries", qty: 1, option_spans: [] }]);
  assertEquals(g.form.lines[0].item_id, IDS.fries, g.reply);
});

Deno.test("tester pass 5: an answer to a waiting line's slot lands there while another line's question is open; model questions are not talk", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "some fries and a house salad", [{ kind: "add_line", item_span: "fries", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "house salad", qty: 1, option_spans: [] }]);
  assertStringIncludes(o.reply, "What kind of fries?");
  o = say(o.form, "ranch", [{ kind: "talk", text: "Did you want ranch on one of your items?" }]);
  assertEquals(o.form.lines[1].choices[IDS.dressingGroup], IDS.ranch, o.reply);
  assert(!o.reply.includes("Did you want"), o.reply); // the engine asks the questions
  assertStringIncludes(o.reply, "What kind of fries?");
  // two required slots and a paid "Chicken" add-on: bare answers fill the slots in turn, the add-on is never assumed
  let p = say(f, "soup and a chicken cheesesteak salad", [{ kind: "add_line", item_span: "soup", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "chicken cheesesteak salad", qty: 1, option_spans: [] }]);
  assert(p.form.lines[0].status.kind !== "complete", p.reply); // the soup's size is the open question; "ranch" and "chicken" answer nothing about it
  p = say(p.form, "ranch");
  assertStringIncludes(p.reply, "Ranch for the Cheesesteak / Chicken Cheesesteak Salad.");
  p = say(p.form, "chicken");
  assertStringIncludes(p.reply, "Added 1 x Cheesesteak / Chicken Cheesesteak Salad (Ranch, Chicken)");
  assertEquals(p.form.lines[1].modifiers.length, 0);
  assert(p.form.lines[0].status.kind !== "complete", p.reply);
});

Deno.test("tester pass 5: a removal naming one line outright never asks which-one against a line it merely overlaps", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "fries and cheese fries", [{ kind: "add_line", item_span: "fries", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "cheese fries", qty: 1, option_spans: [] }]);
  assertEquals(o.form.lines.length, 2, o.reply);
  o = say(o.form, "scratch the cheese fries", [{ kind: "remove_line", ref: { span: "cheese fries" } }]);
  assert(!o.reply.includes("Which one do you mean"), o.reply);
  assertEquals(o.form.lines.map((l) => l.item_id), [null], o.reply); // the pending "fries" line stays, still to be narrowed
});

Deno.test("'20 wings' against 10-piece rows is two orders; the kind is still asked", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "20 wings buffalo", [{ kind: "add_line", item_span: "wings", qty: 20, option_spans: ["buffalo"] }]);
  assertEquals(o.form.open?.kind, "line_ambiguous");
  assertStringIncludes(o.reply, "What kind of wings? We have Wings Bone-In, Wings Boneless.");
  o = say(o.form, "boneless", [{ kind: "answer_option", value_span: "boneless" }]);
  assertEquals(o.form.lines[0].item_id, "wbo");
  assertEquals(o.form.lines[0].qty, 2);
  assertEquals(totals(o.form, menu).subtotal_cents, 2398);
});

Deno.test("'make the coke a diet' swaps to Diet Coke instead of a kitchen note", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "a coke", [{ kind: "add_line", item_span: "coke", qty: 1, option_spans: [] }]);
  o = say(o.form, "make the coke a diet", [{ kind: "change_line", ref: { span: "coke" }, add_option_spans: ["diet"] }]);
  assertEquals(o.form.lines.map((l) => l.item_id), ["dcoke"]);
  assert(!o.reply.includes("Noted"));
});

Deno.test("lines taken alongside an unknown item are acknowledged, not silent", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "20 wings, a house salad and garlic bread", [
    { kind: "add_line", item_span: "wings", qty: 20, option_spans: [] },
    { kind: "add_line", item_span: "house salad", qty: 1, option_spans: [] },
    { kind: "add_line", item_span: "garlic bread", qty: 1, option_spans: [] },
  ]);
  assertStringIncludes(o.reply, `I couldn't find "garlic bread"`);
  assertStringIncludes(o.reply, "Got the 20 wings and House Salad too."); // a resolved line is acknowledged by its menu name
});

Deno.test("a menu question about something we don't have gets a plain no", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  const o = say(f, "do you have gluten free crust", [{ kind: "ask_menu", about_span: "gluten free crust" }]);
  assertStringIncludes(o.reply, "I don't see gluten free crust on the menu.");
  const o2 = say(o.form, "whats my total");
  assertStringIncludes(o2.reply, "Your order is empty so far.");
});

Deno.test("tester pass 6: typo whose only rivals are its own plural; 'piece' is filler; a numeric pick after which-one; one answer said twice", () => {
  assertEquals(closestWord("cheesestake", ["cheesesteak", "cheesesteaks", "chicken", "cheese"]), "cheesesteak");
  assertEquals(closestWord("cheesestake", ["cheesesteak", "cheesecake"]), null); // two different words: nothing
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "a cheeseburger and a bacon cheeseburger", [{ kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "bacon cheeseburger", qty: 1, option_spans: [] }]);
  o = say(o.form, "cancel one of the burgers", [{ kind: "remove_line", ref: { span: "burgers" } }]);
  assertStringIncludes(o.reply, "Which one do you mean?");
  o = say(o.form, "cancel the first one", [{ kind: "remove_line", ref: { span: "1" } }]);
  assertEquals(o.form.lines.map((l) => l.item_id), [IDS.baconCheeseburger], o.reply);
  let p = say(f, "some fries and a house salad", [{ kind: "add_line", item_span: "fries", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "house salad", qty: 1, option_spans: [] }]);
  p = say(p.form, "cheese fries for both of em", [{ kind: "answer_option", value_span: "cheese fries" }, { kind: "answer_option", value_span: "cheese fries" }]);
  assertEquals(p.form.lines.filter((l) => l.item_id === IDS.cheeseFries).length, 1, p.reply);
});

Deno.test("tester pass 6: a whole item name the list missed is the line (talk-only turn); its own words replace the first span; talk about menu items is dropped", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "chicken salad", [{ kind: "add_line", item_span: "chicken salad", qty: 1, option_spans: [] }]);
  assertEquals(o.form.lines[0].status.kind, "ambiguous", o.reply);
  o = say(o.form, "yo i said house salad. you have that or nah?", [{ kind: "talk", text: "We have house salad, let me check on that for you." }]);
  assertEquals(o.form.lines[0].item_id, IDS.houseSalad, o.reply);
  assertEquals(o.form.lines[0].modifiers, [], o.reply); // "chicken" from the abandoned span never became the paid Grilled Chicken add-on
  assert(!o.reply.includes("We have"), o.reply);
  assert(!o.reply.includes("Did you also want"), o.reply);
});

Deno.test("tester pass 7: '3 chicken fingers' picks the 3-piece row; 'chicken fingers 3' as an answer is one answer, not a count", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "3 chicken fingers", [{ kind: "add_line", item_span: "chicken fingers", qty: 3, option_spans: [] }]);
  assertEquals(o.form.lines[0].item_id, "cf3", o.reply);
  assertEquals(o.form.lines[0].qty, 1);
  let p = say(f, "some chicken fingers", [{ kind: "add_line", item_span: "chicken fingers", qty: 1, option_spans: [] }]);
  assertEquals(p.form.lines[0].status.kind, "ambiguous", p.reply);
  p = say(p.form, "the chicken fingers 3", [{ kind: "answer_option", value_span: "the chicken fingers 3" }]);
  assertEquals(p.form.lines.map((l) => [l.item_id, l.qty]), [["cf3", 1]], p.reply);
});

Deno.test("tester pass 7: 'a medium and large' are two sizes; a size change swaps the derived row; several options for one slot are asked", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "a medium and large cheese pizza", [{ kind: "add_line", item_span: "cheese pizza", qty: 1, option_spans: ["medium"] }, { kind: "add_line", item_span: "cheese pizza", qty: 1, option_spans: ["large"] }]);
  assertEquals(o.form.lines.map((l) => l.item_id).sort(), [IDS.cheesePizzaL, IDS.cheesePizzaM].sort(), o.reply);
  o = say(o.form, "make the large a medium", [{ kind: "change_line", ref: { span: "large cheese pizza" }, add_option_spans: ["medium"], remove_option_spans: [] }]);
  assertEquals(o.form.lines.map((l) => [l.item_id, l.qty]), [[IDS.cheesePizzaM, 2]], o.reply); // two identical mediums merge
  assertEquals(o.form.lines.flatMap((l) => l.notes), []);
  let p = say(f, "house salad", [{ kind: "add_line", item_span: "house salad", qty: 1, option_spans: [] }]);
  p = say(p.form, "ranch, italian, bleu cheese", [{ kind: "answer_option", value_span: "ranch, italian, bleu cheese" }]);
  assertEquals(p.form.lines[0].status.kind, "needs_slot", p.reply); // one dressing per salad: ask, never pick the longest name
  assertStringIncludes(p.reply, "dressing");
});

Deno.test("tester pass 7 live: a size change sent as 'remove large' alone takes the size the message named; a list of a slot's options is a closed answer", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "large cheese pizza", [{ kind: "add_line", item_span: "cheese pizza", qty: 1, option_spans: ["large"] }]);
  o = say(o.form, "wait make the large cheese pizza a medium", [{ kind: "change_line", ref: { span: "large cheese pizza" }, add_option_spans: [], remove_option_spans: ["Large"] }]); // the model capitalises what it copies
  assertEquals(o.form.lines.map((l) => l.item_id), [IDS.cheesePizzaM], o.reply);
  assertEquals(o.form.lines[0].notes, [], o.reply);
  let p = say(f, "house salad", [{ kind: "add_line", item_span: "house salad", qty: 1, option_spans: [] }]);
  p = say(p.form, "ranch, italian"); // no model moves: closed
  assertEquals(p.form.lines[0].status.kind, "needs_slot", p.reply);
  assertStringIncludes(p.reply, "Ranch or Italian");
});

Deno.test("tester pass 8: adds beside a removal of the asked-about line stay adds with their counts; the model's line pointer yields to the line the words name", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "3 zorgblat sandwiches", [{ kind: "add_line", item_span: "zorgblat sandwiches", qty: 3, option_spans: [] }]);
  assertEquals(o.form.lines[0].status.kind, "unresolved", o.reply);
  o = say(o.form, "hmm ok lemme get 2 chicken parm sandwiches and a cheesesteak instead", [
    { kind: "remove_line", ref: { span: "zorgblat sandwiches" } }, { kind: "add_line", item_span: "chicken parm sandwiches", qty: 2, option_spans: [] }, { kind: "add_line", item_span: "cheesesteak", qty: 1, option_spans: [] },
  ]);
  assertEquals(o.form.lines.map((l) => [l.item_id, l.qty]), [["chparm", 2], [IDS.cheesesteak, 1]], o.reply);
  const cs = o.form.lines[1].line_id;
  o = say(o.form, "white bread for both chicken parms", [{ kind: "answer_option", line_id: cs, value_span: "white bread for both chicken parms" }]);
  assertEquals(o.form.lines[0].choices["breadG"], "brWhite", o.reply);
  assertEquals(o.form.lines[1].held, []);
});

Deno.test("tester pass 8: counted breads for three hoagies split the line, one per bread", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "3 chicken parm sandwiches", [{ kind: "add_line", item_span: "chicken parm sandwiches", qty: 3, option_spans: [] }]);
  assertStringIncludes(o.reply, "what bread?");
  o = say(o.form, "one white, one rye, one wheat", [{ kind: "answer_option", value_span: "one white, one rye, one wheat" }]);
  assertEquals(o.form.lines.map((l) => [l.qty, l.choices["breadG"]]), [[1, "brWhite"], [1, "brRye"], [1, "brWheat"]], o.reply);
  let p = say(f, "3 chicken parm sandwiches", [{ kind: "add_line", item_span: "chicken parm sandwiches", qty: 3, option_spans: [] }]);
  p = say(p.form, "two white one rye", [{ kind: "answer_option", value_span: "two white one rye" }]);
  assertEquals(p.form.lines.map((l) => [l.qty, l.choices["breadG"]]), [[2, "brWhite"], [1, "brRye"]], p.reply);
  let q = say(f, "3 chicken parm sandwiches", [{ kind: "add_line", item_span: "chicken parm sandwiches", qty: 3, option_spans: [] }]);
  q = say(q.form, "white, white, rye", [{ kind: "answer_option", value_span: "white, white, rye" }]);
  assertEquals(q.form.lines.map((l) => [l.qty, l.choices["breadG"]]), [[2, "brWhite"], [1, "brRye"]], q.reply);
  // the live model shape: "qty 2" on the line plus a second add it could not quote; the message decides
  let r = say(f, "3 chicken parm sandwiches", [{ kind: "add_line", item_span: "chicken parm sandwiches", qty: 3, option_spans: [] }]);
  r = say(r.form, "oh my bad. two white one rye", [{ kind: "change_line", ref: { span: "Chicken Parmesan Sandwich" }, qty: 2, add_option_spans: [], remove_option_spans: [] }, { kind: "add_line", item_span: "Chicken Parmesan Sandwich", qty: 1, option_spans: ["rye"] }]);
  assertEquals(r.form.lines.map((l) => [l.qty, l.choices["breadG"]]), [[2, "brWhite"], [1, "brRye"]], r.reply); // and no "White Pizza" line from the bread word
  assert(!r.reply.includes("Pizza"), r.reply);
});

Deno.test("tester pass 9: 'turkey sandwich' is one mention; one-of-each never leaves its own phrase as a line; restating the cart is not an omission; 'what dressings u got' lists the slot", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "turkey sandwich", [{ kind: "add_line", item_span: "turkey sandwich", qty: 1, option_spans: [] }]);
  assertEquals(o.form.lines[0].status.kind, "ambiguous", o.reply);
  o = say(o.form, "turkey sandwich", [{ kind: "answer_option", value_span: "turkey" }]);
  assertEquals(o.form.lines.map((l) => l.item_id), ["tky"], o.reply);
  let p = say(f, "some fries", [{ kind: "add_line", item_span: "fries", qty: 1, option_spans: [] }]);
  p = say(p.form, "one of each except sweet potato", [{ kind: "answer_option", value_span: "one of each except sweet potato" }]);
  assert(p.form.lines.every((l) => l.item_id), p.reply);
  assert(!p.reply.includes("couldn't find") && !p.reply.includes("leave"), p.reply);
  let q = say(f, "a cheesesteak and cheese fries", [{ kind: "add_line", item_span: "cheesesteak", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "cheese fries", qty: 1, option_spans: [] }]);
  q = say(q.form, "nah just the cheesesteak and cheese fries. thats it", [{ kind: "answer", field: "items_done", value: true }]);
  assert(!q.reply.includes("Did you also want"), q.reply);
  let r = say(f, "house salad", [{ kind: "add_line", item_span: "house salad", qty: 1, option_spans: [] }]);
  r = say(r.form, "what dressings u got?", [{ kind: "ask_menu", about_span: "dressings" }]);
  assertStringIncludes(r.reply, "Ranch");
  assertStringIncludes(r.reply, "Italian");
  assert(!r.reply.includes("couldn't find"), r.reply);
});

Deno.test("tester pass 10: 'oil vinegar' is the Oil-Vinegar dressing (a hyphen is a space), with or without 'for the salad'", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "house salad", [{ kind: "add_line", item_span: "house salad", qty: 1, option_spans: [] }]);
  o = say(o.form, "oil vinegar");
  assertEquals(o.form.lines[0].choices[IDS.dressingGroup], "dOilV", o.reply);
  let p = say(f, "house salad", [{ kind: "add_line", item_span: "house salad", qty: 1, option_spans: [] }]);
  p = say(p.form, "oil vinegar for the salad", [{ kind: "answer_option", value_span: "oil vinegar" }]);
  assertEquals(p.form.lines[0].choices[IDS.dressingGroup], "dOilV", p.reply);
  assertEquals(p.form.lines[0].notes, []);
});

Deno.test("tester pass 10: 'french fries extra crispy' answers the fries question and keeps the instruction", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "can i add some fries extra crispy", [{ kind: "add_line", item_span: "fries", qty: 1, option_spans: ["extra crispy"] }]);
  assertStringIncludes(o.reply, "What kind of fries?");
  o = say(o.form, "french fries extra crispy please", [{ kind: "answer_option", value_span: "french fries extra crispy" }]);
  assertEquals(o.form.lines[0].item_id, IDS.fries, o.reply);
  assertEquals(o.form.lines[0].notes, ["extra crispy"], o.reply); // once, not once per time it was said
});

Deno.test("ask, don't guess: the read-back says a robot built it and takes corrections before and after the pay link", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "a cheesesteak and garlic knots", [{ kind: "add_line", item_span: "cheesesteak", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  o = say(o.form, "thats it");
  assertStringIncludes(o.reply, "I'm a robot and I make mistakes");
  assertStringIncludes(o.reply, "Reply YES for your pay link");
  o = say(o.form, "actually make it 2 cheesesteaks and drop the knots", [{ kind: "change_line", ref: { span: "cheesesteaks" }, qty: 2, add_option_spans: [], remove_option_spans: [] }, { kind: "remove_line", ref: { span: "knots" } }]);
  assertEquals(o.form.lines.map((l) => [l.item_id, l.qty]), [[IDS.cheesesteak, 2]], o.reply);
  assertStringIncludes(o.reply, "Updated order for pickup:"); // corrected, and read back again for a fresh YES (the robot line only once)
  o = say(o.form, "yes");
  assert(!o.reply.includes("here's your order"), o.reply); // confirmed: on to the payment link
  o = say(o.form, "wait add garlic knots too", [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  assertEquals(o.form.lines.length, 2, o.reply);
  assertStringIncludes(o.reply, "Total is now"); // a change after the link: the change, the new total and a fresh link
});

Deno.test("ask, don't guess: a re-ask names what we heard; two answers to one slot ask between them; an unreadable answer is never a kitchen note", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "house salad", [{ kind: "add_line", item_span: "house salad", qty: 1, option_spans: [] }]);
  o = say(o.form, "buffalo flavor", [{ kind: "answer_option", value_span: "buffalo flavor" }]);
  assertStringIncludes(o.reply, `Sorry, I didn't catch "buffalo flavor" as the dressing.`);
  assertEquals(o.form.lines[0].notes, [], o.reply);
  o = say(o.form, "the spicy one", [{ kind: "answer_option", value_span: "the spicy one" }]);
  assertStringIncludes(o.reply, "Reply a number"); // third time: numbers
  assertStringIncludes(o.reply, "1) Ranch");
  o = say(o.form, "1");
  assertEquals(o.form.lines[0].choices[IDS.dressingGroup], IDS.ranch, o.reply);
  let p = say(f, "house salad", [{ kind: "add_line", item_span: "house salad", qty: 1, option_spans: [] }]);
  p = say(p.form, "ranch. no wait italian. ugh actually ranch", [{ kind: "answer_option", value_span: "italian" }, { kind: "answer_option", value_span: "ranch" }]);
  assertEquals(p.form.lines[0].status.kind, "needs_slot", p.reply); // conflicting reads in one turn ask, never last-one-wins
  assertStringIncludes(p.reply, "Italian");
  assertStringIncludes(p.reply, "Ranch");
});

Deno.test("finer touches: identical lines merge, 'take one off' lowers the count, the robot line is said once, short parts read as one message", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "garlic knots", [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  assertStringIncludes(o.reply, "Added 1 x Garlic Knots (6). Anything else?"); // one line, not a printout
  o = say(o.form, "add two more garlic knots", [{ kind: "add_line", item_span: "garlic knots", qty: 2, option_spans: [] }]);
  assertEquals(o.form.lines.map((l) => [l.item_id, l.qty]), [[IDS.knots, 3]], o.reply);
  o = say(o.form, "ok thats one too many, take one off", [{ kind: "remove_line", ref: { span: "garlic knots" } }]);
  assertEquals(o.form.lines.map((l) => [l.item_id, l.qty]), [[IDS.knots, 2]], o.reply);
  o = say(o.form, "thats it");
  assertStringIncludes(o.reply, "I'm a robot");
  o = say(o.form, "add a cheesesteak", [{ kind: "add_line", item_span: "cheesesteak", qty: 1, option_spans: [] }]);
  assertStringIncludes(o.reply, "Updated order");
  assert(!o.reply.includes("robot"), o.reply);
});

Deno.test("finer touches: 'do you have X?' is answered and offered; 'did you add X?' is answered from the cart; a taught word gets 'oh, gotcha'", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "yes do you have garlic knots?", [{ kind: "ask_menu", about_span: "garlic knots" }]);
  assertStringIncludes(o.reply, "Yes, we do.");
  assertStringIncludes(o.reply, "Want one?");
  assert(!o.reply.includes("Did you also want"), o.reply);
  assertEquals(o.form.lines.length, 0);
  o = say(o.form, "yes");
  assertEquals(o.form.lines.map((l) => l.item_id), [IDS.knots], o.reply);
  o = say(o.form, "did you add the garlic knots?", [{ kind: "control", what: "unclear" }]); // the model shrugs; the engine knows
  assertStringIncludes(o.reply, "Yes, 1 x Garlic Knots (6) is on your order.");
  assert(!o.reply.includes("Did you also want"), o.reply);
  assertEquals(o.form.lines.length, 1);
  o = say(o.form, "do you have a cheesesteak?", [{ kind: "ask_menu", about_span: "cheesesteak" }]); // an item whose name IS the term: offered, accepted, then asked about
  o = say(o.form, "yes");
  o = say(o.form, "did you add the cheesesteak?", [{ kind: "control", what: "unclear" }]);
  assertStringIncludes(o.reply, "Yes, 1 x Cheesesteak is on your order.");
  assertEquals(o.form.lines.length, 2);
  let p = say(f, "add two zorgblats", [{ kind: "add_line", item_span: "zorgblats", qty: 2, option_spans: [] }]);
  assertStringIncludes(p.reply, "couldn't find");
  p = say(p.form, "oh sorry, that means garlic knots", [{ kind: "remove_line", ref: { span: "zorgblats" } }, { kind: "add_line", item_span: "garlic knots", qty: 2, option_spans: [] }]);
  assertStringIncludes(p.reply, "Oh, gotcha.");
  assert(!p.reply.includes("leave"), p.reply);
  assertEquals(p.form.lines.map((l) => [l.item_id, l.qty]), [[IDS.knots, 2]]);
  assertEquals(p.ledger.filter((e) => e.event === "taught_term").map((e) => (e.data as { span: string; item_id: string }).item_id), [IDS.knots]);
  // the live model shape: a no-op change on the unknown line plus the add, which the engine reads as the answer; and the plain answer shape
  for (const moves of [[{ kind: "change_line", ref: { span: "zorgblats" }, qty: null, add_option_spans: [], remove_option_spans: [] }, { kind: "add_line", item_span: "garlic knots", qty: 2, option_spans: [] }], [{ kind: "answer_option", value_span: "garlic knots" }],
    [{ kind: "change_line", ref: { span: "zorgblats" }, qty: null, add_option_spans: [], remove_option_spans: [] }, { kind: "remove_line", ref: { span: "zorgblats" } }, { kind: "add_line", item_span: "garlic knots", qty: 2, option_spans: [] }],
    [{ kind: "talk", text: "No problem! I got it." }]] as Move[][]) { // and the model that only chats: the mention explains the unknown word
    let q = say(f, "garlic knots and two zorgblats", [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "zorgblats", qty: 2, option_spans: [] }]); // the knots already there: the taught ones merge into them
    q = say(q.form, "oh sorry, that means garlic knots", moves);
    assertStringIncludes(q.reply, "Oh, gotcha.");
    assert(!q.reply.includes("don't see") && !q.reply.includes("leave"), q.reply);
    assertEquals(q.ledger.filter((e) => e.event === "taught_term").map((e) => (e.data as { span: string }).span), ["zorgblats"], q.reply);
    assertEquals(q.form.lines.map((l) => [l.item_id, l.qty]), [[IDS.knots, 3]], q.reply); // "two zorgblats" keeps its two through the explanation, whatever shape the model sent
    assert(!q.reply.includes("No problem"), q.reply);
  }
});

Deno.test("voice: a rewrite must keep every number and name, keep the question, and invent nothing", () => {
  const draft = `Added 2 x Hot Dog. Anything else?`;
  assertEquals(faithfulRewrite(draft, "Two hot dogs added. Anything else?"), null);
  assertEquals(faithfulRewrite(draft, "Two hot dogs added. Anything else for you?"), null);
  assertEquals(faithfulRewrite(draft, "Two hot dogs added."), "lost the question");
  assertEquals(faithfulRewrite(draft, "Two hot dogs and a Large Cheese Pizza added. Anything else?"), "invented large cheese pizza");
  assertEquals(faithfulRewrite(draft, "Two hot dogs added, $11.98. Anything else?"), "invented 11.98");
  assertEquals(faithfulRewrite("Added 1 x Garlic Knots (6). Anything else?", "One order of garlic knots, got it. Anything else?"), "dropped 6"); // the (6) is a fact
  assertEquals(faithfulRewrite("Added 1 x Garlic Knots (6). Anything else?", "Garlic Knots (6), got it. Anything else?"), null);
  assertEquals(faithfulRewrite("Chicken Parmesan Sandwich: what bread? White, Rye, or Wheat?", "What bread for the Chicken Parmesan Sandwich? White, Rye, or Wheat?"), null);
  assertEquals(faithfulRewrite("Chicken Parmesan Sandwich: what bread? White, Rye, or Wheat?", "What bread for the Chicken Parmesan Sandwich? White or Wheat?"), "dropped rye");
  assertEquals(faithfulRewrite("Anything else?", "Anything else? It'll be ready in 15 minutes."), "invented 15");
  assertEquals(faithfulRewrite("Yes, we do. Hot Dog: Served with fries. Want one?", "Yeah we do, the Hot Dog comes with fries. You want one?"), null); // "Served" after the colon is scaffolding
  assertEquals(faithfulRewrite("Updated: 3 x Hot Dog. Anything else?", "Got it, so that's 3 Hot Dogs total now. Anything else?"), null); // a plural of a name is the name
});

Deno.test("phone test 09-26: a change after the pay link sends the updated order and a fresh link together; asking for the link at the read-back is a yes", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "pickup").form;
  let o = say(f, "a cheesesteak", [{ kind: "add_line", item_span: "cheesesteak", qty: 1, option_spans: [] }]);
  o = say(o.form, "thats it");
  o = say(o.form, "resend the payment link"); // closed: a yes at the read-back
  assertEquals(o.form.confirmed, true, o.reply);
  assertEquals(o.form.status, "awaiting_payment");
  o = say(o.form, "wait i need 2 more cheesesteaks", [{ kind: "change_line", ref: { span: "cheesesteaks" }, qty: 3, add_option_spans: [], remove_option_spans: [] }]);
  assertEquals(o.form.lines[0].qty, 3, o.reply);
  assertEquals(o.form.confirmed, true, o.reply); // no second YES
  assertEquals(o.form.status, "awaiting_payment");
  assertStringIncludes(o.reply, "Total is now");
  assertStringIncludes(o.reply, "3 x Cheesesteak");
  assertStringIncludes(o.reply, "Your total changed, so the earlier link won't work anymore.");
  assert(!o.reply.includes("Reply YES"), o.reply);
  assert(o.ledger.some((e) => e.event === "relink_after_change"));
  // a change that needs a question first still asks, then relinks once the order is whole again
  let p = say(o.form, "and a house salad", [{ kind: "add_line", item_span: "house salad", qty: 1, option_spans: [] }]);
  assertStringIncludes(p.reply, "dressing");
  assertEquals(p.form.confirmed, false);
  p = say(p.form, "ranch");
  assertEquals(p.form.confirmed, true, p.reply);
  assertStringIncludes(p.reply, "earlier link won't work");
});

Deno.test("end-of-order edits: a tip change after the link remakes the link; 'swap X for Y' with only an empty change from the model swaps the line", () => {
  let f = newForm("vitos", "test-v1");
  f = say(f, "delivery").form; f = say(f, "123 Main St", [addr("123 Main St")]).form;
  let o = say(f, "garlic knots", [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  o = say(o.form, "thats it"); o = say(o.form, "0"); o = say(o.form, "yes");
  assertEquals(o.form.status, "awaiting_payment");
  o = say(o.form, "actually make the tip 20%", [{ kind: "answer", field: "tip", value: { kind: "percent", value: 20 } }]);
  assert(o.ledger.some((e) => e.event === "relink_after_change"), o.reply);
  assertStringIncludes(o.reply, "earlier link won't work");
  assertEquals(o.form.tip, { kind: "percent", value: 20 });
  let p = say(newForm("vitos", "test-v1"), "pickup").form;
  let q = say(p, "a cheesesteak", [{ kind: "add_line", item_span: "cheesesteak", qty: 1, option_spans: [] }]);
  q = say(q.form, "swap the cheesesteak for garlic knots", [{ kind: "change_line", ref: { span: "cheesesteak" }, qty: null, add_option_spans: [], remove_option_spans: [] }]);
  assertEquals(q.form.lines.map((l) => l.item_id), [IDS.knots], q.reply);
  assert(q.ledger.some((e) => e.event === "swap_line"));
  // the same swap after the link, into an item that needs a question: asked, answered, then relinked
  let r = say(p, "a cheesesteak", [{ kind: "add_line", item_span: "cheesesteak", qty: 1, option_spans: [] }]);
  r = say(r.form, "thats it"); r = say(r.form, "yes");
  r = say(r.form, "swap the cheesesteak for a house salad", [{ kind: "change_line", ref: { span: "cheesesteak" }, qty: null, add_option_spans: [], remove_option_spans: [] }]);
  assertStringIncludes(r.reply, "dressing");
  r = say(r.form, "ranch");
  assertEquals(r.form.lines.map((l) => l.item_id), [IDS.houseSalad], r.reply);
  assertEquals(r.form.status, "awaiting_payment", r.reply);
  assertStringIncludes(r.reply, "earlier link won't work");
});

Deno.test("SMS cost: every reply is plain GSM-7 text (one stray character doubles the segments); a remark after the link gets the remark, not the pay sentence", () => {
  const GSM = new Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€");
  let f = newForm("vitos", "test-v1");
  const replies: string[] = [];
  const go = (msg: string, moves: Move[] = []) => { const o = say(f, msg, moves); f = o.form; replies.push(o.reply); return o; };
  go("delivery"); go("123 Main St", [addr("123 Main St")]);
  go("a cheesesteak and 2 garlic knots", [{ kind: "add_line", item_span: "cheesesteak", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "garlic knots", qty: 2, option_spans: [] }]);
  go("what do i have so far", [{ kind: "control", what: "show_cart" }]);
  go("thats it"); go("15"); go("yes");
  const link = go("add cheese fries", [{ kind: "add_line", item_span: "cheese fries", qty: 1, option_spans: [] }]);
  assertStringIncludes(link.reply, "Total is now"); assert(!link.reply.includes("1)"), link.reply); // the change and the new total, not the whole read-back again
  for (const r of replies) for (const c of r) assert(GSM.has(c), `non-GSM character ${JSON.stringify(c)} in: ${r}`);
});


// ── pass 11 (2026-09-27, 40 conversations): the six approved fixes, each on the shape that failed ──

Deno.test("pass 11 A: three unknown lines and then three real names pair up one each; a fourth name is a new line; nothing is taught", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "3 signature sandwiches. one bacon cheeseburger, one swiss burger, one big boy burger", [
    { kind: "add_line", item_span: "signature sandwiches", qty: 1, option_spans: ["bacon cheeseburger"] },
    { kind: "add_line", item_span: "signature sandwiches", qty: 1, option_spans: ["swiss burger"] },
    { kind: "add_line", item_span: "signature sandwiches", qty: 1, option_spans: ["big boy burger"] },
  ]);
  f = o.form; assertEquals(f.lines.length, 3); assertEquals(f.open?.kind, "line_unresolved");
  o = say(f, "my bad. one bacon cheeseburger, one swiss burger, one big boy burger, and garlic knots", [
    { kind: "add_line", item_span: "bacon cheeseburger", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "swiss burger", qty: 1, option_spans: [] },
    { kind: "add_line", item_span: "big boy burger", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] },
  ]);
  f = o.form;
  assertEquals(f.lines.map((l) => l.item_id), [IDS.baconCheeseburger, "swb", "bbb", IDS.knots], o.reply); // #34 put all four names on line 1 and left lines 2 and 3 unknown
  assert(!o.ledger.some((e) => e.event === "taught_term"), "one word that became three things teaches nothing");
  assert(o.ledger.some((e) => e.event === "taught_term_skipped"));
  // the burgers each want a temp; "medium well" fills the one we asked about, not a fresh line, and the next burger is asked next
  assertEquals(f.open?.kind, "line_slot");
  o = say(f, "medium well"); f = o.form;
  assertEquals(f.lines.length, 4); assertEquals(f.lines[0].choices[IDS.tempGroup], IDS.tempMedWell); assertEquals((f.open as { line_id: number }).line_id, 2);
});

Deno.test("pass 11 A: 'i only want one' sets the count; 'take one off' lowers it", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "pickup"); f = o.form;
  o = say(f, "4 garlic knots", [{ kind: "add_line", item_span: "garlic knots", qty: 4, option_spans: [] }]); f = o.form;
  o = say(f, "wait no. i only want one garlic knots not four", [{ kind: "remove_line", ref: { span: "garlic knots" } }, { kind: "remove_line", ref: { span: "garlic knots" } }, { kind: "remove_line", ref: { span: "garlic knots" } }]); f = o.form;
  assertEquals(f.lines[0].qty, 1, o.reply);
  o = say(f, "make it 3", [{ kind: "change_line", ref: { span: "garlic knots" }, qty: 3 }]); f = o.form;
  o = say(f, "take one off", [{ kind: "remove_line", ref: { span: "garlic knots" } }]); f = o.form;
  assertEquals(f.lines[0].qty, 2, o.reply);
});

Deno.test("pass 11 B: a slot value with no line question changes that slot or restates it; it is never an item search; an unknown line is dropped after the ladder", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "pickup"); f = o.form;
  o = say(f, "a cheeseburger", [{ kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] }]); f = o.form;
  o = say(f, "medium well"); f = o.form; assertEquals(f.lines[0].choices[IDS.tempGroup], IDS.tempMedWell); assertEquals(f.open?.kind, "items");
  o = say(f, "what comes on the cheeseburger", [{ kind: "ask_menu", about_span: "cheeseburger" }]); f = o.form;
  assert(!o.reply.includes("Yes, we do."), o.reply); assert(!o.reply.includes("Well Done"), o.reply); // an item already ordered is not offered its choices again
  o = say(f, "medium well is good. thats all", [{ kind: "answer_option", value_span: "medium well" }, { kind: "answer", field: "items_done", value: true }]); f = o.form;
  assertEquals(f.lines.length, 1, o.reply); assert(!o.reply.includes("couldn't find"), o.reply); assertEquals(f.open?.kind, "confirm"); // #21: "couldn't find medium well" five times, no link
  o = say(f, "actually make it medium", [{ kind: "answer_option", value_span: "medium" }]); f = o.form;
  assertEquals(f.lines.length, 1); assertEquals(f.lines[0].choices[IDS.tempGroup], IDS.tempMedium, o.reply); assertStringIncludes(o.reply, "Updated");
  // the floor: an unknown word asked once, once more with SKIP offered, then left off
  o = say(f, "and a glorb", [{ kind: "add_line", item_span: "glorb", qty: 1, option_spans: [] }]); f = o.form; assertStringIncludes(o.reply, "couldn't find \"glorb\"");
  o = say(f, "the zorp kind", [{ kind: "answer_option", value_span: "zorp kind" }]); f = o.form; assertStringIncludes(o.reply, "Still nothing for \"glorb\"");
  o = say(f, "zorp", [{ kind: "answer_option", value_span: "zorp" }]); f = o.form; assertStringIncludes(o.reply, "SKIP");
  o = say(f, "zorp!!", [{ kind: "answer_option", value_span: "zorp" }]); f = o.form;
  assertStringIncludes(o.reply, "I'll leave \"glorb\" off"); assertEquals(f.lines.length, 1); assertEquals(f.open?.kind, "confirm");
});

Deno.test("pass 11 C: while we ask which pizza, a pizza named outright is the answer, whatever word the first mention used", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "a large pie", [{ kind: "add_line", item_span: "pie", qty: 1, option_spans: ["large"] }]); f = o.form;
  assertEquals(f.open?.kind, "line_ambiguous");
  o = say(f, "the large hawaiian pizza", []); f = o.form; // #32: the model sent nothing and the engine said "not one we have", then "did you also want" later
  assertEquals(f.lines.length, 1); assertEquals(f.lines[0].item_id, "hawL", o.reply); assert(!o.reply.includes("didn't catch"), o.reply);
  assertEquals(f.omissions.filter((x) => !x.declined).length, 0);
});

Deno.test("pass 11 D: a list of flavors keeps every flavor it names; a whole flavor name is that flavor, not the longer one containing it", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "pickup"); f = o.form;
  o = say(f, "10 bone in wings", [{ kind: "add_line", item_span: "bone in wings", qty: 10, option_spans: [] }]); f = o.form;
  assertEquals(f.open?.kind, "line_slot"); assertEquals(f.lines[0].qty, 1);
  o = say(f, "bbq, garlic hot, honey garlic bbq, hot"); f = o.form;
  assertEquals(f.lines[0].slot_candidates["wingFl"]?.length, 4, o.reply); // #39: BBQ and Hot fell out of the shortlist because longer names contain them
  o = say(f, "just give me bbq", [{ kind: "answer_option", value_span: "bbq" }]); f = o.form;
  assertEquals(f.lines[0].choices["wingFl"], "flBBQ", o.reply); assertStringIncludes(o.reply, "(BBQ)");
});

Deno.test("pass 11 E: a directional the geocoder dropped is read back and can be corrected; a matching street is not", () => {
  assert(streetChanged("2222 w union st allentown", "2222 Union St, Allentown, PA 18104, USA"));
  assert(!streetChanged("3300 hamilton blvd", "3300 Hamilton Blvd, Allentown, PA 18104, USA"));
  assert(!streetChanged("5620 Cetronia Rd Allentown pa 18106", "5620 Cetronia Rd, Allentown, PA 18106, USA"));
  assert(streetChanged("221 main st", "212 Main St, Allentown, PA 18104, USA")); // a house number that moved is a different house
  let f = newForm("vitos", "test-v1");
  let o = say(f, "delivery"); f = o.form;
  o = say(f, "2222 w union st", [{ kind: "answer", field: "address", value: { text: "2222 w union st", formatted: "2222 Union St, Allentown, PA 18104, USA", validated: true, zone_ok: true, read_as: true } }]); f = o.form;
  assertStringIncludes(o.reply, "Delivery to 2222 Union St, Allentown, PA 18104."); assertStringIncludes(o.reply, "I read that as 2222 Union St, Allentown, PA 18104. If that's not right, send the address again.");
  o = say(f, "2222 west union st", [{ kind: "answer", field: "address", value: { text: "2222 west union st", formatted: "2222 W Union St, Allentown, PA 18104, USA", validated: true, zone_ok: true } }]); f = o.form;
  assert(!o.reply.includes("I read that as"), o.reply); assertStringIncludes(o.reply, "2222 W Union St");
});

Deno.test("pass 11 F: after the link a thank-you gets 'You're welcome!', a wait question gets the time, a question we cannot answer gets the shop's number, and only asking for the link gets the link", () => {
  let f = newForm("vitos", "test-v1");
  const go = (msg: string, moves: Move[] = []) => { const o = say(f, msg, moves); f = o.form; return o; };
  go("pickup"); go("garlic knots", [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  let o = go("how long does it usually take", []); assertStringIncludes(o.reply, "About 10-15 min after you pay."); assertStringIncludes(o.reply, "Anything else?");
  go("thats it"); o = go("yes"); assert(o.handoff);
  f.checkout_url = "https://pay.example/o/abc"; // the runner sets these once the session exists
  const after = (msg: string, moves: Move[] = []) => turn({ form: f, menu, message: msg, moves: closedAnswer(f, msg, menu) ?? moves, closed: closedAnswer(f, msg, menu) !== null, checkoutUrl: f.checkout_url });
  o = after("sounds good thanks"); assertEquals(o.reply, "You're welcome!"); assert(!o.handoff); f = o.form;
  o = after("cool how long is the wait usually, pretty hungry rn"); assertEquals(o.reply, "About 10-15 min after you pay."); assert(!o.handoff); f = o.form;
  o = after("do you take cash?"); assertStringIncludes(o.reply, "reach the shop"); assert(!o.handoff); f = o.form;
  o = after("sick"); assertEquals(o.reply, "Got it."); f = o.form;
  o = after("send the link again"); assert(o.handoff, o.reply); assertStringIncludes(o.reply, "Pay here: https://pay.example/o/abc"); f = o.form;
  o = after("thanks man appreciate it", [{ kind: "talk", text: "Anytime, enjoy!" }]); assertEquals(o.reply, "Anytime, enjoy!"); assert(!o.handoff);
});

Deno.test("pass 11 #9: 'turkey and garlic knots' sent as one add is two adds; 'remove number 2' takes the second line; a pick number is never a kitchen note", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "pickup"); f = o.form;
  o = say(f, "lemme get a turkey and garlic knots", [{ kind: "add_line", item_span: "turkey and garlic knots", qty: 1, option_spans: [] }]); f = o.form;
  assertEquals(f.lines.map((l) => l.item_id), ["tky", IDS.knots], o.reply); assert(o.ledger.some((e) => e.event === "and_split"));
  o = say(f, "remove number 2", [{ kind: "remove_line", ref: { span: "number 2" } }]); f = o.form;
  assertEquals(f.lines.map((l) => l.item_id), ["tky"], o.reply); assertStringIncludes(o.reply, "Removed Garlic Knots (6).");
  o = say(f, "some fries", [{ kind: "add_line", item_span: "fries", qty: 1, option_spans: [] }]); f = o.form; assertEquals(f.open?.kind, "line_ambiguous");
  o = say(f, "crazy fries number 1", [{ kind: "answer_option", value_span: "crazy fries number 1" }]); f = o.form;
  assertEquals(f.lines[1].item_id, "crz", o.reply); assertEquals(f.lines[1].notes, []); assert(!o.reply.includes("Noted"), o.reply);
});

Deno.test("pass 11 #9: an offer ('want one?') is dropped once the item is on the order by any path; a sized row is never taught as a word's meaning", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "pickup"); f = o.form;
  o = say(f, "a cheeseburger", [{ kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] }]); f = o.form; assertEquals(f.open?.kind, "line_slot");
  o = say(f, "do you have turkey?", [{ kind: "ask_menu", about_span: "turkey" }]); f = o.form; assert(f.omissions.some((x) => x.span === "turkey" && x.offer && !x.declined));
  o = say(f, "medium, and a turkey too", [{ kind: "answer_option", value_span: "medium" }, { kind: "add_line", item_span: "turkey", qty: 1, option_spans: [] }]); f = o.form;
  assert(!o.reply.includes("Want one?"), o.reply); assertEquals(f.lines.filter((l) => l.item_id === "tky").length, 1); assertEquals(f.open?.kind, "items");
  o = say(f, "and a sicilian special", [{ kind: "add_line", item_span: "sicilian special", qty: 1, option_spans: [] }]); f = o.form; assertEquals(f.open?.kind, "line_unresolved");
  o = say(f, "i mean the large pepperoni pizza", [{ kind: "add_line", item_span: "large pepperoni pizza", qty: 1, option_spans: [] }]); f = o.form;
  assertEquals(f.lines[2].item_id, IDS.pepPizzaL, o.reply); assert(!o.ledger.some((e) => e.event === "taught_term"), "a three-size pizza's large row is not what 'sicilian special' means");
});

Deno.test("pass 12: 'oh wait, add knots' is not a question about the wait; 'how long' is", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "pickup"); f = o.form;
  o = say(f, "a cheeseburger", [{ kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] }]); f = o.form;
  o = say(f, "oh wait actually add garlic knots too", [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]); f = o.form;
  assert(!o.reply.includes("min"), o.reply);
  o = say(f, "medium. and how long is the wait usually", [{ kind: "answer_option", value_span: "medium" }]); f = o.form;
  assertStringIncludes(o.reply, "About 10-15 min after you pay.");
});

Deno.test("pass 12 #20: a topping picked from a shortlist applies and the question ends; a numbered pick too", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "pickup"); f = o.form;
  o = say(f, "large cheese pizza with chicken", [{ kind: "add_line", item_span: "large cheese pizza", qty: 1, option_spans: ["chicken"] }]); f = o.form;
  assertEquals(f.open?.kind, "line_slot", o.reply); assertEquals(f.lines[0].slot_candidates[IDS.toppingsL]?.length, 4);
  o = say(f, "grilled chicken on the whole pizza", [{ kind: "answer_option", value_span: "grilled chicken on the whole pizza" }]); f = o.form;
  assertEquals(f.lines[0].status.kind, "complete", o.reply); assertEquals(f.lines[0].modifiers, ["gcW"]); assertEquals(Object.keys(f.lines[0].slot_candidates).length, 0); assertEquals(f.open?.kind, "items"); // pass 12 #20 asked four times and dropped the pizza
  assertEquals(totals(f, menu).subtotal_cents, 1800 + 400);
  f = newForm("vitos", "test-v1"); o = say(f, "pickup"); f = o.form;
  o = say(f, "large cheese pizza with chicken", [{ kind: "add_line", item_span: "large cheese pizza", qty: 1, option_spans: ["chicken"] }]); f = o.form;
  o = say(f, "1"); f = o.form; // the numbered pick against the shortlist
  assertEquals(f.lines[0].status.kind, "complete", o.reply); assertEquals(f.lines[0].modifiers, ["gcW"]); assertEquals(f.open?.kind, "items");
});

Deno.test("pass 12 #6: a declined flavor in a list is not a candidate; an answer that fits the asked line stays with it", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "pickup"); f = o.form;
  o = say(f, "bone in wings and a cheeseburger", [{ kind: "add_line", item_span: "bone in wings", qty: 1, option_spans: [] }, { kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] }]); f = o.form;
  assertEquals((f.open as { line_id: number }).line_id, 1);
  o = say(f, "bbq for the wings, skip the mild", [{ kind: "answer_option", value_span: "bbq for the wings, skip the mild" }]); f = o.form;
  assertEquals(f.lines[0].choices["wingFl"], "flBBQ", o.reply); assertEquals((f.open as { line_id: number }).line_id, 2);
  o = say(f, "medium well dude", [{ kind: "answer_option", value_span: "medium well dude", line_id: 1 }]); f = o.form; // the model pointed at the wings; the temp fits the burger we asked about
  assertEquals(f.lines[1].choices[IDS.tempGroup], IDS.tempMedWell, o.reply); assertEquals(f.open?.kind, "items");
});

Deno.test("pass 12 #18: a kind named outright that the shown list missed is still one of the kinds; the counts split the line", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "pickup"); f = o.form;
  o = say(f, "3 sandwiches", [{ kind: "add_line", item_span: "sandwiches", qty: 3, option_spans: [] }]); f = o.form;
  assertEquals(f.open?.kind, "line_ambiguous", o.reply); // cheesesteak or chicken parm
  o = say(f, "one turkey, one cheesesteak, and one more turkey", [{ kind: "answer_option", value_span: "turkey" }, { kind: "answer_option", value_span: "cheesesteak" }, { kind: "answer_option", value_span: "turkey" }]); f = o.form;
  assertEquals(f.lines.map((l) => [l.item_id, l.qty]), [["tky", 2], [IDS.cheesesteak, 1]], o.reply);
});

Deno.test("pass 12 #15: 'what comes on X' for a pizza already ordered in another size lists no choices and offers nothing", () => {
  let f = newForm("vitos", "test-v1");
  let o = say(f, "pickup"); f = o.form;
  o = say(f, "medium pepperoni pizza", [{ kind: "add_line", item_span: "medium pepperoni pizza", qty: 1, option_spans: [] }]); f = o.form;
  o = say(f, "what comes on the pepperoni pizza btw", [{ kind: "ask_menu", about_span: "pepperoni pizza" }]); f = o.form;
  assert(!o.reply.includes("Want one?"), o.reply); assert(!o.reply.includes("Sizes:"), o.reply); assertEquals(f.omissions.filter((x) => !x.declined).length, 0);
});

Deno.test("pass 12 #10: the geocoder tries the shop's own town first, then the country; the town comes from the shop's address", async () => {
  assertEquals(localityOf("5620 Cetronia Rd, Allentown, PA 18106, USA"), { locality: "Allentown", region: "PA" });
  assertEquals(localityOf(null), { locality: null, region: null });
  const calls: string[] = [];
  const fake = ((url: string) => { calls.push(url); const town = url.includes("locality"); return Promise.resolve(new Response(JSON.stringify(town ? { status: "ZERO_RESULTS", results: [] } : { status: "OK", results: [{ formatted_address: "3300 Hamilton Blvd, Bethlehem, PA 18017, USA", geometry: { location: { lat: 40.57, lng: -75.57 }, location_type: "ROOFTOP" } }] }))); }) as unknown as typeof fetch;
  const geo = googleGeocoder("k", { lat: 40.5713954, lng: -75.571226, radius_mi: 5, locality: "Allentown", region: "PA" }, fake);
  const a = await geo("3300 hamilton blvd");
  assertEquals(calls.length, 2); assertStringIncludes(decodeURIComponent(calls[0]), "locality:Allentown|administrative_area:PA"); assert(!calls[1].includes("locality"));
  assertEquals(a.validated, true); assertStringIncludes(a.formatted ?? "", "Bethlehem");
});

Deno.test("offer once: a cheesesteak asks the cheese, says what it comes with, offers toppings once; 'that's fine' or a topping answers it", () => {
  const steak = steakFixtureMenu();
  const say2 = (form: OrderForm, message: string, moves: Move[] = []) => { const closed = closedAnswer(form, message, steak); return turn({ form, menu: steak, message, moves: closed ?? moves, closed: closed !== null }); };
  for (const [answer, mods] of [["that's fine", 0], ["mushrooms", 1]] as const) {
    let f = newForm("vitos", "steak-v1"); f.fulfillment = "pickup";
    let o = say2(f, "a cheesesteak sandwich", [{ kind: "add_line", item_span: "cheesesteak sandwich", qty: 1, option_spans: [] }]);
    assertStringIncludes(o.reply, "Provolone"); f = o.form;
    o = say2(f, "provolone", [{ kind: "answer_option", value_span: "provolone" }]);
    assertStringIncludes(o.reply, "Sauce, fried onions"); assertStringIncludes(o.reply, "Mushrooms +$1.00"); f = o.form;
    o = say2(f, answer, [{ kind: "answer_option", value_span: answer }]); f = o.form;
    assertEquals(f.lines[0].status.kind, "complete", o.reply);
    assertEquals(f.lines[0].modifiers.length, mods);
    assertEquals(f.lines[0].notes, []);
    assert(!o.reply.includes("Mushrooms +$1.00"), "offered once, not again: " + o.reply);
    assertEquals(totals(f, steak).subtotal_cents, 1199 + mods * 100);
  }
});
