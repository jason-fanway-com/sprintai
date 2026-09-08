import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildCompiledMatchText } from "./stated-attribute-carryforward.ts";

Deno.test("buildCompiledMatchText — prepends the immediately preceding customer turn", () => {
  const history = [
    { role: "assistant" as const, content: "Awesome — which pizzas are you thinking?" },
    { role: "user" as const, content: "I want 4 large pizzas" },
  ];
  const result = buildCompiledMatchText("1 pepp, 1 plain, 1 hawaiin, 1 meat lovers", history);
  assertEquals(result, "I want 4 large pizzas 1 pepp, 1 plain, 1 hawaiin, 1 meat lovers");
});

Deno.test("buildCompiledMatchText — skips assistant turns to find the last customer turn", () => {
  const history = [
    { role: "user" as const, content: "I want 4 large pizzas" },
    { role: "assistant" as const, content: "Which pizzas?" },
  ];
  const result = buildCompiledMatchText("1 pepp, 1 plain", history);
  assertEquals(result, "I want 4 large pizzas 1 pepp, 1 plain");
});

Deno.test("buildCompiledMatchText — bounded to exactly one turn back, not the whole history", () => {
  const history = [
    { role: "user" as const, content: "I want 4 large pizzas" },
    { role: "assistant" as const, content: "Which pizzas?" },
    { role: "user" as const, content: "1 plain" },
    { role: "assistant" as const, content: "Anything else?" },
  ];
  const result = buildCompiledMatchText("1 hawaiin", history);
  // Only "1 plain" (the immediately preceding customer turn) is carried —
  // "large", stated two customer turns back, must NOT resurface here.
  assertEquals(result, "1 plain 1 hawaiin");
});

Deno.test("buildCompiledMatchText — no prior customer turn returns the current message unchanged", () => {
  const result = buildCompiledMatchText("1 plain", []);
  assertEquals(result, "1 plain");
});

Deno.test("buildCompiledMatchText — empty/whitespace-only prior turn is not prepended", () => {
  const history = [{ role: "user" as const, content: "   " }];
  const result = buildCompiledMatchText("1 plain", history);
  assertEquals(result, "1 plain");
});

Deno.test("buildCompiledMatchText — non-string prior content (tool content blocks) is skipped", () => {
  const history = [
    { role: "user" as const, content: "I want 4 large pizzas" },
    { role: "user" as const, content: [{ type: "tool_result" }] as unknown },
  ];
  const result = buildCompiledMatchText("1 plain", history);
  assertEquals(result, "I want 4 large pizzas 1 plain");
});
