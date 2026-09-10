// P0 (2026-09-10, NJB live money defect — vigil 16a98794, last blocker before
// NJB's return to the new prompt engine).
//
// Live repro (category-coverage-extras-add-ins, shop b0000000-0000-0000-0000-
// 000000000001, "Extras & Add-Ins - Onions, Tomatoes, Peppers, Mushrooms, or
// Spinach", real price $0.75): the bot's reply quoted a $1.98 total (subtotal
// "Subtotal: $0.99" + $0.99 fee) while the real cart_json for that same turn
// totaled $1.74 (subtotal $0.75 + $0.99 fee).
//
// Root cause: stripLlmMoneyLines() is supposed to scrub any total/subtotal/fee
// figure the model states itself — renderItemizedRecap()'s own header is
// explicit that "the model never states these figures itself", and the
// deterministic Ledger footer (appended AFTER stripLlmMoneyLines runs, at
// every call site in index.ts) is the only path allowed to. But its regexes
// match plain text, and a model that fabricates its own markdown-formatted
// ledger line ("**Subtotal:** $0.99") has "**" sitting between the label and
// the amount — the old `\b[Ss]ubtotal[\s:]*\$...` pattern requires the label
// to be followed only by whitespace/colons before the amount, so the markup
// broke the match and the line survived untouched. stripMarkdown() (which
// removes the ** markers) only runs much later, on the final assembled reply,
// after the real footer has already been appended — so it turned the
// survived line into a bogus "Subtotal: $0.99" sitting BEFORE, and visually
// identical to, the real footer's own "Subtotal: $0.75" a few lines down.
// Anything downstream that reads the FIRST "Subtotal"/"Total" mention in the
// reply (the test suite's verifyStatedTotal, or a customer skimming the text)
// reads the wrong number.
//
// Fix: stripLlmMoneyLines() now demarks (stripMarkdown()) its input before
// running any regex, and also strips the label-then-amount "Total: $X.XX" /
// "Service fee: $X.XX" forms (mirroring the amount-then-label forms it
// already stripped) — a model-fabricated ledger line in ANY of these formats
// is exactly the class this function exists to remove, since the real
// numbers only ever come from the footer appended after it returns.

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { stripLlmMoneyLines } from "./index.ts";

Deno.test("RED->GREEN: markdown-wrapped model-fabricated ledger line no longer survives stripLlmMoneyLines", () => {
  // Exact repro shape: the model states its own (wrong) ledger in bold
  // markdown before the real footer would be appended by the caller.
  const modelReply =
    "Added the veggies add-in - which vegetable were you thinking?\n\n" +
    "**Subtotal:** $0.99\n**Service fee:** $0.99\n**Total:** $1.98";
  const stripped = stripLlmMoneyLines(modelReply);
  assertEquals(/subtotal/i.test(stripped), false, `expected no lingering subtotal mention, got: ${JSON.stringify(stripped)}`);
  assertEquals(/\$0\.99/.test(stripped), false, `expected no lingering $0.99 mention, got: ${JSON.stringify(stripped)}`);
  assertEquals(/\$1\.98/.test(stripped), false, `expected no lingering $1.98 mention, got: ${JSON.stringify(stripped)}`);
  assertStringIncludes(stripped, "which vegetable were you thinking");
});

Deno.test("plain (non-markdown) model-fabricated ledger line still stripped (no regression)", () => {
  const modelReply =
    "Sure thing!\n\nSubtotal: $0.99\nService fee: $0.99\nTotal: $1.98";
  const stripped = stripLlmMoneyLines(modelReply);
  assertEquals(/subtotal/i.test(stripped), false, `expected no lingering subtotal mention, got: ${JSON.stringify(stripped)}`);
  assertEquals(/\$0\.99|\$1\.98/.test(stripped), false, `expected no lingering dollar figures, got: ${JSON.stringify(stripped)}`);
});

Deno.test("label-then-amount 'Total: $X.XX' from the model is stripped (new pattern, mirrors the existing amount-then-label form)", () => {
  const modelReply = "Sounds good!\n\nTotal: $1.98\n\nAnything else?";
  const stripped = stripLlmMoneyLines(modelReply);
  assertEquals(/Total[\s:]*\$1\.98/i.test(stripped), false, `expected fabricated Total line gone, got: ${JSON.stringify(stripped)}`);
  assertStringIncludes(stripped, "Anything else");
});

Deno.test("a normal reply with no money mentions is untouched", () => {
  const modelReply = "Got it! What's your name for the order?";
  assertEquals(stripLlmMoneyLines(modelReply), modelReply);
});
