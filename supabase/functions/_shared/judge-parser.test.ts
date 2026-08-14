/**
 * Unit tests for parseJudgeJson — verifies it handles all known LLM output
 * edge cases: fenced JSON, trailing prose, and common formatting errors.
 * 
 * Run: deno test --allow-none supabase/functions/_shared/judge-parser.test.ts
 */

import { parseJudgeJson, RETRY_INSTRUCTION, maxSeverityOf } from "./judge-rubric.ts";
import { assertEquals, assertNotEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("parseJudgeJson — clean JSON", () => {
  const input = `{"verdict":"flagged","flags":[{"check":"cold_tone","severity":"minor","evidence_message_ids":["abc123"],"explanation":"Bot was curt"}]}`;
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals(obj.verdict, "flagged");
  assertEquals(Array.isArray(obj.flags), true);
});

Deno.test("parseJudgeJson — json code fence (```json)", () => {
  const input = '```json\n{"verdict":"clean","flags":[]}\n```';
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals(obj.verdict, "clean");
  assertEquals((obj.flags as unknown[]).length, 0);
});

Deno.test("parseJudgeJson — triple backtick fence without lang", () => {
  const input = '```\n{"verdict":"clean","flags":[]}\n```';
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals(obj.verdict, "clean");
});

Deno.test("parseJudgeJson — tilda fence (~~~json)", () => {
  const input = '~~~json\n{"verdict":"clean","flags":[]}\n~~~';
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals(obj.verdict, "clean");
});

Deno.test("parseJudgeJson — trailing prose after JSON", () => {
  const input = '{"verdict":"clean","flags":[]}\n\nLet me know if you need anything else!';
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals(obj.verdict, "clean");
});

Deno.test("parseJudgeJson — leading prose before JSON", () => {
  const input = 'Here is my analysis:\n\n{"verdict":"clean","flags":[]}';
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals(obj.verdict, "clean");
});

Deno.test("parseJudgeJson — prose both sides", () => {
  const input = 'Analysis:\n{"verdict":"clean","flags":[]}\nDone.';
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals(obj.verdict, "clean");
});

Deno.test("parseJudgeJson — nested braces in string values", () => {
  const input = '{"verdict":"flagged","flags":[{"check":"cold_tone","severity":"minor","evidence_message_ids":["m1"],"explanation":"Bot said {hello}"}]}';
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals(obj.verdict, "flagged");
  const flags = obj.flags as Array<Record<string, unknown>>;
  assertEquals(flags[0].explanation, "Bot said {hello}");
});

Deno.test("parseJudgeJson — nested brackets in string values", () => {
  const input = '{"verdict":"flagged","flags":[{"check":"cold_tone","severity":"minor","evidence_message_ids":[],"explanation":"Bot replied [OK]"}]}';
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals(obj.verdict, "flagged");
});

Deno.test("parseJudgeJson — escaped quotes in strings", () => {
  const input = '{"verdict":"flagged","flags":[{"check":"invented_item","severity":"critical","evidence_message_ids":["x"],"explanation":"Bot said \\"try our pizza\\" but it is not on menu"}]}';
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals(obj.verdict, "flagged");
});

Deno.test("parseJudgeJson — trailing comma (common LLM error)", () => {
  // Trailing comma after last array element
  const input = '{"verdict":"clean","flags":[],}';
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals(obj.verdict, "clean");
});

Deno.test("parseJudgeJson — trailing comma in nested array", () => {
  const input = '{"verdict":"flagged","flags":[{"check":"cold_tone","severity":"minor","evidence_message_ids":["abc",],"explanation":"curt"}]}';
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals(obj.verdict, "flagged");
});

Deno.test("parseJudgeJson — unicode escape in string", () => {
  const input = '{"verdict":"clean","flags":[],"note":"caf\\u00e9"}';
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals(obj.note, "café");
});

Deno.test("parseJudgeJson — single quotes for keys (common LLM error)", () => {
  const input = "{'verdict':'clean','flags':[]}";
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals(obj.verdict, "clean");
});

Deno.test("parseJudgeJson — empty flags specific", () => {
  const input = '{"verdict":"flagged","flags":[{"check":"cold_tone","severity":"minor","evidence_message_ids":[],"explanation":"curt"}]}';
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals(obj.verdict, "flagged");
});

Deno.test("parseJudgeJson — completely invalid returns null", () => {
  assertEquals(parseJudgeJson("not json at all"), null);
  assertEquals(parseJudgeJson(""), null);
  assertEquals(parseJudgeJson("123"), null);
});

Deno.test("parseJudgeJson — multiple json objects returns first balanced one", () => {
  // Sometimes LLMs output a summary then the real object
  const input = '{"verdict":"flagged","flags":[{"check":"cold_tone","severity":"minor","evidence_message_ids":["m1"],"explanation":"curt"}]}\n\nFollow-up analysis: {"ignored":"this"}';
  const result = parseJudgeJson(input);
  assertNotEquals(result, null);
  const obj = result as Record<string, unknown>;
  assertEquals(obj.verdict, "flagged");
});

Deno.test("RETRY_INSTRUCTION — non-empty and contains JSON directive", () => {
  assert(RETRY_INSTRUCTION.length > 20);
  assert(RETRY_INSTRUCTION.includes("JSON"));
});

Deno.test("maxSeverityOf — null for empty", () => {
  assertEquals(maxSeverityOf([]), null);
});

Deno.test("maxSeverityOf — returns highest", () => {
  assertEquals(
    maxSeverityOf([
      { severity: "minor" },
      { severity: "critical" },
      { severity: "major" },
    ]),
    "critical",
  );
});