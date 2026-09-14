// Reply inversion, stage 2 (2026-09-13, docs/specs/2026-09-13-reply-inversion.md).
//
// Three concerns, all provable without live I/O:
//
// 1. STRUCTURAL: the last remaining inline .map(candidateOptionText).join(" or ")
//    at a reply= site (classification site #40, GUARD 7 "couple options" branch)
//    now routes through renderOptionAlternatives — same shape as the Stage 1
//    invariant for site #21 pinned in reply-inversion-site21-enforcement.test.ts.
//
// 2. GUARD 1g REACHABILITY: claimsOffMenuItem (GUARD 1g) can still fire on text
//    that Stage 1 and Stage 2 do not intercept. Stage 1 only covers the mutated-
//    cart branch; on a no-mutation (VOICE) turn `reply = loopResult.reply` is left
//    completely unconstrained. Stage 2 wires one more site through a renderer but
//    does not change the VOICE path. GUARD 1g remains load-bearing.
//
// 3. GUARD 1c REACHABILITY: same reasoning — claimsItemInCart (GUARD 1c) can still
//    fire on the VOICE path. Banning item-list enumeration does not prevent the
//    model from saying "[item] is in your cart" in a single-item narration.
//
// GUARDS KEPT: 1c and 1g are NOT deleted in this stage. Both guards remain
// reachable via the no-mutation VOICE path that Stage 1/2 intentionally leave
// untouched (see GUARD 1d/1f for the same reasoning, proved in
// reply-inversion-guard1d-necessity-20260913.test.ts). Deleting them would
// require also constraining the model's VOICE vocabulary — a broader change
// than Stage 2's scope.
//
// GUARDS 1d AND 1f: already proved load-bearing in Stage 1's necessity test;
// not re-tested here — Stage 2 makes no change to the VOICE path they guard.

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { claimsItemInCart } from "./cart.ts";
// claimsOffMenuItem lives in index.ts (exported 2026-09-13 for this purpose).
import { claimsOffMenuItem } from "./index.ts";

const INDEX_PATH = new URL("./index.ts", import.meta.url).pathname;

// ── 1. Structural: disambiguation site uses renderOptionAlternatives ─────────

Deno.test("reply-inversion stage 2: disambiguation 'couple options' site routes through renderOptionAlternatives, not an inline .join()", async () => {
  const source = await Deno.readTextFile(INDEX_PATH);

  // Locate the "couple options" template line — this is the target site.
  const templateMarker = `We've got a couple options called `;
  const idx = source.indexOf(templateMarker);
  assert(idx >= 0, "anchor 'We\\'ve got a couple options called' not found in index.ts — site moved, update this test");

  // Walk back ~600 chars to get the full else-branch context.
  const windowStart = Math.max(0, idx - 600);
  const windowEnd = Math.min(source.length, idx + 300);
  const block = source.slice(windowStart, windowEnd);

  assert(
    block.includes("renderOptionAlternatives("),
    "expected renderOptionAlternatives() at the couple-options site — Stage 2 must route through the renderer",
  );
  assert(
    !block.includes(`.join(" or ")`),
    "found an inline .join(\" or \") at the couple-options site — must route through renderOptionAlternatives instead",
  );
});

// ── 2. GUARD 1g reachability: claimsOffMenuItem still fires on the VOICE path ─

// On a no-mutation turn, index.ts leaves `reply` as `loopResult.reply` — the
// model's raw, unconstrained text (see Stage 1's comment block after
// `reply = loopResult.reply;`). The model can still claim an item that isn't on
// the menu ("I can add a truffle arancini"), and this guard is the only thing
// that catches it.
Deno.test("GUARD 1g still reachable: claimsOffMenuItem fires on a no-mutation-turn reply that Stage 1/2 do not intercept", () => {
  // A reply that Stage 1 never touches (no-mutation turn, VOICE path).
  const voiceReply = "Got it! I can add a truffle arancini to your order.";

  // A minimal menu that does NOT contain "truffle arancini".
  const menuItemNames = new Map<string, string>([
    ["cheese pizza", "Cheese Pizza"],
    ["garlic knots", "Garlic Knots"],
    ["french fries", "French Fries"],
  ]);

  // deno-lint-ignore no-explicit-any
  const guardCart: any[] = [];

  const result = claimsOffMenuItem(voiceReply, menuItemNames, guardCart);
  assert(
    result !== null,
    "GUARD 1g must still detect off-menu claims on the VOICE path — the guard is load-bearing after Stage 2",
  );
});

// ── 3. GUARD 1c reachability: claimsItemInCart still fires on the VOICE path ─

// Same reasoning: on a no-mutation (VOICE) turn, `reply` is unconstrained. The
// model can say "[item] is in your cart" for an item that was never ordered.
// GUARD 1c is the only check that catches this narrower phrasing pattern.
Deno.test("GUARD 1c still reachable: claimsItemInCart fires on a no-mutation-turn reply that Stage 1/2 do not intercept", () => {
  // The guard's empty-cart path: any "in your/the cart" claim is a hallucination
  // when guardCart is empty.
  const voiceReply = "Yeah, the pepperoni pizza is already in your cart!";
  const guardCart = [] as Parameters<typeof claimsItemInCart>[1];

  const result = claimsItemInCart(voiceReply, guardCart);
  assert(
    result !== null,
    "GUARD 1c must still detect phantom cart claims on the VOICE path — the guard is load-bearing after Stage 2",
  );
});

// ── Summary for the Stage 2 task brief ──────────────────────────────────────
//
// GUARDS RETIRED THIS STAGE: none — 1c and 1g remain reachable (proved above).
// GUARDS RETIRED STAGE 1: none (see reply-inversion-guard1d-necessity-20260913.test.ts).
// GUARD 1d, 1f: kept with explicit proof (Stage 1 test, still applies).
// Guard count after Stage 2: unchanged at 31 active guards.
// Reply-site count after Stage 2: unchanged at 69 (Stage 2 routes one site
// through a renderer but does not remove any assignments).
// The single reduction this stage delivers is closing the last unguarded
// .map().join() at a reply= site — the disambiguation optionsText (site #40).
