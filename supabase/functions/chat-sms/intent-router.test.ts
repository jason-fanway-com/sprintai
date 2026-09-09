// Item 2 (2026-09-09, module extraction): unit tests for intent-router.ts.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  detectBareTipReply,
  isAdditiveClearCartMessage,
  isExplicitCartRestart,
  parseBareTipDollars,
} from "./intent-router.ts";

Deno.test("detectBareTipReply: a bare dollar amount after a tip offer is a bare-tip reply", () => {
  const history = [{ role: "assistant" as const, content: "Would you like to add a driver tip? $1, $2, $3, or $5?" }];
  assertEquals(detectBareTipReply(history, "$3"), true);
});

Deno.test("detectBareTipReply: a decline phrase after a tip offer is a bare-tip reply", () => {
  const history = [{ role: "assistant" as const, content: "Want to add a tip? $1, $2, $3, or $5?" }];
  assertEquals(detectBareTipReply(history, "no thanks"), true);
});

Deno.test("detectBareTipReply: the same message with no prior tip offer is not a bare-tip reply", () => {
  const history = [{ role: "assistant" as const, content: "What would you like to order?" }];
  assertEquals(detectBareTipReply(history, "$3"), false);
});

Deno.test("detectBareTipReply: a real item order after a tip offer is not a bare-tip reply", () => {
  const history = [{ role: "assistant" as const, content: "Would you like to add a driver tip? $1, $2, $3, or $5?" }];
  assertEquals(detectBareTipReply(history, "actually can I get another pizza"), false);
});

Deno.test("parseBareTipDollars: parses the whole-dollar amount", () => {
  assertEquals(parseBareTipDollars("$5"), 5);
  assertEquals(parseBareTipDollars("3"), 3);
});

Deno.test("parseBareTipDollars: no digits returns 0", () => {
  assertEquals(parseBareTipDollars("no tip"), 0);
});

Deno.test("isExplicitCartRestart: 'start over' is an explicit restart", () => {
  assertEquals(isExplicitCartRestart("start over"), true);
});

Deno.test("isExplicitCartRestart: embedded restart phrase is caught (not just anchored)", () => {
  assertEquals(isExplicitCartRestart("actually, cancel my order"), true);
});

Deno.test("isExplicitCartRestart: an additive message is not an explicit restart", () => {
  assertEquals(isExplicitCartRestart("and also a coke"), false);
});

Deno.test("isAdditiveClearCartMessage: 'and also' is additive", () => {
  assertEquals(isAdditiveClearCartMessage("and also a coke"), true);
});

Deno.test("isAdditiveClearCartMessage: an explicit restart phrase is not additive", () => {
  assertEquals(isAdditiveClearCartMessage("start over"), false);
});
