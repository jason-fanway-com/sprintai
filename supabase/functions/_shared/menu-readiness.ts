/**
 * menu-readiness — the readiness gate (docs/specs/2026-09-07-conversation-
 * ready-menu-design.md §8, §11 item 5).
 *
 * §8.1 (item state) and §8.2 (the 8 menu-level invariants) are NOT
 * reimplemented here — they already exist as pure, tested functions in
 * ./compile-menu.ts (item 4, commit 24d7275): `compileItem`/`compileMenu`
 * compute `bot_state` per item (§8.1), and `computeMenuInvariants` runs all
 * 8 §8.2 checks and returns pass/fail + the specific violating rows per
 * check. This module reuses both unchanged rather than duplicating them.
 *
 * What's new here is §8.3 — the generated menu walk. For every `orderable`
 * item it synthesizes and executes the walk() case from the spec against
 * the REAL production code, no LLM, no synthetic shortcuts:
 *   - resolver.ts (item 3) resolves "add via resolver(item.display_name)"
 *     into a structured op, exactly as a fresh customer utterance would.
 *   - ask-plan-engine.ts's applyCompiledAddItem (item 8) is the actual
 *     sequencer + cart-mutation code the live compiled-item ordering path
 *     calls — reused here unchanged to answer each ask_plan step and build
 *     a real, priced cart line.
 *   - pricing.ts's computeCartSubtotalCents cross-checks the line total.
 *   - itemizer.ts's renderItemizedRecap renders the real ticket text.
 *
 * cart.ts (item 2) is NOT used here: every function it exports is a
 * hallucination GUARD — it verifies an LLM's free-text reply against
 * already-known cart state (claimsItemInCart, findMissingCartItems,
 * replyAcknowledgesCart, isClosingReply, ...). The walk never produces an
 * LLM reply to check, so none of those functions have anything to operate
 * on. The module that actually turns ask_plan steps + customer text into a
 * cart line is ask-plan-engine.ts, which is what's used instead.
 */

import {
  type AskPlan,
  type CompileItem,
  type CompiledItem,
  type MenuInvariantResult,
} from "./compile-menu.ts";
import { resolveUtterance, type ResolvedOp } from "../chat-sms/resolver.ts";
import type { ComposeMenuItem } from "../chat-sms/pizza-topping-compose.ts";
import {
  applyCompiledAddItem,
  allSlotsResolved,
  type CompiledCartLine,
  type CompiledMenuItem,
} from "../chat-sms/ask-plan-engine.ts";
import { computeCartSubtotalCents, type PricedCartLine } from "../chat-sms/pricing.ts";
import { renderItemizedRecap, type ItemizedCartLine } from "../chat-sms/itemizer.ts";
import { SERVICE_FEE_CENTS } from "./connect.ts";

// ── §8.1 state summary (thin wrapper over compile-menu.ts's own bot_state) ──

export interface ItemStateCounts {
  orderable: number;
  blocked: number;
  display_only: number;
  stale: number;
  total_active: number;
}

export function summarizeItemStates(
  items: CompileItem[],
  compiled: Map<string, CompiledItem>,
): ItemStateCounts {
  const active = items.filter(i => i.active);
  const counts: ItemStateCounts = { orderable: 0, blocked: 0, display_only: 0, stale: 0, total_active: active.length };
  for (const i of active) {
    const state = compiled.get(i.id)?.bot_state;
    if (state && state in counts) (counts as unknown as Record<string, number>)[state]++;
  }
  return counts;
}

// ── §8.3 the generated menu walk ────────────────────────────────────────────

export interface WalkFailure {
  step: string;
  detail: string;
}

export interface WalkResult {
  item_id: string;
  display_name: string;
  pass: boolean;
  failures: WalkFailure[];
  cart_line_price_cents: number | null;
  cart_total_with_fee_cents: number | null;
  ticket_text: string | null;
}

export interface MenuWalkReport {
  total_orderable: number;
  passed: number;
  failed: number;
  results: WalkResult[];
}

function toComposeMenu(items: CompileItem[], compiled: Map<string, CompiledItem>): ComposeMenuItem[] {
  return items.map(i => ({
    id: i.id,
    name: i.name,
    category: i.category ?? "",
    ask_plan: compiled.get(i.id)?.ask_plan ?? null,
    bot_state: compiled.get(i.id)?.bot_state ?? null,
    option_groups: i.groups.map(g => ({ id: g.id, name: g.name })),
  }));
}

/**
 * Execute the §8.3 walk for exactly one orderable item against the real
 * resolver + compiled-item engine + pricing + itemizer code. Returns a
 * structured pass/fail with the specific step that broke, not just a
 * boolean — per the task's own requirement, mirroring how
 * computeMenuInvariants reports violating rows rather than a bare pass/fail.
 */
export function runItemWalk(
  item: CompileItem,
  compiledItem: CompiledItem,
  allItems: CompileItem[],
  allCompiled: Map<string, CompiledItem>,
): WalkResult {
  const failures: WalkFailure[] = [];
  const askPlan: AskPlan = compiledItem.ask_plan;
  const empty: WalkResult = {
    item_id: item.id,
    display_name: askPlan.display_name,
    pass: false,
    failures,
    cart_line_price_cents: null,
    cart_total_with_fee_cents: null,
    ticket_text: null,
  };

  // ── Step 1: "add via resolver(term = item.display_name)" ────────────────
  const menuForResolver = toComposeMenu(allItems, allCompiled);
  let ops: ResolvedOp[];
  try {
    ops = resolveUtterance(askPlan.display_name, menuForResolver);
  } catch (e) {
    failures.push({ step: "resolver-add", detail: `resolveUtterance threw: ${String(e)}` });
    return empty;
  }
  if (ops.length !== 1 || ops[0].kind !== "add_item" || ops[0].itemId !== item.id) {
    failures.push({
      step: "resolver-add",
      detail: `resolveUtterance("${askPlan.display_name}") did not resolve to a single add_item for ${item.id}: ${JSON.stringify(ops)}`,
    });
    return empty; // cannot proceed to cart assertions if the item can't even be added
  }

  // ── Build the real cart line via the compiled add-item engine (item 8) ──
  const cart: CompiledCartLine[] = [];
  const engineMenuItem: CompiledMenuItem = {
    ask_plan: askPlan,
    bot_state: compiledItem.bot_state,
    option_groups: item.groups.map(g => ({ id: g.id, name: g.name, default_choice_id: g.default_choice_id })),
  };

  const addResult = applyCompiledAddItem(cart, engineMenuItem, item.id, 1, askPlan.display_name, null);
  if (!addResult.ok || cart.length !== 1) {
    failures.push({ step: "add-item", detail: `applyCompiledAddItem failed or produced ${cart.length} cart lines: ${JSON.stringify(addResult.result)}` });
    return empty;
  }

  // ── apply_default / auto_single: must already be resolved with zero dialogue ──
  const firstCallResolvedIds = new Set(Object.keys(cart[0].ask_plan_selections ?? {}));
  for (const step of askPlan.steps) {
    if (step.kind !== "slot") continue;
    if (step.ask_mode === "auto_single" && !firstCallResolvedIds.has(step.group_id)) {
      failures.push({ step: `auto_single:${step.group_id}`, detail: "auto_single slot was not silently resolved on add" });
    }
    const groupHasDefault = item.groups.find(g => g.id === step.group_id)?.default_choice_id;
    if (step.ask_mode === "apply_default" && groupHasDefault && !firstCallResolvedIds.has(step.group_id)) {
      failures.push({ step: `apply_default:${step.group_id}`, detail: "apply_default slot with a configured default was not silently resolved on add" });
    }
  }

  // ── for step in ask_plan.steps: ask -> answer with choices[0].display ──
  const slotSteps = askPlan.steps.filter(s => s.kind === "slot");
  let guard = 0;
  for (;;) {
    const line = cart[0];
    const resolvedIds = new Set(Object.keys(line.ask_plan_selections ?? {}));
    if (allSlotsResolved(askPlan, resolvedIds)) break;
    guard++;
    if (guard > slotSteps.length + 2) {
      failures.push({ step: "ask-loop", detail: `slot resolution did not converge after ${guard} turns; resolved=${[...resolvedIds]}` });
      break;
    }
    const nextStep = slotSteps.find(s => !resolvedIds.has(s.group_id));
    if (!nextStep || nextStep.choices.length === 0) {
      failures.push({ step: "ask-loop", detail: `no answerable next step found; resolved=${[...resolvedIds]}` });
      break;
    }
    const answerText = nextStep.choices[0].display;
    const beforeSize = resolvedIds.size;
    const stepResult = applyCompiledAddItem(cart, engineMenuItem, item.id, 1, answerText, null);
    const afterIds = new Set(Object.keys(cart[0].ask_plan_selections ?? {}));
    if (!stepResult.ok || !afterIds.has(nextStep.group_id) || afterIds.size <= beforeSize) {
      failures.push({
        step: `ask:${nextStep.slot_key ?? nextStep.group_id}`,
        detail: `answering "${answerText}" (choices[0].display) did not record a selection for group ${nextStep.group_id}`,
      });
      break; // don't loop forever on a step that can't be answered
    }
  }

  const line = cart[0];
  const resolvedGroupIds = new Set(Object.keys(line.ask_plan_selections ?? {}));

  // ── unfilled_required_groups() == [] ─────────────────────────────────────
  if (!allSlotsResolved(askPlan, resolvedGroupIds)) {
    const unfilled = slotSteps.filter(s => !resolvedGroupIds.has(s.group_id)).map(s => s.slot_key ?? s.group_id);
    failures.push({ step: "unfilled-required-groups", detail: `still-open required slots: ${unfilled.join(", ")}` });
  }

  // ── offer_once / modifier steps: never mentioned -> never applied ("no thanks") ──
  for (const step of askPlan.steps) {
    if (step.kind === "modifier" && resolvedGroupIds.has(step.group_id)) {
      failures.push({ step: `offer_once:${step.group_id}`, detail: "modifier was applied without ever being requested by the walk" });
    }
  }

  // ── total == base + Σ deltas (+ consumer fee) ────────────────────────────
  let expectedDelta = 0;
  const selectedDisplays: string[] = [];
  for (const step of askPlan.steps) {
    const choiceId = line.ask_plan_selections?.[step.group_id];
    if (!choiceId) continue;
    const choice = step.choices.find(c => c.id === choiceId);
    if (!choice) {
      failures.push({ step: "pricing", detail: `selection ${choiceId} on group ${step.group_id} does not reference a real ask_plan choice` });
      continue;
    }
    expectedDelta += choice.price_delta_cents;
    selectedDisplays.push(choice.display);
  }
  const expectedLineTotal = askPlan.base_price_cents + expectedDelta;
  if (line.price_cents !== expectedLineTotal) {
    failures.push({
      step: "pricing",
      detail: `cart line price_cents ${line.price_cents} !== base ${askPlan.base_price_cents} + Σdeltas ${expectedDelta} = ${expectedLineTotal}`,
    });
  }
  const subtotalCents = computeCartSubtotalCents(cart as unknown as PricedCartLine[]);
  if (subtotalCents !== line.price_cents) {
    failures.push({ step: "pricing-subtotal", detail: `computeCartSubtotalCents ${subtotalCents} !== single line's price_cents ${line.price_cents}` });
  }
  const totalWithFeeCents = subtotalCents + SERVICE_FEE_CENTS;

  // ── ticket text contains every selection's display_name, never the raw
  // internal name when it differs from display_name ──────────────────────
  const ticketText = renderItemizedRecap(cart as unknown as ItemizedCartLine[]);
  for (const d of selectedDisplays) {
    if (!ticketText.includes(d)) {
      failures.push({ step: "ticket-text", detail: `ticket text missing selection display_name "${d}"` });
    }
  }
  const displayDiffersFromRawName = item.name !== askPlan.display_name;
  const rawNameIsSubstringOfDisplay = askPlan.display_name.includes(item.name);
  if (displayDiffersFromRawName && !rawNameIsSubstringOfDisplay && ticketText.includes(item.name)) {
    failures.push({ step: "ticket-text-leak", detail: `ticket text contains raw internal name "${item.name}" though display_name is "${askPlan.display_name}"` });
  }

  return {
    item_id: item.id,
    display_name: askPlan.display_name,
    pass: failures.length === 0,
    failures,
    cart_line_price_cents: line.price_cents,
    cart_total_with_fee_cents: totalWithFeeCents,
    ticket_text: ticketText,
  };
}

/** Run the §8.3 walk for every orderable item in the compiled menu. */
export function runMenuWalk(items: CompileItem[], compiled: Map<string, CompiledItem>): MenuWalkReport {
  const orderable = items.filter(i => compiled.get(i.id)?.bot_state === "orderable");
  const results = orderable.map(i => runItemWalk(i, compiled.get(i.id)!, items, compiled));
  return {
    total_orderable: orderable.length,
    passed: results.filter(r => r.pass).length,
    failed: results.filter(r => !r.pass).length,
    results,
  };
}

// ── Top-line readiness report combining §8.1 states + §8.2 invariants + §8.3 walk ──

export interface MenuReadinessReport {
  states: ItemStateCounts;
  invariants: MenuInvariantResult[];
  walk: MenuWalkReport;
  orderable_ratio: number;
}

export function computeReadinessReport(
  items: CompileItem[],
  compiled: Map<string, CompiledItem>,
  invariants: MenuInvariantResult[],
): MenuReadinessReport {
  const states = summarizeItemStates(items, compiled);
  const walk = runMenuWalk(items, compiled);
  return {
    states,
    invariants,
    walk,
    orderable_ratio: states.total_active === 0 ? 1 : states.orderable / states.total_active,
  };
}
