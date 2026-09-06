// FIX (2026-09-06, Jason): the system prompt already tells the model never
// to use em dashes (index.ts line ~694: "Never use em dashes in
// responses"), but several of the codebase's OWN hardcoded guard replies use
// them too (e.g. the D1 checkout-success reply, the menu-link reply added
// today) — a prompt instruction only binds the model, not our own code, and
// isn't a guarantee even for the model. This adds a deterministic backstop
// applied at the two places every outbound customer-facing message actually
// funnels through: sendSms() (real SMS delivery via Telnyx/Twilio) and
// jsonResponse() (the JSON `reply` field used by the web/test-mode chat).
// twimlResponse() was checked and has zero call sites — it is dead code, not
// a live delivery path, so it needs no fix.
//
// This is a pure function, copied here verbatim from index.ts (which has no
// exports — it is a Deno.serve entrypoint), matching the convention already
// used by the other test files in this directory. Wiring into the two real
// choke points is checked separately via source-text assertions.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

// FIX (2026-09-06, QA-found by Melvin): the blanket `\s{2,}` collapse this
// used to end with ran on the WHOLE message, not just around the dash it
// replaced — `\s` matches newlines too, so it silently flattened the
// itemized recap's column padding AND merged its "\n\n" paragraph break
// into a single space, running the name-ask and the receipt together on one
// line. The primary replacement already normalizes spacing directly around
// the dash, so the extra collapse was redundant for its job and only
// destructive everywhere else. Removed.
function stripEmDashes(text: string): string {
  return text
    .replace(/\s*—\s*/g, " - ")
    .trim();
}

Deno.test("stripEmDashes: mid-sentence em dash with spaces becomes a spaced hyphen", () => {
  assertEquals(stripEmDashes("Almost — I still need to know: Dressing."), "Almost - I still need to know: Dressing.");
});

Deno.test("stripEmDashes: em dash with no surrounding spaces is still caught", () => {
  assertEquals(stripEmDashes("Here's the link—take a look."), "Here's the link - take a look.");
});

Deno.test("stripEmDashes: multiple em dashes in one reply are all replaced", () => {
  assertEquals(
    stripEmDashes("All set! Here's what I'm sending: 1x Gyro — Payment link — tap to finish: https://x"),
    "All set! Here's what I'm sending: 1x Gyro - Payment link - tap to finish: https://x",
  );
});

Deno.test("stripEmDashes: a reply with no em dash is returned unchanged (aside from trim)", () => {
  assertEquals(stripEmDashes("Got it! What's your name for the order?"), "Got it! What's your name for the order?");
});

Deno.test("stripEmDashes: never leaves double spaces behind, around the dash it actually touched", () => {
  const out = stripEmDashes("Fries — fresh, hot, ready");
  assert(!out.includes("  "), `must not contain a double space: "${out}"`);
});

// QA (Melvin, 2026-09-06): the removed blanket `\s{2,}` collapse ran on the
// WHOLE message and silently destroyed the itemized recap's column padding
// AND its "\n\n" paragraph break, merging the name-ask and the receipt onto
// one line — this is why the recap (2274cbf) shipped looking broken even
// though renderItemizedRecap itself was correct.
Deno.test("QA regression: a receipt's column padding survives untouched when there's no em dash nearby", () => {
  const receipt = "Large Cheese Pizza (16\")            $21.00\nGarlic Knots                         $5.99";
  assertEquals(stripEmDashes(receipt), receipt);
});

Deno.test("QA regression: the blank line between a reply and an appended receipt is preserved, not collapsed", () => {
  const withReceipt = "Got it! What's your name for the order?\n\nLarge Cheese Pizza (16\")            $21.00\nSubtotal                            $21.00";
  const out = stripEmDashes(withReceipt);
  assert(out.includes("\n\n"), `the paragraph break must survive, got: ${JSON.stringify(out)}`);
  assert(out.startsWith("Got it! What's your name for the order?\n\n"), `must not merge the name-ask onto the receipt's line, got: ${JSON.stringify(out)}`);
});

// ── Wiring regression guards against the live file ─────────────────────────

Deno.test("wiring: sendSms cleans the message before dispatching to either provider", () => {
  const start = INDEX_SOURCE.indexOf("async function sendSms(");
  assert(start !== -1, "sendSms must exist");
  const end = INDEX_SOURCE.indexOf("\n}", start);
  const block = INDEX_SOURCE.slice(start, end);
  assert(block.includes("stripEmDashes(message)"), "sendSms must run stripEmDashes on the outgoing message");
  assert(
    /sendSmsViaTelnyx\([^)]*cleaned\)/.test(block) && /sendSmsViaTwilio\([^)]*cleaned\)/.test(block),
    "both provider dispatches must send the CLEANED message, not the raw one",
  );
});

Deno.test("wiring: jsonResponse cleans data.reply before serializing", () => {
  const start = INDEX_SOURCE.indexOf("function jsonResponse(");
  assert(start !== -1, "jsonResponse must exist");
  const end = INDEX_SOURCE.indexOf("\n}", start);
  const block = INDEX_SOURCE.slice(start, end);
  assert(block.includes("stripEmDashes"), "jsonResponse must run stripEmDashes on data.reply when present");
});

Deno.test("wiring: twimlResponse is confirmed dead code (zero call sites) — not a live delivery path needing a fix", () => {
  const occurrences = INDEX_SOURCE.split("twimlResponse(").length - 1;
  assertEquals(occurrences, 1, "twimlResponse should only appear once (its own definition); if this fails, it's now a live call site and needs the same backstop");
});

Deno.test("sanity: the system prompt still explicitly bans em dashes for the model too (belt and suspenders)", () => {
  assert(INDEX_SOURCE.includes("Never use em dashes in responses"), "the prompt-level instruction must still exist alongside the code-level backstop");
});
