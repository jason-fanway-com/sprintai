#!/usr/bin/env deno run --allow-net --allow-env --allow-read
/**
 * phrase-isolation-live-verify.ts — Item 3 Phase 1c (2026-09-10).
 *
 * resolver.ts (supabase/functions/chat-sms/resolver.ts) is dead code — it is
 * only ever imported by _shared/menu-readiness.ts's isolated grader, never by
 * chat-sms/index.ts. Its test suite (resolver.test.ts) is the regression
 * record for the pepperoni-bleed defect (toppings from one pizza phrase
 * bleeding onto a DIFFERENT pizza phrase in the same customer message),
 * which recurred three times before being fixed on the LIVE path via
 * phrase-split.ts's splitCustomerPhrases + ask-plan-engine.ts's
 * modifierScopeText-scoped applyCompiledAddItem.
 *
 * This script ports resolver.test.ts's four acceptance cases onto the REAL
 * deployed chat-sms function — no synthetic cart state, no stubbed replies —
 * against Zio's Pizzeria (shop_id 2cba7b51-211c-4437-8910-1af4dcc03498),
 * confirmed live to have Hawaiian Pizza, Meat Lover's Pizza, and Neapolitan
 * Cheese Pizza, each with Pepperoni/Mushrooms among their real toppings.
 *
 * Modeled on named-remove-live-verify.ts's shape (same env vars, same
 * project ref, same runCase() driver) but with inline scripted TestCase
 * objects and hand-written deterministic assertions on the real returned
 * cart_json — NOT the LLM judge — because these are exact-shape invariants
 * (line count, which line carries which topping), not fuzzy conversational
 * criteria.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { runCase } from "./runner.ts";
import type { TestCase } from "./library.ts";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PROJECT_REF = "rvdqfxtrskxekfkqnegx";
const CHAT_FUNCTION_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/chat-sms`;
const SHOP_ID = "2cba7b51-211c-4437-8910-1af4dcc03498"; // Zio's Pizzeria

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SPRINTAI_CHAT_SUPABASE_URL or SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const config = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SUPABASE_KEY,
  chatFunctionUrl: CHAT_FUNCTION_URL,
};

// P0 fix verification (2026-09-10, live money — Zio's undercharge): the
// MULTI-TOPPING case below used to only assert "both toppings present," which
// documented the bug's SHAPE without proving the money is right. Pulling the
// item's own real, live ask_plan (base_price_cents + each topping's own
// price_delta_cents) lets every case below assert the EXACT expected
// subtotal — base + sum of the real toppings' own deltas — rather than a
// hand-typed guess that could silently drift from whatever Zio's menu
// actually charges.
const CHEESE_PIZZA_ITEM_ID = "35b44d0b-9aaa-4ac8-bf0e-4f8a8bf252bd"; // Large 18'' Neapolitan Cheese Pizza
const { data: cheesePizzaRow, error: cheesePizzaFetchError } = await supabase
  .from("menu_items")
  .select("ask_plan")
  .eq("id", CHEESE_PIZZA_ITEM_ID)
  .single();
if (cheesePizzaFetchError || !cheesePizzaRow?.ask_plan) {
  console.error(`Could not fetch live ask_plan for ${CHEESE_PIZZA_ITEM_ID}: ${cheesePizzaFetchError?.message ?? "no ask_plan"}`);
  Deno.exit(1);
}
const cheesePizzaAskPlan = cheesePizzaRow.ask_plan as {
  base_price_cents: number;
  steps: Array<{ kind: string; choices: Array<{ display: string; price_delta_cents: number }> }>;
};
const toppingChoicesLive = cheesePizzaAskPlan.steps.find(s => s.kind === "modifier")?.choices ?? [];
/** Real price_delta_cents for a topping display name (case-insensitive substring), or undefined if this shop's live menu doesn't actually sell it under that name. */
function liveToppingDeltaCents(nameSubstr: string): number | undefined {
  return toppingChoicesLive.find(c => c.display.toLowerCase().includes(nameSubstr.toLowerCase()))?.price_delta_cents;
}
const LARGE_SIZE_DELTA_CENTS = cheesePizzaAskPlan.steps.find(s => s.kind === "slot")
  ?.choices.find(c => c.display.toLowerCase().includes("large"))?.price_delta_cents ?? 0;
const LARGE_BASE_PLUS_SIZE_CENTS = cheesePizzaAskPlan.base_price_cents + LARGE_SIZE_DELTA_CENTS;

// ── Cart-line helpers (cart_json is an array of lines shaped like
// ask-plan-engine.ts's CompiledCartLine: { name, quantity, price_cents,
// options?: Record<string,string[]>, unverified_requests?: string[], ... }) ─

type CartLine = { name?: string; price_cents?: number; quantity?: number; options?: Record<string, string[]>; unverified_requests?: string[] };

function asLines(cart: unknown): CartLine[] {
  return Array.isArray(cart) ? cart as CartLine[] : [];
}

function toppingsOf(line: CartLine): string[] {
  return Object.values(line.options ?? {}).flat();
}

function linesNamed(lines: CartLine[], nameSubstr: string): CartLine[] {
  return lines.filter(l => (l.name ?? "").toLowerCase().includes(nameSubstr.toLowerCase()));
}

/**
 * Shared assertion body for every "N toppings named in one phrase, all on
 * ONE line" case in the phrasing matrix (requirement 4): exactly one
 * cheese-pizza line, every named topping present and (when this shop's live
 * ask_plan actually prices it under that name) contributing its real delta
 * to price_cents, and zero unverified_requests — a genuinely unresolved
 * topping is a P0 regression, not a pass. A topping name this live menu
 * doesn't sell under a matching display is skipped for the price assertion
 * (not silently ignored — logged) rather than failing the whole case on a
 * naming mismatch unrelated to the resolution bug this script exists to
 * catch.
 */
function assertAllToppingsOnOneLine(cart: CartLine[], toppingNames: string[]): string[] {
  const fails: string[] = [];
  const cheese = linesNamed(cart, "cheese");
  if (cheese.length !== 1) {
    fails.push(`expected exactly 1 cheese-pizza line, got ${cheese.length}: ${JSON.stringify(cheese)}`);
    return fails;
  }
  const line = cheese[0];
  const t = toppingsOf(line);
  let expectedCents = LARGE_BASE_PLUS_SIZE_CENTS;
  for (const name of toppingNames) {
    if (!t.some(x => x.toLowerCase().includes(name.toLowerCase()))) fails.push(`line missing ${name}: ${JSON.stringify(line)}`);
    const delta = liveToppingDeltaCents(name);
    if (delta === undefined) {
      console.log(`    (skipping exact-price check for "${name}" — no live choice display matched it)`);
      continue;
    }
    expectedCents += delta;
  }
  if (line.price_cents !== expectedCents) {
    fails.push(`price_cents ${line.price_cents} (=$${((line.price_cents ?? 0) / 100).toFixed(2)}) does not match expected ${expectedCents} (=$${(expectedCents / 100).toFixed(2)}) — a topping is being under/over-charged`);
  }
  if ((line.unverified_requests ?? []).length > 0) {
    fails.push(`line has unverified_requests (a real, sold topping was misclassified as unverifiable): ${JSON.stringify(line.unverified_requests)}`);
  }
  return fails;
}

// ── Cases (scripted — exact deterministic assertions, no LLM judge) ────────

interface Case {
  id: string;
  label: string;
  message: string;
  assert: (finalCart: CartLine[]) => string[]; // returns list of failure reasons, empty = pass
}

const CASES: Case[] = [
  {
    id: "phrase-iso-direction-a",
    label: "resolver.test.ts case 1 (direction A): '1 Hawaiian with pepperoni, 1 Meat Lover's'",
    message: "1 Hawaiian with pepperoni, 1 Meat Lover's",
    assert: (cart) => {
      const fails: string[] = [];
      const haw = linesNamed(cart, "hawaiian");
      const meat = linesNamed(cart, "meat lover");
      if (haw.length !== 1) fails.push(`expected exactly 1 Hawaiian line, got ${haw.length}`);
      if (meat.length !== 1) fails.push(`expected exactly 1 Meat Lover's line, got ${meat.length}`);
      if (haw.length === 1 && !toppingsOf(haw[0]).includes("Pepperoni")) {
        fails.push(`Hawaiian line missing Pepperoni: ${JSON.stringify(haw[0])}`);
      }
      if (meat.length === 1 && toppingsOf(meat[0]).includes("Pepperoni")) {
        fails.push(`Meat Lover's line WRONGLY carries Pepperoni (bleed): ${JSON.stringify(meat[0])}`);
      }
      return fails;
    },
  },
  {
    id: "phrase-iso-direction-b",
    label: "resolver.test.ts case 1 (direction B, reversed): '1 Meat Lover's, 1 Hawaiian with pepperoni'",
    message: "1 Meat Lover's, 1 Hawaiian with pepperoni",
    assert: (cart) => {
      const fails: string[] = [];
      const haw = linesNamed(cart, "hawaiian");
      const meat = linesNamed(cart, "meat lover");
      if (haw.length !== 1) fails.push(`expected exactly 1 Hawaiian line, got ${haw.length}`);
      if (meat.length !== 1) fails.push(`expected exactly 1 Meat Lover's line, got ${meat.length}`);
      if (haw.length === 1 && !toppingsOf(haw[0]).includes("Pepperoni")) {
        fails.push(`Hawaiian line missing Pepperoni: ${JSON.stringify(haw[0])}`);
      }
      if (meat.length === 1 && toppingsOf(meat[0]).includes("Pepperoni")) {
        fails.push(`Meat Lover's line WRONGLY carries Pepperoni (bleed, reversed order): ${JSON.stringify(meat[0])}`);
      }
      return fails;
    },
  },
  {
    id: "three-pizza-order",
    label: "resolver.test.ts case 2: '1 large cheese with pepperoni, 1 large cheese with mushrooms, 1 Hawaiian'",
    message: "1 large cheese with pepperoni, 1 large cheese with mushrooms, 1 Hawaiian",
    assert: (cart) => {
      const fails: string[] = [];
      const cheese = linesNamed(cart, "cheese");
      const haw = linesNamed(cart, "hawaiian");
      if (cheese.length !== 2) fails.push(`expected exactly 2 cheese-pizza lines, got ${cheese.length}: ${JSON.stringify(cheese)}`);
      if (haw.length !== 1) fails.push(`expected exactly 1 Hawaiian line, got ${haw.length}`);
      const pepLine = cheese.find(l => toppingsOf(l).includes("Pepperoni"));
      const mushLine = cheese.find(l => toppingsOf(l).some(t => t.toLowerCase().includes("mushroom")));
      if (!pepLine) fails.push(`no cheese line carries Pepperoni: ${JSON.stringify(cheese)}`);
      if (!mushLine) fails.push(`no cheese line carries Mushrooms: ${JSON.stringify(cheese)}`);
      if (pepLine && mushLine && pepLine === mushLine) fails.push(`both toppings landed on the SAME cheese line instead of two separate lines: ${JSON.stringify(pepLine)}`);
      if (haw.length === 1 && toppingsOf(haw[0]).length > 0) {
        fails.push(`Hawaiian line WRONGLY carries toppings from a cheese-pizza phrase: ${JSON.stringify(haw[0])}`);
      }
      return fails;
    },
  },
  {
    id: "multi-topping-same-pizza",
    label: "resolver.test.ts case 3 (MULTI-TOPPING), P0 fix verification: 'large cheese pizza with pepperoni and mushrooms' — ONE line, BOTH toppings priced, zero unverified_requests, subtotal exact (the reported live-money bug — was undercharging $3.00)",
    message: "large cheese pizza with pepperoni and mushrooms",
    assert: (cart) => assertAllToppingsOnOneLine(cart, ["Pepperoni", "Mushroom"]),
  },
  // ── Phrasing matrix (this task's requirement 4) — the same defect class
  // recurred three times behind single-phrasing fixes before (see this
  // file's header comment and ask-plan-engine.ts's "Rank-2 fix" comment
  // history); every phrasing a real customer would use must independently
  // prove the fix, not just the one phrase from the original report. ────────
  {
    id: "multi-topping-comma-no-and",
    label: "phrasing matrix: comma-separated, no 'and' — 'large cheese pizza with pepperoni, mushrooms'",
    message: "large cheese pizza with pepperoni, mushrooms",
    assert: (cart) => assertAllToppingsOnOneLine(cart, ["Pepperoni", "Mushroom"]),
  },
  {
    id: "multi-topping-three-in-one-call",
    label: "phrasing matrix: THREE same-step toppings in one call — 'large cheese pizza with pepperoni and mushrooms and extra cheese'",
    message: "large cheese pizza with pepperoni and mushrooms and extra cheese",
    assert: (cart) => assertAllToppingsOnOneLine(cart, ["Pepperoni", "Mushroom", "Extra Cheese"]),
  },
  {
    id: "multi-topping-bare-list",
    label: "phrasing matrix: bare list, no connector word — 'large cheese pizza pepperoni mushrooms'",
    message: "large cheese pizza pepperoni mushrooms",
    assert: (cart) => assertAllToppingsOnOneLine(cart, ["Pepperoni", "Mushroom"]),
  },
  {
    id: "multi-topping-conversational-wrapper",
    label: "phrasing matrix: conversational wrapper — 'can I get a large cheese pizza with pepperoni and mushrooms on it please'",
    message: "can I get a large cheese pizza with pepperoni and mushrooms on it please",
    assert: (cart) => assertAllToppingsOnOneLine(cart, ["Pepperoni", "Mushroom"]),
  },
];

// ── Run ──────────────────────────────────────────────────────────────────

console.log(`Running ${CASES.length} phrase-isolation live cases against deployed chat-sms (Zio's Pizzeria)...\n`);

let passed = 0, failed = 0;
for (const c of CASES) {
  console.log(`▶ ${c.id}: ${c.label}`);
  const testCase: TestCase = {
    id: c.id,
    category: "phrase-isolation",
    criticality: "critical",
    label: c.label,
    turns: [{ role: "customer", message: c.message }],
    success_criteria: [],
  };
  try {
    const result = await runCase(config, SHOP_ID, testCase);
    if (result.error) {
      console.log(`  ✗ FAIL — runner error: ${result.error}`);
      failed++;
      continue;
    }
    const lastTurn = result.transcript[result.transcript.length - 1];
    const cart = asLines(lastTurn?.cart);
    console.log(`  reply: ${(lastTurn?.reply ?? "").slice(0, 200)}`);
    console.log(`  cart: ${JSON.stringify(cart)}`);
    const fails = c.assert(cart);
    if (fails.length === 0) {
      console.log(`  ✓ PASS\n`);
      passed++;
    } else {
      console.log(`  ✗ FAIL`);
      for (const f of fails) console.log(`    - ${f}`);
      console.log();
      failed++;
    }
  } catch (e) {
    console.log(`  ✗ FAIL — exception: ${(e as Error).message}\n`);
    failed++;
  }
}

console.log(`\n═══ RESULT: ${passed}/${CASES.length} passed, ${failed} failed ═══`);
Deno.exit(failed > 0 ? 1 : 0);
