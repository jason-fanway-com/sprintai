// Deterministic red-then-green for the two defects Jason found in the live
// simulator test on 2026-09-05 (test_transcripts 35ab0c44-fdae-455a-acf0-960e8d1d59e5).
//
// DEFECT 1: "Let me check with the kitchen on which ones we have." The bot
//           checks with nobody. Invented ACTION, not just an invented option.
// DEFECT 2: customer: "why wouldnt you just tell me whats availabel? youre not
//           really checking wiht the kitchen. youre a bot"
//           bot:      "What else can I add?"
//           Guard 1c matched "you have a pr[eference]" against its optional
//           in-your-cart suffix, reported a cart claim for an item named "pr",
//           and discarded the model's honest answer.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { claimsInventedAction, stripInventedActions } from "./invented-action-guard.ts";

// ── DEFECT 2: the exact regex that fired in production (RED) ────────────────
const OLD_PATTERN_2 =
  /you\s+(?:already\s+)?have\s+(?:a\s+)?(["']?[A-Za-z][\w\s&'-]{1,40}?)(?:\s+in\s+(?:your|the)\s+cart)?/i;

// The narrowed pattern now in index.ts (GREEN).
const NEW_PATTERN_2 =
  /you\s+(?:already\s+)?have\s+(?:a\s+|an\s+|the\s+)?(["']?[A-Za-z][\w\s&'-]{1,40}?)\s+in\s+(?:your|the)\s+cart/i;

const HONEST_REPLY =
  "You're right, fair callout. Here's the honest answer: the wing entry in my " +
  "system doesn't list specific flavors for this shop, so I genuinely don't " +
  "know them. What flavor are you thinking? I can add it if you have a preference.";

Deno.test("RED: old Guard 1c pattern reported a cart claim for 'pr'", () => {
  const m = HONEST_REPLY.match(OLD_PATTERN_2);
  assertEquals(m?.[1].trim(), "pr");
});

Deno.test("GREEN: narrowed pattern ignores a reply that never mentions the cart", () => {
  assertEquals(NEW_PATTERN_2.test(HONEST_REPLY), false);
});

Deno.test("GREEN: ordinary English no longer trips the cart-claim guard", () => {
  for (
    const s of [
      "Let me know if you have any allergies.",
      "Do you have a preferred pickup time?",
      "I can add it if you have a preference.",
      "If you have a second, what name is this under?",
    ]
  ) {
    assertEquals(NEW_PATTERN_2.test(s), false, s);
  }
});

Deno.test("GREEN: a real cart-content claim is still caught", () => {
  for (
    const s of [
      "You have a large cheese pizza in your cart.",
      "You already have an order of fries in the cart.",
    ]
  ) {
    assertEquals(NEW_PATTERN_2.test(s), true, s);
  }
});

// ── DEFECT 2, second half: the replacement had to survive the money stripper ─
// stripLlmMoneyLines() deletes "I've got N items in your cart" — that is its
// job — so Guard 1c's own fallback was reduced to the bare fragment Jason saw.
const MONEY_STRIP =
  /\b(?:I['’]ve got|you['’]ve got|you have|that['’]s|there are|there's|we're at|I see)\s*\d+\s+items?(?:\s+(?:in\s+(?:your|the)\s+cart|so far|total))?/gi;

Deno.test("RED: old Guard 1c fallback was eaten, leaving 'What else can I add?'", () => {
  const old = "I've got 4 items in your cart. What else can I add?";
  const survived = old.replace(MONEY_STRIP, "").replace(/^[,.\s]+/, "").trim();
  assertEquals(survived, "What else can I add?");
});

Deno.test("GREEN: new Guard 1c fallback survives the money stripper intact", () => {
  const now = "Sorry, I got mixed up about your order there. What would you like to add or change?";
  assertEquals(now.replace(MONEY_STRIP, ""), now);
});

// ── DEFECT 1: invented actions ──────────────────────────────────────────────
Deno.test("detects the exact sentences from the transcript", () => {
  assertEquals(claimsInventedAction("Let me check with the kitchen on which ones we have"), true);
  assertEquals(claimsInventedAction("Bone-in wings added! What flavor are you thinking? Let me check with the kitchen on what's available"), true);
});

Deno.test("detects the other stalling phrasings", () => {
  for (
    const s of [
      "I'll check with the kitchen and get back to you.",
      "Let me ask the kitchen about that.",
      "Give me a sec, I'll find out.",
      "Hold on while I look that up.",
      "I'll double-check with the owner.",
      "One moment - let me confirm with the kitchen.",
    ]
  ) {
    assertEquals(claimsInventedAction(s), true, s);
  }
});

Deno.test("does NOT fire on things the tools actually do", () => {
  for (
    const s of [
      "Let me get that added for you.",
      "I'll add the fries now.",
      "Let me send you the payment link.",
      "I'll put a note on that for the kitchen.",
      "Got it - I'll add bone-in wings.",
      "What name should I put this under for pickup?",
    ]
  ) {
    assertEquals(claimsInventedAction(s), false, s);
  }
});

Deno.test("strips the promise and KEEPS the rest of the reply", () => {
  assertEquals(
    stripInventedActions("Bone-in wings added! What flavor are you thinking? Let me check with the kitchen on what's available"),
    "Bone-in wings added! What flavor are you thinking?",
  );
  assertEquals(
    stripInventedActions("Sure! Bone-in ($16.99) or boneless ($11.99)? And what flavor are you thinking? Let me check with the kitchen on which ones we have"),
    "Sure! Bone-in ($16.99) or boneless ($11.99)? And what flavor are you thinking?",
  );
});

Deno.test("strips a trailing clause hung off a legitimate sentence", () => {
  assertEquals(
    stripInventedActions("What flavor would you like - let me check with the kitchen first."),
    "What flavor would you like.",
  );
});

Deno.test("never returns an empty or stub reply", () => {
  const out = stripInventedActions("Let me check with the kitchen.");
  assertEquals(out.length >= 12, true);
  assertEquals(claimsInventedAction(out), false);
});

Deno.test("leaves a clean reply untouched (identity, no allocation)", () => {
  const clean = "I don't have the flavor list for these - what flavor would you like?";
  assertEquals(stripInventedActions(clean), clean);
});

// ── Negation: denying the action is the CORRECT behaviour, never strip it ────
// Caught on the live replay after deploying the first draft of this guard.
Deno.test("does NOT fire on an honest denial of the action", () => {
  for (
    const s of [
      "You're right, and I should be upfront: the wing entry in my menu doesn't list any flavors. I don't have them to share, and I can't check with the kitchen.",
      "I'm a bot, I'm not calling the kitchen, and I won't pretend otherwise.",
      "I can't check with anyone - what flavor would you like?",
      "There's no way for me to ask the kitchen, so tell me what you'd like.",
    ]
  ) {
    assertEquals(claimsInventedAction(s), false, s);
    assertEquals(stripInventedActions(s), s, s);
  }
});
