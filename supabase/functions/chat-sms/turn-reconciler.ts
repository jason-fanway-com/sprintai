// Turn reconciler (2026-09-12, PO-mandated architecture change, replaces
// GUARD 9/13/20/21).
//
// ROOT CAUSE this closes: the tool loop let the model decide WHETHER and HOW
// OFTEN the cart changes, one call at a time — code only ever validated the
// CONTENTS of a single mutation as it arrived (applyCompiledAddItem: are
// these choices legal, what's the real price). Nothing owned the AGGREGATE
// effect of a whole turn. Three individually-valid "accept" calls in one
// turn each look fine in isolation and sum to three pizzas; no per-call
// validator can ever catch that, because there is no per-call signal that
// distinguishes "the customer said this three times" from "three code paths
// each independently noticed the same one thing." GUARD 9/13/20/21 were four
// separate, narrower patches at the symptom layer (bare affirmation, pending
// option growth, "the regular", zero ordering signal) for exactly this gap —
// this file is the general fix all four were reaching for.
//
// This module is deliberately pure: plain data in
// (preTurnCart/loopFinalCart/proposals/customerMessageText), plain data out
// (corrected cart + a change log). No LLM call, no Supabase client, no I/O —
// unit-testable with nothing but literals, same discipline as cart.ts and
// ask-plan-engine.ts.
//
// Scope: this function corrects ONLY the aggregate quantity/existence
// decision for "unit added" events (add_item, the C2b-regular shortcut, any
// future equivalent). It does not re-implement content validation
// (ask_plan-engine.ts still owns choices/price) and it does not touch
// modify_item's content-only edits (e.g. "drop the pepperoni") — those are
// not aggregation bugs, they're already applied correctly and idempotently
// by the existing per-line handlers, so the reconciler leaves them alone.

// Structural shape only — deliberately NOT importing CartItem/CompiledCartLine
// from index.ts/ask-plan-engine.ts, so this file has zero dependency on
// either and stays trivially unit-testable.
export interface ReconcilerCartLine {
  menu_item_id: string;
  options?: Record<string, string[]>;
  quantity: number;
  pending_options?: string[];
  [key: string]: unknown;
}

// A single tool-call-shaped or shortcut-shaped attempt to add one unit of an
// item this turn. `grounded` is computed by the CALLER (index.ts), which
// already has the customer-referenced-item extraction, the regular-offer
// authorization check, and the deterministic-compose signal available —
// this file only consumes the boolean, it does not re-derive it, so there is
// exactly one place in the codebase that decides "was this actually asked
// for" (see index.ts's isGroundedThisTurn, which replaces the four
// near-identical isNamedThisTurnG9/13/20 closures GUARD 9/13/20 each used to
// carry separately).
export interface CartUnitProposal {
  menu_item_id: string;
  options?: Record<string, string[]>;
  // The actual customer words that motivated this proposal, when known
  // (empty string for a proposal with no clean phrase attribution, e.g. a
  // pre-LLM shortcut that fired on the whole message). Used ONLY for
  // explicit-quantity parsing ("two cokes"), scoped to this proposal's own
  // phrase first so a number elsewhere in a multi-item turn can't bleed onto
  // the wrong item.
  source_phrase: string;
  grounded: boolean;
}

export type ExplicitQuantity =
  | { kind: "absolute"; value: number }
  | { kind: "relative"; delta: number }
  | null;

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
};

// Deliberately narrow: this only recognizes a customer EXPLICITLY stating a
// count ("two cokes", "make it 3", "another one"). It does not try to
// resolve every possible quantity phrasing in English — the default (no
// match) is "no signal", which is the safe direction (no-op / one unit),
// per the idempotency rule this function exists to enforce.
export function parseExplicitQuantity(text: string): ExplicitQuantity {
  if (!text) return null;
  const t = text.toLowerCase();
  const make = t.match(/\bmake (?:it|that)\s+(\d+|one|two|three|four|five|six|seven|eight)\b/);
  if (make) {
    const v = NUMBER_WORDS[make[1]] ?? parseInt(make[1], 10);
    return { kind: "absolute", value: v };
  }
  if (/\banother\b|\bone more\b|\ban extra\b/.test(t)) return { kind: "relative", delta: 1 };
  const numMatch = t.match(/\b(\d+|two|three|four|five|six|seven|eight)\b/);
  if (numMatch) {
    const n = NUMBER_WORDS[numMatch[1]] ?? parseInt(numMatch[1], 10);
    if (n >= 2) return { kind: "absolute", value: n };
  }
  return null;
}

// Identity is menu_item_id + resolved/normalized selections — NEVER a name,
// anywhere in this file or its callers. `options` here is the same
// group-display-name -> choice-display-name[] shape ask-plan-engine.ts's
// applyCompiledAddItem already uses for its own identity checks
// (sameResolvedOptions) — human-meaningful and stable across a recompile,
// unlike the opaque ask_plan_selections ids.
export function identityKey(menuItemId: string, options?: Record<string, string[]>): string {
  const o = options ?? {};
  const keys = Object.keys(o).sort();
  const norm = keys.map(k => `${k}=${[...(o[k] ?? [])].sort().join("|")}`).join(";");
  return `${menuItemId}::${norm}`;
}

export interface ReconcileChange {
  menu_item_id: string;
  action: "added" | "qty_set" | "noop_reconfirm" | "dropped_unauthorized";
  qty?: number;
}

export interface ReconcileOutcome {
  cart: ReconcilerCartLine[];
  changes: ReconcileChange[];
}

/**
 * The single place that decides add vs merge vs no-op vs drop for a WHOLE
 * turn's add-shaped proposals together, replacing GUARD 9 (bare-affirmation
 * phantom add / qty revert), GUARD 13 (quantity growth on a pending-option
 * line), GUARD 20 ("the regular" requires confirmation), and GUARD 21
 * (general zero-signal backstop) — see docs/DEFECT-CLASSES.md for why those
 * four were retired in favor of this.
 *
 * `loopFinalCart` is whatever the tool loop / pre-LLM shortcuts already
 * produced this turn (unchanged for every line this function doesn't touch —
 * removes, non-quantity modifies, bundles, tips, delivery fields all pass
 * through as-is). This function only corrects the quantity/existence of
 * lines whose identity received one or more `proposals` this turn: it never
 * discovers a line proposals didn't mention, and never rewrites a line's
 * options/price (that's ask-plan-engine.ts's job, already applied upstream).
 */
export function reconcileAddProposals(
  preTurnCart: ReconcilerCartLine[],
  loopFinalCart: ReconcilerCartLine[],
  proposals: CartUnitProposal[],
  customerMessageText: string,
): ReconcileOutcome {
  const cart = loopFinalCart.map(l => ({ ...l }));
  const changes: ReconcileChange[] = [];

  if (proposals.length === 0) return { cart, changes };

  const preIndex = new Map<string, ReconcilerCartLine>();
  for (const l of preTurnCart) preIndex.set(identityKey(l.menu_item_id, l.options), l);

  const groups = new Map<string, CartUnitProposal[]>();
  for (const p of proposals) {
    const key = identityKey(p.menu_item_id, p.options);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  for (const [key, group] of groups) {
    // P0 fix (2026-09-13, live money — v413 bare-"yes" duplicate-pizza
    // defect): a turn's proposals can resolve to a cart that already
    // contains MORE THAN ONE array entry for this identity — e.g. one
    // writer routed through the legacy push and another through the
    // compiled ask-plan push for the same menu_item_id+options, each
    // blind to the other's identity check. The old code below only ever
    // found the FIRST matching index and adjusted its quantity, leaving
    // any additional duplicate lines untouched in the array — so the
    // corrected cart still had two lines, just with one now at qty 1
    // instead of both, and the total-quantity math index.ts used to decide
    // whether to apply this correction ($42 case: 1+1=2 before, 1+1=2
    // after) never showed a change. Collapsing every matching line down to
    // ONE array entry FIRST — before any quantity/idempotency decision —
    // is what makes "two lines, same identity" impossible to produce,
    // regardless of which upstream writer(s) created the extras.
    const matchIndices: number[] = [];
    cart.forEach((l, idx) => { if (identityKey(l.menu_item_id, l.options) === key) matchIndices.push(idx); });
    if (matchIndices.length === 0) {
      // The line this group refers to no longer exists in loopFinalCart —
      // e.g. a later remove_item this same turn deleted it. Nothing to
      // reconcile; the removal wins.
      continue;
    }
    const lineIdx = matchIndices[0];
    for (let i = matchIndices.length - 1; i >= 1; i--) cart.splice(matchIndices[i], 1);

    // Explicit multiplicity: check each proposal's own source phrase first
    // (scoped, so "two cokes" can't bleed onto a different item proposed in
    // the same turn); fall back to the whole message ONLY when this is the
    // sole distinct item proposed this turn, so a number elsewhere in a
    // multi-item message is never misattributed.
    let explicit: ExplicitQuantity = null;
    for (const p of group) {
      const fromPhrase = parseExplicitQuantity(p.source_phrase);
      if (fromPhrase) { explicit = fromPhrase; break; }
    }
    if (!explicit && groups.size === 1) {
      explicit = parseExplicitQuantity(customerMessageText);
    }

    const existingPre = preIndex.get(key);
    if (existingPre) {
      // Idempotency rule (required architecture point 3): re-confirming
      // something already in the cart is a quantity NO-OP by default,
      // regardless of how many proposals this turn resolved to it — it only
      // grows if the customer's own words this turn explicitly asked for
      // more.
      const preQty = existingPre.quantity;
      let finalQty = preQty;
      if (explicit?.kind === "absolute" && explicit.value > preQty) finalQty = explicit.value;
      else if (explicit?.kind === "relative") finalQty = preQty + explicit.delta;
      cart[lineIdx].quantity = finalQty;
      changes.push(
        finalQty !== preQty
          ? { menu_item_id: cart[lineIdx].menu_item_id, action: "qty_set", qty: finalQty }
          : { menu_item_id: cart[lineIdx].menu_item_id, action: "noop_reconfirm", qty: preQty },
      );
    } else {
      // Genuinely new this turn. Multiple proposals for the identical
      // identity (three "accept" calls, or the model AND a deterministic
      // shortcut each proposing the same thing) collapse to ONE unit by
      // default — this is the direct fix for "sum to three pizzas."
      const anyGrounded = group.some(p => p.grounded);
      if (!anyGrounded) {
        // Nothing in this turn's own text (or an authorized offer/shortcut)
        // actually asked for this — a phantom add. Drop it rather than let
        // an unauthorized proposal silently become a charge.
        cart.splice(lineIdx, 1);
        changes.push({ menu_item_id: key.split("::")[0], action: "dropped_unauthorized" });
        continue;
      }
      let finalQty = 1;
      if (explicit?.kind === "absolute") finalQty = explicit.value;
      else if (explicit?.kind === "relative") finalQty = 1 + explicit.delta;
      cart[lineIdx].quantity = finalQty;
      changes.push({ menu_item_id: cart[lineIdx].menu_item_id, action: "added", qty: finalQty });
    }
  }

  return { cart, changes };
}

// ── Proposal-event detection (mechanical, no semantic "was this grounded"
// judgment — that stays index.ts's job) ────────────────────────────────────

export interface CartLineSnapshot {
  menu_item_id: string;
  options?: Record<string, string[]>;
  quantity: number;
  pendingCount: number;
}

export function snapshotCartLines(cart: ReconcilerCartLine[]): CartLineSnapshot[] {
  return cart
    .filter(l => typeof l.menu_item_id === "string")
    .map(l => ({
      menu_item_id: l.menu_item_id,
      options: l.options,
      quantity: l.quantity ?? 1,
      pendingCount: (l.pending_options ?? []).length,
    }));
}

/**
 * Classifies what one add_item-shaped tool call (or shortcut) just did to
 * the cart, from a before/after pair, scoped to the item it targeted. This
 * exists so index.ts doesn't need applyCompiledAddItem to expose an extra
 * "was this a real unit event" field — content validation (ask-plan-engine.ts)
 * stays untouched; this only reads the two snapshots' shape.
 *
 * Returns a proposal-worthy event iff one of:
 *   - the line is now FULLY RESOLVED and didn't exist before (brand-new), or
 *   - the line is now FULLY RESOLVED and was pending before (continuation
 *     just completed — one proposal event for the whole chain), or
 *   - the line was already complete and its quantity just grew (merge), or
 *   - the line is STILL PENDING but its quantity grew (Guard 13 shape: the
 *     model re-issued add_item on an unrelated turn while a required option
 *     was still open, stacking quantity; the reconciler's idempotency rule
 *     reverts this unless the customer explicitly asked for more).
 * Returns null for a still-pending line with no qty change, or a true no-op.
 */
export function detectUnitCompletionEvent(
  before: CartLineSnapshot[],
  after: ReconcilerCartLine[],
  targetMenuItemId: string,
): { menu_item_id: string; options?: Record<string, string[]> } | null {
  const afterSnap = snapshotCartLines(after).filter(a => a.menu_item_id === targetMenuItemId);
  for (const a of afterSnap) {
    const key = identityKey(a.menu_item_id, a.options);
    const match = before.find(b => identityKey(b.menu_item_id, b.options) === key);
    if (a.pendingCount > 0) {
      // Still pending — only emit if qty grew on an already-pending line
      // (Guard 13 scenario). Complete-line cases handled below.
      if (match && match.pendingCount > 0 && a.quantity > match.quantity) {
        return { menu_item_id: a.menu_item_id, options: a.options };
      }
      continue;
    }
    if (!match) return { menu_item_id: a.menu_item_id, options: a.options };
    if (match.pendingCount > 0) return { menu_item_id: a.menu_item_id, options: a.options };
    if (a.quantity > match.quantity) return { menu_item_id: a.menu_item_id, options: a.options };
  }
  return null;
}
