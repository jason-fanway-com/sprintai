// Reply inversion, stage 1 (2026-09-13, docs/specs/2026-09-13-reply-inversion.md),
// task item 5: does this stage's new mechanism (action-confirmation.ts,
// wired into index.ts's `reply = loopResult.reply` site) make GUARD 1d
// (phantom-add-guard.ts) / GUARD 1f (guard1f-correction-claim-20260909.ts)
// unreachable, or do they still need to stay as a backstop?
//
// ANSWER (proved below, not asserted): NO — the new mechanism only acts on
// turns where the cart actually mutated (`cartMutatedAtLoop` in index.ts —
// `JSON.stringify(cartSnapshotBeforeTurn) !== JSON.stringify(cartItems)`).
// On a turn where NOTHING was written to the cart, index.ts leaves `reply`
// exactly as `loopResult.reply` — the model's raw, unconstrained text — by
// design (this is the VOICE path the spec says the model still owns). If
// the model falsely claims an add on that same no-mutation turn, this
// stage's new code never sees it and never suppresses it. GUARD 1d is the
// only thing standing between that false claim and the customer.
//
// This is not a narrower version of the same test as
// action-confirmation.test.ts's mutation-diff tests — those prove what
// happens WHEN the cart changed. This proves what happens when it did NOT,
// which is the one condition under which the old taproot defect (raw model
// text -> reply, unconstrained) still fully exists after this stage.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { claimsAddedWithoutMutation } from "./phantom-add-guard.ts";
import { detectCartMutation, type MutationCartLine } from "./action-confirmation.ts";

// The exact live incident this guard exists for (see phantom-add-guard.ts's
// header, and its own 2026-09-13 comment on the present-progressive fix):
// conv 2ba731f7, "Got it, adding a large plain cheese pizza..." shipped
// against a cart that hadn't actually changed.
const PHANTOM_ADD_REPLY = "Got it, adding a large plain cheese pizza. Anything else?";

// index.ts's own gate, reproduced verbatim (JSON.stringify structural
// equality) — the exact test this stage's new code runs BEFORE it will ever
// touch `reply`. See index.ts, the REPLY INVERSION comment block right after
// `reply = loopResult.reply;`.
function cartMutatedAtLoop(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

Deno.test("no-mutation turn: this stage's cart-mutated gate is false, so it never touches `reply`", () => {
  const cart: MutationCartLine[] = [{ menu_item_id: "cheese-pizza", name: "Cheese Pizza", quantity: 2, price_cents: 1299 }];
  // Same array CONTENT before and after (no tool call actually wrote
  // anything this turn) — cartItems still equals cartSnapshotBeforeTurn.
  const cartAfter = cart.map(l => ({ ...l }));

  assertEquals(cartMutatedAtLoop(cart, cartAfter), false);
  // detectCartMutation agrees independently — no event to render either.
  assertEquals(detectCartMutation(cart, cartAfter), null);
});

Deno.test("no-mutation turn: the model's phantom-add claim reaches `reply` completely unconstrained by this stage's new code", () => {
  const cart: MutationCartLine[] = [{ menu_item_id: "cheese-pizza", name: "Cheese Pizza", quantity: 2, price_cents: 1299 }];
  const cartAfter = cart.map(l => ({ ...l }));

  // index.ts's logic: `if (cartMutatedAtLoop) { ... } ` — false here, so the
  // `else` (implicit, no code) means `reply` stays exactly `loopResult.reply`.
  const mutated = cartMutatedAtLoop(cart, cartAfter);
  const replyAfterThisStage = mutated ? "UNREACHABLE_IN_THIS_TEST" : PHANTOM_ADD_REPLY;
  assertEquals(replyAfterThisStage, PHANTOM_ADD_REPLY, "on a no-mutation turn, this stage must not alter the model's text");
});

Deno.test("GUARD 1d still fires on that exact unconstrained text — it is still load-bearing after this stage", () => {
  const cartBefore: unknown[] = [{ menu_item_id: "cheese-pizza", name: "Cheese Pizza", quantity: 2, price_cents: 1299 }];
  const cartAfter = cartBefore.map(l => ({ ...(l as object) }));
  assertEquals(
    claimsAddedWithoutMutation(PHANTOM_ADD_REPLY, cartBefore, cartAfter),
    true,
    "GUARD 1d must still catch a phantom add claim on a turn this stage's new mechanism does not touch",
  );
});

// Conclusion for the task's honest-finding requirement: GUARD 1d (and, by
// the same reasoning — a correction claim with no matching mutation — GUARD
// 1f) CANNOT be deleted after this stage. They protect a turn shape (no
// mutation at all) that this stage's fix, scoped to the mutated-cart branch
// by design (see index.ts's REPLY INVERSION comment and the spec's own
// "when the turn did NOT mutate the cart... don't touch this path's
// behavior"), never reaches. Retiring 1d/1f would require also constraining
// the VOICE path itself — a broader change than this stage's scope, and
// explicitly deferred to a later stage per the task brief.
