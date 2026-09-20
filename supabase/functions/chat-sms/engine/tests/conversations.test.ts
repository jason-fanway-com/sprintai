// conversations.test.ts — scripted conversations through the pure turn().
// Moves are hand-written (what a correct interpreter returns); no model here.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fixtureMenu, IDS, RAW_ITEMS, RAW_LEXICON, SHOP } from "./fixture-menu.ts";
import { buildMenu } from "../menu.ts";
const await_import = () => ({ buildMenu });
import { newForm, type Move, type OrderForm } from "../form.ts";
import { turn } from "../turn.ts";
import { closedAnswer } from "../vocab.ts";
import { totals } from "../price.ts";
import { words } from "../normalize.ts";

const menu = fixtureMenu();
const addr = (text: string) => ({ kind: "answer", field: "address", value: { text, formatted: text, validated: true, zone_ok: true } } as Move);

/** Drive one turn: closed vocabulary first, else the supplied "model" moves. */
function say(form: OrderForm, message: string, modelMoves: Move[] = []) {
  const closed = closedAnswer(form, message, menu);
  const out = turn({ form, menu, message, moves: closed ?? modelMoves });
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
  assertStringIncludes(o.reply, "2 × Large Pepperoni Pizza");
  assertStringIncludes(o.reply, "$42.00");
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
  assertStringIncludes(o.reply, "Updated: 2 × Garlic Knots (6)  $11.98");
  assertStringIncludes(o.reply, "Small Cheese Pizza");
  assertStringIncludes(o.reply, "$10.99");
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
  assertStringIncludes(o.reply, "Which pizza? Cheese, Margherita, or Pepperoni?");
  o = say(o.form, "pepperoni");
  assertStringIncludes(o.reply, "What size");
  assertStringIncludes(o.reply, "Small, Medium, or Large");
  o = say(o.form, "large");
  assertEquals(o.form.lines[0].item_id, IDS.pepPizzaL);
  assertStringIncludes(o.reply, "Added 1 × Large Pepperoni Pizza");
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
  assert(o.ledger.some((e) => e.event === "add_reclassified_as_answer"));
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
  assertStringIncludes(o.reply, "Which pepperoni? Pepperoni Pizza or Pepperoni (Stromboli Rolls)?");
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
  assertStringIncludes(o.reply, "Which pepperoni?");
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
  assertStringIncludes(o.reply, "Added 1 × Pepperoni  $9.99");
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
  assertStringIncludes(o.reply, "Plain, Everything, Sesame");
  o = say(o.form, "6 plain and 4 everything", [{ kind: "answer_option", value_span: "6 plain and 4 everything" }]);
  assertEquals(o.form.open?.kind, "line_picks");
  assertStringIncludes(o.reply, "10 of 12 picked. Which 2 more?");
  o = say(o.form, "sesame", [{ kind: "answer_option", value_span: "sesame" }]);
  assertEquals(o.form.lines[0].status.kind, "complete");
  assertEquals(o.form.lines[0].selections, { "bg-plain": 6, "bg-every": 4, "bg-sesame": 2 });
  assertStringIncludes(o.reply, "1 × One Dozen Bagels (6 Plain Bagel, 4 Everything Bagel, 2 Sesame Bagel)  $15.00");
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
