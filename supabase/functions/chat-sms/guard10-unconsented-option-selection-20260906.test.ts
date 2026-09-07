// FIX (2026-09-06, Jason — live QA, 5 fresh sessions of "i want a caesar
// salad"): "the dressing decision is still made three different ways" —
// (1) added, no dressing mentioned at all; (2,3,5) added, asks dressing
// (correct — no is_default exists); (4) added, "with Caesar dressing -
// added!" (invented). The model can supply add_item/modify_item options
// that pass a required group's validation (a real recorded choice name)
// without the customer ever having named it — indistinguishable from a
// genuine selection by add_item alone, since both produce the identical
// `options: { Dressing: ["Caesar"] }`.
//
// GUARD 10 is the deterministic backstop: the ONLY code-driven way an
// option may be set with no customer selection is default-fill
// (is_default, from commit 8791adc) — anything else that changed THIS TURN
// and wasn't customer-stated is invented and reverts to pending, same shape
// as GUARD 9 reverting a phantom cart add. It only examines items changed
// during the main LLM/tool loop — the dedicated pending-option-answer
// resolver (a separate, earlier, pre-LLM mechanism) already short-circuits
// with its own `return` before GUARD 10 ever runs, so a customer's genuine
// answer to a follow-up dressing question ("Caesar") is never at risk of
// being wrongly reverted here.
//
// This is a pure decision, copied here verbatim from index.ts (which has no
// exports — it is a Deno.serve entrypoint), matching the convention already
// used by the other test files in this directory.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

interface Choice {
  name: string;
  price_cents: number;
  is_default: boolean;
}

interface Group {
  name: string;
  required: boolean;
  choices: Choice[];
}

// Copied verbatim from GUARD 10's per-group decision in index.ts.
function isInventedSelection(
  chosen: string[] | undefined,
  beforeChosen: string[] | undefined,
  group: Group,
  itemName: string,
  userMessage: string,
): boolean {
  if (!chosen || chosen.length === 0) return false;
  if (JSON.stringify(beforeChosen ?? null) === JSON.stringify(chosen)) return false;
  const defaultChoice = group.choices.find(c => c.is_default && c.price_cents === 0);
  if (defaultChoice && chosen.length === 1 && chosen[0] === defaultChoice.name) return false;
  const itemNameWords = itemName.toLowerCase().split(/\s+/).filter(Boolean);
  let msgLower = userMessage.toLowerCase();
  for (const w of itemNameWords) {
    msgLower = msgLower.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
  }
  if (chosen.some(v => msgLower.includes(v.toLowerCase()))) return false;
  return true;
}

const DRESSING_NO_DEFAULT: Group = {
  name: "Dressing",
  required: true,
  choices: [
    { name: "Ranch", price_cents: 0, is_default: false },
    { name: "Caesar", price_cents: 0, is_default: false },
    { name: "Italian", price_cents: 0, is_default: false },
  ],
};

const DRESSING_WITH_DEFAULT: Group = {
  name: "Dressing",
  required: true,
  choices: [
    { name: "Ranch", price_cents: 0, is_default: true },
    { name: "Caesar", price_cents: 0, is_default: false },
  ],
};

Deno.test("GUARD 10: an invented choice with no customer mention and no default is flagged", () => {
  // Jason's actual run 4: "i want a caesar salad" -> model adds with options: { Dressing: ["Caesar"] }
  const invented = isInventedSelection(["Caesar"], undefined, DRESSING_NO_DEFAULT, "Chicken Caesar", "i want a caesar salad");
  assert(invented, "the word 'caesar' in the message names the DISH, not the dressing — this must still be flagged as invented");
});

Deno.test("GUARD 10: a legitimate deterministic default is never flagged", () => {
  const invented = isInventedSelection(["Ranch"], undefined, DRESSING_WITH_DEFAULT, "Chicken Caesar", "i want a caesar salad");
  assertEquals(invented, false);
});

Deno.test("GUARD 10: a choice the customer actually named in the same message is not flagged", () => {
  const invented = isInventedSelection(["Ranch"], undefined, DRESSING_NO_DEFAULT, "Chicken Caesar", "i want a caesar salad with ranch");
  assertEquals(invented, false);
});

Deno.test("GUARD 10: a choice already resolved on an earlier turn (unchanged) is never re-flagged", () => {
  const invented = isInventedSelection(["Caesar"], ["Caesar"], DRESSING_NO_DEFAULT, "Chicken Caesar", "thats it");
  assertEquals(invented, false, "beforeChosen === chosen means nothing changed this turn — already vetted whenever it was actually set");
});

Deno.test("GUARD 10: a default choice with a nonzero price is NOT exempted — must never auto-charge", () => {
  const paidDefault: Group = { name: "Size", required: true, choices: [{ name: "Large", price_cents: 200, is_default: true }] };
  const invented = isInventedSelection(["Large"], undefined, paidDefault, "Soda", "i want a soda");
  assert(invented, "a priced default is not eligible for the default-fill exemption — this must still be flagged");
});

Deno.test("GUARD 10: an empty/no selection is not itself flagged (that's just still-pending, nothing to revert)", () => {
  assertEquals(isInventedSelection(undefined, undefined, DRESSING_NO_DEFAULT, "Chicken Caesar", "i want a caesar salad"), false);
  assertEquals(isInventedSelection([], undefined, DRESSING_NO_DEFAULT, "Chicken Caesar", "i want a caesar salad"), false);
});

// Real-world edge case, accepted trade-off: a customer who explicitly
// double-names the dish's own word as their choice in the same breath
// ("chicken caesar salad with caesar dressing") gets asked to confirm
// again rather than credited — worse than ideal, but the alternative
// (trusting "caesar" unconditionally) is the actual bug being fixed here.
// Documented, not silently accepted — if this ever gets reported as an
// annoyance, that's the trade-off to revisit.
Deno.test("documented trade-off: explicitly re-naming the item's own word as the choice still asks again", () => {
  const invented = isInventedSelection(["Caesar"], undefined, DRESSING_NO_DEFAULT, "Chicken Caesar", "chicken caesar salad with caesar dressing");
  assert(invented, "known limitation: prefers a redundant re-ask over ever risking a silent invented charge/ticket line");
});

// ── Wiring regression guards against the live file ─────────────────────────

function extractBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert(start !== -1, `start marker not found in index.ts: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert(end !== -1, `end marker not found after start in index.ts: ${endMarker}`);
  return source.slice(start, end);
}

Deno.test("GUARD 10 wiring: runs BEFORE GUARD 2, so GUARD 2's pending check sees the corrected state", () => {
  const g10Idx = INDEX_SOURCE.indexOf("// ── Guard 10 (2026-09-06, Jason): unconsented option selection");
  const g2Idx = INDEX_SOURCE.indexOf("// ── Guard 2: order confirmation + no pickup name");
  assert(g10Idx !== -1 && g2Idx !== -1, "both markers must exist");
  assert(g10Idx < g2Idx, "GUARD 10 must run before GUARD 2 reads guardPendingItems");
});

Deno.test("GUARD 10 wiring: only ever examines REQUIRED groups", () => {
  const block = extractBlock(INDEX_SOURCE, "// ── Guard 10 (2026-09-06, Jason): unconsented option selection", "// ── Guard 9: unconsented cart growth");
  assert(block.includes("if (!group.required) continue;"), "GUARD 10 must skip optional groups entirely — no revert pressure on customer-optional add-ons");
});

Deno.test("GUARD 10 wiring: word-strips the item's own name, not just the exact full name, before checking for a customer-named choice", () => {
  const block = extractBlock(INDEX_SOURCE, "// ── Guard 10 (2026-09-06, Jason): unconsented option selection", "// ── Guard 9: unconsented cart growth");
  assert(block.includes("menuItem.name.toLowerCase().split(/\\s+/)"), "must split the item name into individual words, not treat it as one exact-match substring");
});

Deno.test("GUARD 10 wiring: a reverted selection is asked through the shared humanizer, and the cart is persisted", () => {
  const block = extractBlock(INDEX_SOURCE, "// ── Guard 10 (2026-09-06, Jason): unconsented option selection", "// ── Guard 9: unconsented cart growth");
  assert(block.includes("await saveCart(supabase, cart.id, guardCart"), "a revert must be persisted, not just held in memory for this reply");
  assert(block.includes("reply = renderMissingOptionsPrompt("), "must ask via the shared humanizer, same as GUARD 2 and D1 — never a raw tuple");
});

Deno.test("GUARD 10 wiring: reverting subtracts the invented choice's price — never leaves a stale charge", () => {
  const block = extractBlock(INDEX_SOURCE, "// ── Guard 10 (2026-09-06, Jason): unconsented option selection", "// ── Guard 9: unconsented cart growth");
  assert(block.includes("ci.price_cents -= revertedCents"), "must subtract the reverted choice's price_cents from the line total");
});

Deno.test("HARD GATE wiring: Phase A refuses to let a reply ask for the pickup name while any pending option remains, regardless of which guard or the model produced it", () => {
  const start = INDEX_SOURCE.indexOf("// ── Phase A: Deterministic money/status rendering");
  assert(start !== -1, "Phase A section must exist");
  const end = INDEX_SOURCE.indexOf("\n  }\n", start);
  const block = INDEX_SOURCE.slice(start, end);
  assert(block.includes("anyPendingOptions"), "Phase A must check for ANY pending option anywhere in the cart");
  assert(block.includes("if (anyPendingOptions && isAskingForPickupName(reply))"), "the hard gate must be checked FIRST, ahead of the recap-attachment branch");
  assert(block.includes("reply = renderMissingOptionsPrompt(pendingForPrompt)"), "the override must ask via the shared humanizer");
});
