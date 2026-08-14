/**
 * parseJudgeJson() unit tests.
 *
 * Run:
 *   deno test /Users/joestrazza/sprintai-ordering/supabase/functions/_shared/judge-rubric.test.ts
 */

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseJudgeJson } from "./judge-rubric.ts";

Deno.test("parseJudgeJson — clean JSON", () => {
  const input = `{"flags": [{"check": "invented_item", "severity": "critical", "evidence_message_ids": ["msg1"], "explanation": "Bot offered an item not on menu"}]}`;
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  assertEquals(typeof result, "object");
  const obj = result as Record<string, unknown>;
  assertEquals(Array.isArray(obj.flags), true);
  assertEquals((obj.flags as Array<Record<string, unknown>>).length, 1);
});

Deno.test("parseJudgeJson — ```json fence", () => {
  const input = `\`\`\`json
{"flags": [{"check": "invented_item", "severity": "critical", "evidence_message_ids": ["msg1"], "explanation": "Off menu item"}]}
\`\`\``;
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals((obj.flags as Array<Record<string, unknown>>).length, 1);
});

Deno.test("parseJudgeJson — ``` fence (no language)", () => {
  const input = `\`\`\`
{"flags": [{"check": "test", "severity": "major", "evidence_message_ids": [], "explanation": "x"}]}
\`\`\``;
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals((obj.flags as Array<Record<string, unknown>>).length, 1);
});

Deno.test("parseJudgeJson — trailing prose after JSON", () => {
  const input = `{"flags": [{"check": "test", "severity": "minor", "evidence_message_ids": [], "explanation": "x"}]}
Let me know if you need anything else!`;
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals((obj.flags as Array<Record<string, unknown>>).length, 1);
});

Deno.test("parseJudgeJson — leading prose before JSON", () => {
  const input = `Here is the evaluation:
{"flags": [{"check": "test", "severity": "major", "evidence_message_ids": ["a"], "explanation": "bad"}]}`;
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals((obj.flags as Array<Record<string, unknown>>).length, 1);
});

Deno.test("parseJudgeJson — prose on both sides", () => {
  const input = `Analysis complete. Here are the results:
{"flags": [{"check": "test", "severity": "critical", "evidence_message_ids": ["m1","m2"], "explanation": "Severe issue detected"}]}
That's all.`;
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  const flags = obj.flags as Array<Record<string, unknown>>;
  assertEquals(flags.length, 1);
  assertEquals(flags[0].check, "test");
  assertEquals(flags[0].severity, "critical");
});

Deno.test("parseJudgeJson — multiple flags", () => {
  const input = `{"flags": [
    {"check": "off_topic", "severity": "major", "evidence_message_ids": ["m1"], "explanation": "stray topic"},
    {"check": "invented_item", "severity": "critical", "evidence_message_ids": ["m2"], "explanation": "not on menu"}
  ]}`;
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals((obj.flags as Array<Record<string, unknown>>).length, 2);
});

Deno.test("parseJudgeJson — empty flags array", () => {
  const input = `{"flags": []}`;
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals((obj.flags as Array<Record<string, unknown>>).length, 0);
});

Deno.test("parseJudgeJson — trailing comma repair", () => {
  const input = `{"flags": [{"check": "test", "severity": "minor", "evidence_message_ids": [], "explanation": "x",}]}`;
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals((obj.flags as Array<Record<string, unknown>>).length, 1);
});

Deno.test("parseJudgeJson — newlines inside strings", () => {
  const input = `{"flags": [{"check": "test", "severity": "minor", "evidence_message_ids": [], "explanation": "Line 1\\nLine 2"}]}`;
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  const flags = obj.flags as Array<Record<string, unknown>>;
  assertEquals(flags[0].explanation, "Line 1\nLine 2");
});

Deno.test("parseJudgeJson — unicode escapes in strings", () => {
  const input = `{"flags": [{"check": "test", "severity": "minor", "evidence_message_ids": [], "explanation": "Caf\\u00e9 menu"}]}`;
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  const flags = obj.flags as Array<Record<string, unknown>>;
  assertEquals(flags[0].explanation, "Café menu");
});

Deno.test("parseJudgeJson — nested braces in strings", () => {
  const input = `{"flags": [{"check": "test", "severity": "minor", "evidence_message_ids": [], "explanation": "pattern {a:1, b:2} is wrong"}]}`;
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals((obj.flags as Array<Record<string, unknown>>).length, 1);
});

Deno.test("parseJudgeJson — ~not~ JSON at all", () => {
  const input = "The judge could not evaluate this conversation.";
  const result = parseJudgeJson(input);
  assertEquals(result, null);
});

Deno.test("parseJudgeJson — array instead of object", () => {
  const input = `["not an object"]`;
  const result = parseJudgeJson(input);
  assertEquals(result, null);
});

Deno.test("parseJudgeJson — ~~~~ fence variant", () => {
  const input = `~~~~json
{"flags": [{"check": "test", "severity": "minor", "evidence_message_ids": [], "explanation": "ok"}]}
~~~~`;
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals((obj.flags as Array<Record<string, unknown>>).length, 1);
});