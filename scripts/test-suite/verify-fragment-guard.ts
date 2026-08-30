#!/usr/bin/env deno run
/**
 * verify-fragment-guard.ts — Unit assertions for isQuestionOrFragment fix.
 * FP strings must return TRUE (they ARE fragments, NOT item claims → skip them).
 * Real item claims must return FALSE (they ARE item claims → still flagged).
 *
 * Run: deno run scripts/test-suite/verify-fragment-guard.ts
 */
import { isQuestionOrFragment } from "./cart-ops.ts";

interface Assertion { label: string; claimed: string; expect: boolean; }

const cases: Assertion[] = [
  // ── FALSE POSITIVES (should return TRUE = skip them) ──
  {
    label: "FP1: 'noted provolone'",
    claimed: "noted provolone",
    expect: true, // acknowledged modifier phrase → skip
  },
  {
    label: "FP2: 'no toasting. Anything else I can add'",
    claimed: "no toasting. Anything else I can add",
    expect: true, // mid-string punct "toasting." + word count >4 → skip
  },
  // ── Sub-fragments of FP2 (each clause alone) ──
  {
    label: "FP2a: 'no toasting' alone",
    claimed: "no toasting",
    expect: true, // acknowledgment leader "no" → skip
  },
  {
    label: "FP2b: 'Anything else I can add' alone",
    claimed: "Anything else I can add",
    expect: true, // word count >4 → skip
  },
  // ── REAL ITEM CLAIMS (should return FALSE = NOT fragment = flag them) ──
  {
    label: "Real: 'Lobster Roll added'",
    claimed: "Lobster Roll added",
    expect: false, // short, no ack leader, no mid-punct → ITEM CLAIM → flag
  },
  {
    label: "Real: 'Chicken Cutlet'",
    claimed: "Chicken Cutlet",
    expect: false, // short item name → flag (if not in menu)
  },
  // ── LEGIT ITEMS (should return FALSE = NOT fragment = but menuNameCheck passes) ──
  {
    label: "Legit: 'BOBO Sandwich added'",
    claimed: "BOBO Sandwich added",
    expect: false, // real item, short, no ack leader → NOT a fragment
  },
  // ── ACKNOWLEDGMENT LEADER EDGE CASES ──
  {
    label: "Ack: 'yes toasting added'",
    claimed: "yes toasting added",
    expect: true, // "yes" is ack leader → skip
  },
  {
    label: "Ack: 'sure toasted'",
    claimed: "sure toasted",
    expect: true, // "sure" is ack leader → skip
  },
  {
    label: "Ack: 'okay provolone'",
    claimed: "okay provolone",
    expect: true, // "okay" is ack leader → skip
  },
  {
    label: "Ack: 'ok noted'",
    claimed: "ok noted",
    expect: true, // "ok" is ack leader → skip
  },
  {
    label: "Ack: 'noting no cheese'",
    claimed: "noting no cheese",
    expect: true, // "noting" is ack leader → skip
  },
  // ── QUESTION-WORD EDGE CASES ──
  {
    label: "Q: 'your total comes to'",
    claimed: "your total comes to",
    expect: true, // "your" is question leader → skip
  },
  {
    label: "Q: 'any modifications to'",
    claimed: "any modifications to",
    expect: true, // "any" is question leader → skip
  },
  // ── WORD COUNT >4 ──
  {
    label: "Long: 'something else from our menu today'",
    claimed: "something else from our menu today",
    expect: true, // 7 words → skip
  },
  // ── MID-STRING PUNCTUATION ──
  {
    label: "Punct: 'added. Something else'",
    claimed: "added. Something else",
    expect: true, // contains "." → skip
  },
  // ── SHORT BUT STILL ITEM-SHAPED (≤4 words, no ack leader, no punct) ──
  {
    label: "Item-shaped: 'Large Cheese Pizza added'",
    claimed: "Large Cheese Pizza added",
    expect: false, // 4 words → NOT a fragment
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = isQuestionOrFragment(c.claimed);
  const ok = got === c.expect;
  console.log(`${ok ? "✅" : "❌"} ${c.label}: isQuestionOrFragment("${c.claimed.slice(0,50)}") → ${got} (expected ${c.expect})`);
  if (ok) pass++; else fail++;
}

console.log(`\n─── ${pass} passed, ${fail} failed ───`);
Deno.exit(fail > 0 ? 1 : 0);