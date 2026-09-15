// PO fix (00-BJ, narrowed from 00-BI's rejected global version): a numeric
// token becomes a significant stem ONLY for a group whose own choices would
// otherwise be indistinguishable once digits are dropped ("10 Pieces"/
// "20 Pieces" -> {"piece"}/{"piece"}) — never globally. Detected per-call
// from the group's own choice set (groupNeedsNumericStems, ask-plan-
// engine.ts), not a compiler-time flag or a second copy of the logic.
//
// CORRECTION to 00-BI's own measurement, found while building this: the
// literal phrase "10 pieces" already resolves TODAY via matchChoiceInText's
// pre-existing exact-string-match tier (normalizeForExactMatch) — 00-BI's
// measurement script was a simplified reimplementation that omitted that
// tier, so its "OLD: ambiguous" result for the literal phrase was an
// artifact of the measurement, not the real function. The real gap — and
// the real value of this fix — is a NEAR-exact phrasing that never was the
// verbatim display string ("10 pieces please", "8 pieces please"), which
// genuinely failed before this fix and resolves correctly after it.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { matchChoiceInText } from "./ask-plan-engine.ts";

const BONELESS_WINGS_QTY = [
  { id: "10pc", display: "10 Pieces", price_delta_cents: 0 },
  { id: "20pc", display: "20 Pieces", price_delta_cents: 800 },
];
const BONE_IN_WINGS_QTY = [
  { id: "8pc", display: "8 Pieces", price_delta_cents: 0 },
  { id: "14pc", display: "14 Pieces", price_delta_cents: 700 },
];

Deno.test("Boneless Wings: near-exact '10 pieces please' now resolves uniquely to 10 Pieces (previously ambiguous — both reduced to {'piec'})", () => {
  const match = matchChoiceInText(BONELESS_WINGS_QTY as any, "10 pieces please");
  assertEquals(match?.id, "10pc");
  assertEquals(match?.price_delta_cents, 0);
});

Deno.test("Boneless Wings: near-exact '20 pieces please' now resolves uniquely to 20 Pieces", () => {
  const match = matchChoiceInText(BONELESS_WINGS_QTY as any, "20 pieces please");
  assertEquals(match?.id, "20pc");
  assertEquals(match?.price_delta_cents, 800);
});

Deno.test("Boneless Wings: bare '2' still resolves to nothing — the confirmed money bug's exact input is untouched by this fix", () => {
  const match = matchChoiceInText(BONELESS_WINGS_QTY as any, "2");
  assertEquals(match, null);
});

Deno.test("Bone In Wings: near-exact '8 pieces please' now resolves uniquely to 8 Pieces (previously ambiguous — both reduced to {'piec'})", () => {
  const match = matchChoiceInText(BONE_IN_WINGS_QTY as any, "8 pieces please");
  assertEquals(match?.id, "8pc");
  assertEquals(match?.price_delta_cents, 0);
});

Deno.test("Bone In Wings: near-exact '14 pieces please' now resolves uniquely to 14 Pieces", () => {
  const match = matchChoiceInText(BONE_IN_WINGS_QTY as any, "14 pieces please");
  assertEquals(match?.id, "14pc");
  assertEquals(match?.price_delta_cents, 700);
});

Deno.test("Bone In Wings: bare '2' still resolves to nothing", () => {
  const match = matchChoiceInText(BONE_IN_WINGS_QTY as any, "2");
  assertEquals(match, null);
});

Deno.test("Jason's live repro, unaffected: bare 'medium'/'large' still resolve against 'Medium 12\"'/'Large 18\"' — no collision on this group, so numbers stay dropped exactly as before", () => {
  const subChoices = [
    { id: "c-med", display: 'Medium 12"', price_delta_cents: 0 },
    { id: "c-lg", display: 'Large 16"', price_delta_cents: 800 },
  ];
  assertEquals(matchChoiceInText(subChoices as any, "medium")?.id, "c-med");
  assertEquals(matchChoiceInText(subChoices as any, "large")?.id, "c-lg");
});
