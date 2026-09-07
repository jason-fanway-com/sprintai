// Deterministic red-then-green for the 2026-09-06 live bug (reproduced 3/3):
//   customer: "large cheese pizza" -> added, 1 line
//   customer: "no thanks"          -> "Your cart is empty. What would you like to order?"
// No pending question was open. Root cause: the deterministic correction
// handler in index.ts (search "Deterministic correction handler") lumped
// polite completions ("no thanks") into the same bucket as real removal
// verbs ("remove that"), so ending an order politely deleted the last (only)
// line.
//
// These regexes are copied verbatim from index.ts (same convention as
// guard-defects-20260905.test.ts / guard-phantom-add.test.ts, which pin
// inline regexes this way since the correction handler isn't extracted into
// its own module). If index.ts's correction handler changes, update both.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

function norm(userMessage: string): string {
  return userMessage.trim().toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// The OLD isCorrection / isRemove regexes, reproduced verbatim, to prove the
// bug was real (RED).
const OLD_IS_CORRECTION = (norm: string) =>
  /^(just want one|make it one|just one|only one|one is fine|just 1|make it 1|one of those|one of them|just the one|actually just one|actually one)$/i.test(norm) ||
  /^(i just want|i only want|i want just|ill take just|ill take one|ill have just|i just need|i wanted just|i meant just|give me just|let me get just)\s+(one|1)$/i.test(norm) ||
  /^(remove one|remove that|remove it|take it off|take that off|no thanks|never mind|nevermind|scratch that|forget that)$/i.test(norm) ||
  /^(remove the|remove my|drop the|drop my|take off the|take off my)\s+.+$/i.test(norm);
const OLD_IS_REMOVE = (norm: string) =>
  /^(remove|drop|take off|scratch|forget|no thanks|never ?mind)\b/i.test(norm);

Deno.test("RED: old isCorrection treated a bare 'no thanks' as a correction", () => {
  assertEquals(OLD_IS_CORRECTION(norm("no thanks")), true);
  assertEquals(OLD_IS_REMOVE(norm("no thanks")), true); // -> deleted the only line
});

// The NEW regexes now in index.ts (GREEN).
// 2026-09-07: "forget it" added — same idiom family as "forget that", and
// left ambiguous (asked, not guessed) for the same reason; see
// correction-negative-close-20260907.test.ts for the live repro.
const NEW_IS_AMBIGUOUS_BARE_DECLINE = (norm: string) =>
  /^(never ?mind|forget (?:it|that))$/i.test(norm);
// Named-item removal now captured via namedRemoveMatch (expanded to cover
// cancel the/my, get rid of the, scratch the in addition to original verbs).
// The 4th isCorrection condition is now `capturedName !== null` rather than
// a bare .test() call — mirrored here as a helper to keep tests in sync.
const NAMED_REMOVE_RE = /^(?:remove the|remove my|drop the|drop my|take off the|take off my|cancel the|cancel my|get rid of the|scratch the)\s+(.+)$/i;
const NEW_IS_CORRECTION = (norm: string) => {
  const namedRemoveMatch = norm.match(NAMED_REMOVE_RE);
  const capturedName = namedRemoveMatch ? namedRemoveMatch[1].trim() : null;
  return (
    /^(just want one|make it one|just one|only one|one is fine|just 1|make it 1|one of those|one of them|just the one|actually just one|actually one)$/i.test(norm) ||
    /^(i just want|i only want|i want just|ill take just|ill take one|ill have just|i just need|i wanted just|i meant just|give me just|let me get just)\s+(one|1)$/i.test(norm) ||
    /^(remove one|remove that|remove it|take it off|take that off|scratch that)$/i.test(norm) ||
    capturedName !== null
  );
};
const NEW_IS_REMOVE = (norm: string) =>
  /^(remove|delete|drop|take\s+(?:it|that|this|them)\s+off|take off|cancel|scratch|get rid of)\b/i.test(norm);

// ── Bucket 1: COMPLETION — must NOT be a correction, cart untouched ────────
const BUCKET_1_COMPLETION = [
  "no thanks", "no thank you", "nope", "that's all",
  "im good", "i'm good", "all set", "that'll do",
];

for (const phrase of BUCKET_1_COMPLETION) {
  Deno.test(`GREEN bucket 1 (completion): "${phrase}" is not a correction`, () => {
    assertEquals(NEW_IS_CORRECTION(norm(phrase)), false);
    assertEquals(NEW_IS_AMBIGUOUS_BARE_DECLINE(norm(phrase)), false);
  });
}

// ── Bucket 2: REMOVAL — regression coverage, real removal verbs still work ──
// These are the bare/named phrases isCorrection actually recognizes today;
// each must still reach the removal branch (isCorrection && isRemove).
const BUCKET_2_REMOVAL = [
  "remove one", "remove that", "remove it", "take it off", "take that off",
  "scratch that", "remove the pizza", "drop my fries",
];

for (const phrase of BUCKET_2_REMOVAL) {
  Deno.test(`GREEN bucket 2 (removal): "${phrase}" still removes the last item`, () => {
    const n = norm(phrase);
    assertEquals(NEW_IS_CORRECTION(n), true);
    assertEquals(NEW_IS_REMOVE(n), true);
  });
}

// New named-item verb forms added in 2026-09-07 fix (cancel/get rid of/scratch the).
const BUCKET_2_NEW_NAMED_VERBS = [
  "cancel the wings",
  "cancel my salad",
  "get rid of the large pizza",
  "scratch the garlic knots",
];

for (const phrase of BUCKET_2_NEW_NAMED_VERBS) {
  Deno.test(`GREEN bucket 2 (new named-verb): "${phrase}" is recognized as a named removal`, () => {
    const n = norm(phrase);
    assertEquals(NEW_IS_CORRECTION(n), true);
    assertEquals(NEW_IS_REMOVE(n), true);
  });
}

// The isRemove verb list also includes "delete"/"cancel"/"get rid of" per
// spec, even though isCorrection's bare-phrase regex doesn't currently emit
// those verbs at the start of a normalized message (no bare-phrase expansion
// was requested — only "take it off"/"take that off" needed a same-area fix,
// since they already matched isCorrection but never matched the old isRemove
// verb regex due to word order). This just pins the verb sub-check itself.
for (const phrase of ["delete that", "cancel that", "get rid of it"]) {
  Deno.test(`GREEN bucket 2 (removal verb list): "${phrase}" is recognized as a removal verb`, () => {
    assertEquals(NEW_IS_REMOVE(norm(phrase)), true);
  });
}

// ── Bucket 3: AMBIGUOUS — must ask, not guess or silently delete ───────────
// "forget it" added 2026-09-07 — see correction-negative-close-20260907.test.ts.
const BUCKET_3_AMBIGUOUS = ["never mind", "nevermind", "forget that", "forget it"];

for (const phrase of BUCKET_3_AMBIGUOUS) {
  Deno.test(`GREEN bucket 3 (ambiguous): "${phrase}" is flagged for clarification, not correction`, () => {
    const n = norm(phrase);
    assertEquals(NEW_IS_AMBIGUOUS_BARE_DECLINE(n), true);
    // isCorrection is irrelevant once isAmbiguousBareDecline short-circuits
    // and returns in index.ts, but confirm it no longer matches isRemove
    // stand-alone so a code-path regression can't silently re-enable delete.
    assertEquals(NEW_IS_REMOVE(n), false);
  });
}

Deno.test("GREEN: 'that's it' / 'checkout' / 'nothing else' remain untouched (already correct)", () => {
  for (const phrase of ["that's it", "checkout", "nothing else"]) {
    const n = norm(phrase);
    assertEquals(NEW_IS_CORRECTION(n), false);
    assertEquals(NEW_IS_AMBIGUOUS_BARE_DECLINE(n), false);
  }
});
