import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseLlmJson } from "./llm-json.ts";

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
