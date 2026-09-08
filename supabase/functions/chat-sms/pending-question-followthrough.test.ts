import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { findUnaddressedPendingLine, isRepeatedQuestion } from "./pending-question-followthrough.ts";

Deno.test("findUnaddressedPendingLine: pending line untouched this turn is returned", () => {
  const cart = [
    { menu_item_id: "cheese", name: "Neapolitan Cheese Pizza", pending_options: [] },
    { menu_item_id: "hawaiian", name: "Hawaiian Pizza", pending_options: ["Size"] },
    { menu_item_id: "meatlovers", name: "Meat Lover's Pizza", pending_options: ["Size"] },
  ];
  const rendered = new Map<string, Set<string>>();
  const result = findUnaddressedPendingLine(cart, rendered);
  assertEquals(result, { menuItemId: "hawaiian", itemName: "Hawaiian Pizza", groupName: "Size" });
});

Deno.test("findUnaddressedPendingLine: a group rendered THIS turn is not flagged", () => {
  const cart = [{ menu_item_id: "hawaiian", name: "Hawaiian Pizza", pending_options: ["Size"] }];
  const rendered = new Map<string, Set<string>>([["hawaiian", new Set(["Size"])]]);
  assertEquals(findUnaddressedPendingLine(cart, rendered), null);
});

Deno.test("findUnaddressedPendingLine: no pending options anywhere -> null", () => {
  const cart = [{ menu_item_id: "cheese", name: "Cheese Pizza", pending_options: [] }];
  assertEquals(findUnaddressedPendingLine(cart, new Map()), null);
});

Deno.test("findUnaddressedPendingLine: non-compiled cart lines (no menu_item_id) are skipped, never crash", () => {
  const cart = [{ name: "Bundle Item" }];
  assertEquals(findUnaddressedPendingLine(cart, new Map()), null);
});

Deno.test("findUnaddressedPendingLine: returns the FIRST unaddressed line in cart order", () => {
  const cart = [
    { menu_item_id: "a", name: "A", pending_options: ["Size"] },
    { menu_item_id: "b", name: "B", pending_options: ["Size"] },
  ];
  const result = findUnaddressedPendingLine(cart, new Map());
  assertEquals(result?.menuItemId, "a");
});

Deno.test("isRepeatedQuestion: identical question in both of the last two assistant turns -> true", () => {
  const q = "What size Hawaiian Pizza? Large 18'' +$5.00, Medium 16'' +$3.00, or Small 14'' (no extra charge).";
  const history = [
    { role: "user" as const, content: "no, I said 4 pizzas" },
    { role: "assistant" as const, content: `Got it — ${q}` },
    { role: "user" as const, content: "oh brother..." },
    { role: "assistant" as const, content: `Got it — ${q}` },
  ];
  assertEquals(isRepeatedQuestion(q, history), true);
});

Deno.test("isRepeatedQuestion: only asked once -> false (not a repeat yet)", () => {
  const q = "What size Hawaiian Pizza?";
  const history = [
    { role: "assistant" as const, content: "Which pizzas?" },
    { role: "user" as const, content: "hawaiian" },
    { role: "assistant" as const, content: q },
  ];
  assertEquals(isRepeatedQuestion(q, history), false);
});

Deno.test("isRepeatedQuestion: different wording each time -> false", () => {
  const history = [
    { role: "assistant" as const, content: "Got it — What size Hawaiian Pizza? Large or Small?" },
    { role: "assistant" as const, content: "What size would you like on the Hawaiian?" },
  ];
  assertEquals(isRepeatedQuestion("What size Hawaiian Pizza? Large or Small?", history), false);
});

Deno.test("isRepeatedQuestion: fewer than two prior assistant turns -> false", () => {
  const history = [{ role: "assistant" as const, content: "the question" }];
  assertEquals(isRepeatedQuestion("the question", history), false);
});
