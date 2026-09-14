// Reply inversion, stage 2 (2026-09-13, docs/specs/2026-09-13-reply-inversion.md).
//
// STRUCTURAL: the last remaining inline .map(candidateOptionText).join(" or ")
// at a reply= site (classification site #40, GUARD 7 "couple options" branch)
// now routes through renderOptionAlternatives — same shape as the Stage 1
// invariant for site #21 pinned in reply-inversion-site21-enforcement.test.ts.
//
// GUARDS 1c/1g RETIRED (stage 3, 2026-09-13): the ITEM/CART-CLAIM SCOPE prompt
// rule now constrains the VOICE path too — the model can no longer enumerate
// cart items, assert what's in the cart, or claim it added/removed/changed
// anything, on ANY branch, not just the mutated-cart one. That closes the gap
// this file's old concerns 2/3 documented (claimsOffMenuItem / claimsItemInCart
// reachability on the no-mutation VOICE path), so GUARD 1c and 1g have nothing
// left to catch. Both guards and their reachability tests were deleted; see
// docs/specs/2026-09-13-reply-inversion.md item 4.

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

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

// ── Summary for the Stage 2 task brief ──────────────────────────────────────
//
// GUARDS 1c, 1d, 1f, 1g retired in stage 3 (2026-09-13) — see
// docs/specs/2026-09-13-reply-inversion.md item 4 and the header comment
// above for why the VOICE path no longer needs them.
