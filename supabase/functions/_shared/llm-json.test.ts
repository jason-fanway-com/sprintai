import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseLlmJson, indexOfBalancedClose } from "./llm-json.ts";

function captureConsoleError(): { calls: string[]; restore: () => void } {
  const original = console.error;
  const calls: string[] = [];
  console.error = (...args: unknown[]) => { calls.push(args.map(String).join(" ")); };
  return { calls, restore: () => { console.error = original; } };
}

Deno.test("parseLlmJson: strips a ```json fence (the OpenRouter/Anthropic bug)", () => {
  const raw = '```json\n{"items":[{"name":"Margherita Pizza","price_cents":1499}]}\n```';
  const result = parseLlmJson<{ items: Array<{ name: string; price_cents: number }> }>(raw);
  assertEquals(result?.items.length, 1);
  assertEquals(result?.items[0].name, "Margherita Pizza");
});

Deno.test("parseLlmJson: parses bare JSON with no fence", () => {
  const raw = '{"items":[{"name":"Pepperoni Pizza","price_cents":1699}]}';
  const result = parseLlmJson<{ items: unknown[] }>(raw);
  assertEquals(result?.items.length, 1);
});

Deno.test("parseLlmJson: recovers JSON preceded by prose", () => {
  const raw = 'Sure, here is the extracted menu:\n{"items":[{"name":"Garlic Knots","price_cents":599}]}';
  const result = parseLlmJson<{ items: unknown[] }>(raw);
  assertEquals(result?.items.length, 1);
});

Deno.test("parseLlmJson: truncated/unterminated JSON returns null and logs", () => {
  const raw = '```json\n{"items":[{"name":"Chicken Parm","price_cents":1899},{"name":"Meatball Sub"';
  const cap = captureConsoleError();
  const result = parseLlmJson(raw);
  cap.restore();
  assertEquals(result, null);
  assertEquals(cap.calls.length > 0, true);
  assertStringIncludes(cap.calls.join(" "), "Chicken Parm");
});

Deno.test("parseLlmJson: empty string returns null and logs", () => {
  const cap = captureConsoleError();
  const result = parseLlmJson("");
  cap.restore();
  assertEquals(result, null);
  assertEquals(cap.calls.length > 0, true);
});

// Regression tests for behavior that, before consolidating the three
// LLM-JSON parsers onto one shared implementation, existed ONLY in
// judge-rubric.ts's parseJudgeJson and NOT here — proving this file's
// parseLlmJson now shares the fix rather than needing its own copy of it.

Deno.test("parseLlmJson: finds the true balanced close even when trailing prose contains a stray brace", () => {
  // The old implementation picked the JSON end via unfenced.lastIndexOf("}")
  // over the *entire* string, so a `}` appearing later in trailing prose
  // (not just inside the JSON) would win and produce an unparseable slice,
  // silently returning null. The shared balanced-bracket scan (originally
  // only in parseJudgeJson) tracks depth and stops at the JSON's true close.
  const raw = '{"items":[{"name":"Curly Fries","price_cents":399}]}\n\nNote: see config.json for schema (uses `{}` syntax)';
  const result = parseLlmJson<{ items: Array<{ name: string; price_cents: number }> }>(raw);
  assertEquals(result?.items.length, 1);
  assertEquals(result?.items[0].name, "Curly Fries");
});

Deno.test("parseLlmJson: repairs a trailing comma (previously only parseJudgeJson handled this)", () => {
  const raw = '{"items":[{"name":"Curly Fries","price_cents":399}],}';
  const result = parseLlmJson<{ items: Array<{ name: string; price_cents: number }> }>(raw);
  assertEquals(result?.items.length, 1);
});

// Regression test for parse-menu-pdf's schema-aware truncation recovery,
// which used to hand-roll its own brace-depth counter (findLastObj) with no
// awareness of string literals. A menu item whose description text contains
// an unbalanced "}" character (plausible free-text menu copy) made the old
// counter close the "object" early, mid-string — producing invalid JSON that
// failed to parse and silently discarded an otherwise-complete, valid item.
// Now that recovery is built on the same shared, string-aware
// `indexOfBalancedClose` used by parseJudgeJson, it correctly skips over
// string contents and finds the item's true closing brace.
Deno.test("indexOfBalancedClose: skips an unbalanced brace inside a string literal", () => {
  const raw = '{"items": [{"name":"Wrap","description":"comes with a } topper"},{"name":"Tru';
  const arrayStart = raw.indexOf("[") + 1;
  const closeIdx = indexOfBalancedClose(raw, arrayStart, "{", "}");
  const recovered = JSON.parse(raw.slice(0, closeIdx + 1) + '], "modifiers": []}');
  assertEquals(recovered.items.length, 1);
  assertEquals(recovered.items[0].name, "Wrap");
});
