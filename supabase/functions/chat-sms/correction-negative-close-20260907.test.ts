// Live P0 bug (2026-09-07, vigil ae7f3351, parent 601eb395), reproduced 2/2
// against the deployed bot (scripts/test-suite/runner.ts-shaped web JSON
// calls to the real chat-sms function, no mocking):
//
//   1 item in cart, customer: "forget it" (meaning "no thanks, that's all")
//     -> bot: "Done - cart's cleared." Cart: 1 item -> 0.
//
//   2 items in cart, customer: "nah forget it" (same meaning)
//     -> bot: "Cart's cleared! Want to start fresh, or are we done?"
//     Cart: 2 items -> 0.
//
// Unreachable until 2026-09-06's disambiguation-dead-end fix (commit
// 4ef99ac) started letting more messages fall through to the LLM/tool loop
// instead of dead-ending on a re-ask.
//
// ROOT CAUSE (two parts, not one):
//
// Part A: bare "forget it" was never covered by ANY deterministic bucket.
// "forget that" / "never mind" were already caught by bucket 3 (ambiguous —
// ask, don't guess; see correction-buckets-20260906.test.ts) because ending
// an order ("I'm done") and declining a just-proposed item ("don't add
// that") are both real readings and neither is safe to guess between. That
// same bucket omitted "forget it" — a bare pronoun swap on the identical
// idiom — so it fell straight to the LLM, which guessed inconsistently:
// sometimes it asked (correct), sometimes it called whatever clears the
// cart and reported "Done - cart's cleared" as though that were obviously
// what the customer wanted.
//
// Part B (the reason a WHOLE cart was wiped, not just "the last item" as
// the ticket assumed going in): Proof Guard P2 exists specifically to
// restore a cart the model wiped to zero without a real cancel signal — but
// its own isCancelSignal regex listed "forget (?:it|the whole|everything)"
// and "never.?mind" as unambiguous cancel authorization. The same words
// bucket 3 calls genuinely ambiguous, Guard P2 called good enough to skip
// restoring. So even on the turns where the model guessed wrong and wiped
// the cart, the one guard built to catch exactly that was disabled by the
// very phrase that caused it.
//
// FIX:
//   1. index.ts bucket 3 (isAmbiguousBareDecline): now also matches bare
//      "forget it", intercepted before the LLM ever runs — same "ask, don't
//      guess" treatment as "forget that"/"never mind".
//   2. index.ts Guard P2 (isCancelSignal): no longer treats bare "forget
//      it" or any "never mind" occurrence as unambiguous cancel
//      authorization — only cancel/reset/start over, and scope-qualified
//      "forget the whole (thing)"/"forget everything" remain unambiguous.
//      This is the backstop for compound phrasing ("nah forget it, that's
//      all") that doesn't match bucket 3's bare-phrase anchor and still
//      reaches the model.
//
// These regexes are copied verbatim from index.ts (same convention as
// correction-buckets-20260906.test.ts — the correction handler and Guard P2
// live inline in an async request handler, not an importable module). If
// index.ts changes either regex, update both here.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

function norm(userMessage: string): string {
  return userMessage.trim().toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Bucket 3, current (post-fix) — index.ts's isAmbiguousBareDecline test.
const IS_AMBIGUOUS_BARE_DECLINE = (norm: string) =>
  /^(never ?mind|forget (?:it|that))$/i.test(norm);

// Guard P2, current (post-fix) — index.ts's isCancelSignal test (run against
// the raw lowercased message, not the punctuation-stripped `norm`, matching
// index.ts's own `userMessage.toLowerCase()` call site).
const IS_CANCEL_SIGNAL = (msgLower: string) =>
  /cancel|reset|start.?over|forget (?:the whole|everything)/i.test(msgLower);

// Guard P2, OLD (pre-fix) — reproduced verbatim to prove the RED case: it
// treated the exact ambiguous words bucket 3 flags as safe cancel-authority.
const OLD_IS_CANCEL_SIGNAL = (msgLower: string) =>
  /cancel|reset|never.?mind|start.?over|forget (?:it|the whole|everything)/i.test(msgLower);

Deno.test("RED-equivalent: the OLD Guard P2 regex treated bare 'forget it' as an unambiguous cancel signal", () => {
  assertEquals(OLD_IS_CANCEL_SIGNAL("forget it"), true); // -> P2 would NOT restore a wipe
});

Deno.test("RED-equivalent: the OLD Guard P2 regex treated 'nah forget it' as an unambiguous cancel signal", () => {
  assertEquals(OLD_IS_CANCEL_SIGNAL("nah forget it"), true);
});

// ── GREEN: bare "forget it" now asked deterministically, never guessed ─────
Deno.test("GREEN: bare 'forget it' is now bucket 3 (ambiguous) same as 'forget that'/'never mind'", () => {
  const n = norm("forget it");
  assertEquals(IS_AMBIGUOUS_BARE_DECLINE(n), true);
});

// ── GREEN: Guard P2 no longer accepts the ambiguous words as cancel authority ─
const AMBIGUOUS_NOT_CANCEL = [
  "forget it",
  "nah forget it",
  "forget it, that's all",
  "eh forget it",
  "never mind",
  "well never mind then",
  "never mind, that's all",
];

for (const phrase of AMBIGUOUS_NOT_CANCEL) {
  Deno.test(`GREEN Guard P2: "${phrase}" is no longer treated as cancel authorization (restore-safety-net stays armed)`, () => {
    assertEquals(IS_CANCEL_SIGNAL(phrase.toLowerCase()), false);
  });
}

// ── Regression: genuine, unambiguous cancel language must still bypass P2's
// restore (a real cancel should not fight the customer to keep items) ──────
const GENUINE_CANCEL = [
  "cancel my order",
  "cancel the whole thing",
  "reset",
  "start over",
  "let's start over",
  "forget the whole thing",
  "forget everything",
];

for (const phrase of GENUINE_CANCEL) {
  Deno.test(`GREEN Guard P2 regression: "${phrase}" still counts as a genuine cancel signal`, () => {
    assertEquals(IS_CANCEL_SIGNAL(phrase.toLowerCase()), true);
  });
}

// ── Regression: bucket 1 completion phrases untouched by this fix ─────────
for (const phrase of ["no thanks", "that's all", "that's it"]) {
  Deno.test(`GREEN regression: "${phrase}" still isn't bucket 3 (unaffected by this fix)`, () => {
    assertEquals(IS_AMBIGUOUS_BARE_DECLINE(norm(phrase)), false);
  });
}
