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

// ── writeCartLine (2026-09-13, PO-mandated single-writer architecture) ─────
//
// The ONLY function in this codebase permitted to create or modify a cart
// line. Replaces five independent writers (legacy add_item's push, the
// compiled ask_plan engine's push, start_bundle's push, the reconciler's own
// apply, and GUARD 19's revert) plus the array-wide dedup backstop that used
// to run after them.
//
// ROOT CAUSE this closes: those five writers each independently decided
// "does this identity already exist, and what do I do to it." Two of them —
// the legacy push (name: menuItem.name, no ask_plan_selections) and the
// compiled push (name: askPlan.display_name, ask_plan_selections populated)
// — produced DIFFERENTLY-SHAPED rows for the same menu_item_id, so neither
// writer's own identity check ever recognized the other's line as the same
// order. That shape mismatch, not any single guard's logic, is what let two
// lines exist for one real order. A backstop that collapses duplicate-
// identity lines after the fact only ever cleans up after multiple writers —
// it does nothing to stop a sixth writer from reintroducing the exact same
// defect, and (2026-09-13 sibling incident) summing quantities across what
// it assumed were "duplicates" is exactly how one order became sixteen
// pizzas. The fix is structural: exactly one function ever pushes or mutates
// an array entry, so there is nothing left to deduplicate.
//
// Identity is decided EXCLUSIVELY by identityKey() above — menu_item_id plus
// resolved options, never a second identity notion. A legacy-path caller
// that must keep two lines distinct on modifiers/unverified_requests (see
// index.ts's D1 2026-09-09 fix note — "plain" vs "with extra cheese" must
// never merge) folds those into the options bag handed to identityKey via
// the `modifiers`/`unverified_requests` fields below; this is still the one
// identity function, just given a fuller view of what makes two lines "the
// same real order." The line's own stored `options` field is never
// polluted with this synthetic view — only the identity computation sees it.

export type WriteCartLineAction = "created" | "continued" | "merged_noop" | "qty_grown" | "noop_missing";

export interface WriteCartLineResult {
  index: number; // -1 only for "noop_missing"
  action: WriteCartLineAction;
}

export interface WriteCartLineInput {
  menu_item_id: string;
  name?: string;
  price_cents?: number;
  options?: Record<string, string[]>;
  modifiers?: string[];
  option_group_ids?: Record<string, string>;
  pending_options?: string[];
  unverified_requests?: string[];
  ask_plan_selections?: Record<string, string | string[]>;
  sourcePhraseIndex?: number;
  // This call's own requested unit count. Used verbatim ONLY when this
  // identity does not already exist in `cart` (a brand-new line) — ignored
  // otherwise. See `explicitQuantity` for the only way an EXISTING line's
  // quantity may grow.
  quantity?: number;
  // The customer's OWN words this turn stating a real count ("two cokes",
  // "another one") — parseExplicitQuantity's output. The only thing that can
  // grow an EXISTING line's quantity (continuationIndex/merge branches
  // below); omitted/null means no signal, so an existing line's quantity
  // never changes (idempotent no-op — CartOps' "never additive by default"
  // rule). A `{kind: "relative", ...}` value is ONLY safe to pass when this
  // is a genuinely brand-new line (nothing existing to double-apply
  // against) — the merge/continuation branches reject "relative" outright
  // (PO 2026-09-13, x15/$331.50 incident: the caller re-derives this from
  // turn-wide text on every repeat call the model makes for the same line,
  // so an unconditional per-call `+delta` on an EXISTING line restacks once
  // per call instead of once per turn). A caller with an "add N more"
  // instruction on an existing line must resolve it to `{kind: "absolute",
  // value}` BEFORE calling, against the identity's PRE-TURN quantity — see
  // index.ts's preTurnCartForIdentity.
  explicitQuantity?: ExplicitQuantity;
  // Caller already found (via its own READ-ONLY search — e.g. "a required
  // option group is still open for this menu_item_id") the exact array
  // index this call resolves, bypassing identity matching entirely. Used
  // for continuing an in-progress line whose options are necessarily
  // incomplete/changing and so cannot be found by identity. Every other
  // field above still applies (the line's shape is refreshed in place);
  // quantity is untouched unless explicitQuantity says otherwise.
  continuationIndex?: number;
  // Reconciler-only entry point: locate the line by identity and apply
  // `forceQuantity` (an unconditional set — may shrink, unlike
  // explicitQuantity's grow-only rule) or no-op. Creates nothing, touches no
  // field but quantity. The reconciler corrects the AGGREGATE quantity
  // effect of a turn's proposals on lines its own upstream writers already
  // created — it must never originate a line from nothing.
  quantityOnly?: boolean;
  forceQuantity?: number;
  // Diagnostics only ("legacy" | "compiled" | "bundle" | "reconciler" |
  // "guard19_revert" | ...) — never read for any decision.
  source: string;
}

function identityOptionsFor(
  options: Record<string, string[]> | undefined,
  modifiers: string[] | undefined,
  unverifiedRequests: string[] | undefined,
): Record<string, string[]> {
  const merged: Record<string, string[]> = { ...(options ?? {}) };
  if (modifiers && modifiers.length > 0) merged.__modifiers = [...modifiers].sort();
  if (unverifiedRequests && unverifiedRequests.length > 0) merged.__unverified_requests = [...unverifiedRequests].sort();
  return merged;
}

/**
 * Read-only: locate an existing line for this identity. Exported so a caller
 * that needs to inspect (never mutate) current state before deciding what to
 * ask writeCartLine for — e.g. merging a new unverified_request into an
 * existing line's list rather than replacing it — never has to re-derive the
 * identity rule itself.
 */
export function findCartLineIndexByIdentity(
  cart: ReconcilerCartLine[],
  menuItemId: string,
  options?: Record<string, string[]>,
  modifiers?: string[],
  unverifiedRequests?: string[],
): number {
  const key = identityKey(menuItemId, identityOptionsFor(options, modifiers, unverifiedRequests));
  return cart.findIndex(l => {
    if (typeof l.menu_item_id !== "string") return false;
    const lo = l as { options?: Record<string, string[]>; modifiers?: string[]; unverified_requests?: string[] };
    return identityKey(l.menu_item_id, identityOptionsFor(lo.options, lo.modifiers, lo.unverified_requests)) === key;
  });
}

/**
 * Creates or modifies exactly one cart line. See this section's header
 * comment for why this is the only function in the codebase allowed to.
 */
export function writeCartLine(cart: ReconcilerCartLine[], input: WriteCartLineInput): WriteCartLineResult {

  if (input.continuationIndex !== undefined && input.continuationIndex >= 0) {
    const line = cart[input.continuationIndex] as Record<string, unknown>;
    if (input.name !== undefined) line.name = input.name;
    if (input.price_cents !== undefined) line.price_cents = input.price_cents;
    line.options = input.options;
    if (input.modifiers !== undefined) line.modifiers = input.modifiers;
    if (input.option_group_ids !== undefined) line.option_group_ids = input.option_group_ids;
    line.pending_options = input.pending_options;
    line.unverified_requests = input.unverified_requests;
    line.ask_plan_selections = input.ask_plan_selections;
    if (input.sourcePhraseIndex !== undefined) line.sourcePhraseIndex = input.sourcePhraseIndex;
    const preQty = (line.quantity as number) ?? 1;
    let finalQty = preQty;
    // PO 2026-09-13 (x15/$331.50 live incident): a "relative" delta here used
    // to apply unconditionally on every call — but explicitQuantity is parsed
    // ONCE from the turn's text and handed to every writeCartLine call the
    // model makes for this line THIS TURN, so a relative delta restacked once
    // per call instead of once per turn (one "add another" became sixteen).
    // The absolute branch's `> preQty` check is what makes a repeat call a
    // no-op; there is no way to make an unconditional `preQty + delta` add
    // safe to call more than once, so relative deltas are no longer legal
    // input here at all — see WriteCartLineInput.explicitQuantity's doc.
    // Every caller with an "add N more" instruction must resolve it to an
    // absolute target BEFORE calling, against the identity's PRE-TURN
    // quantity (see index.ts's preTurnCartForIdentity), not this line's
    // current (possibly already-grown-this-turn) quantity.
    if (input.explicitQuantity?.kind === "absolute" && input.explicitQuantity.value > preQty) finalQty = input.explicitQuantity.value;
    line.quantity = finalQty;
    return { index: input.continuationIndex, action: "continued" };
  }

  const idx = findCartLineIndexByIdentity(cart, input.menu_item_id, input.options, input.modifiers, input.unverified_requests);

  if (input.quantityOnly) {
    if (idx < 0) return { index: -1, action: "noop_missing" };
    const preQty = (cart[idx].quantity as number) ?? 1;
    const finalQty = input.forceQuantity ?? preQty;
    cart[idx].quantity = finalQty;
    return { index: idx, action: finalQty !== preQty ? "qty_grown" : "merged_noop" };
  }

  if (idx >= 0) {
    const line = cart[idx] as Record<string, unknown>;
    if (input.name !== undefined) line.name = input.name;
    if (input.price_cents !== undefined) line.price_cents = input.price_cents;
    line.options = input.options;
    if (input.modifiers !== undefined) line.modifiers = input.modifiers;
    if (input.option_group_ids !== undefined) line.option_group_ids = input.option_group_ids;
    line.pending_options = input.pending_options;
    line.unverified_requests = input.unverified_requests;
    line.ask_plan_selections = input.ask_plan_selections;
    if (input.sourcePhraseIndex !== undefined) line.sourcePhraseIndex = input.sourcePhraseIndex;
    const preQty = (line.quantity as number) ?? 1;
    let finalQty = preQty;
    // See the continuationIndex branch above for why relative deltas are no
    // longer legal input at this layer (PO 2026-09-13, x15/$331.50 incident).
    if (input.explicitQuantity?.kind === "absolute" && input.explicitQuantity.value > preQty) finalQty = input.explicitQuantity.value;
    line.quantity = finalQty;
    return { index: idx, action: finalQty !== preQty ? "qty_grown" : "merged_noop" };
  }

  let quantity = input.quantity ?? 1;
  if (input.explicitQuantity?.kind === "absolute") quantity = input.explicitQuantity.value;
  else if (input.explicitQuantity?.kind === "relative") quantity = quantity + input.explicitQuantity.delta;
  cart.push({
    menu_item_id: input.menu_item_id,
    name: input.name,
    price_cents: input.price_cents,
    quantity,
    options: input.options,
    modifiers: input.modifiers ?? [],
    option_group_ids: input.option_group_ids,
    pending_options: input.pending_options,
    unverified_requests: input.unverified_requests,
    ask_plan_selections: input.ask_plan_selections,
    sourcePhraseIndex: input.sourcePhraseIndex,
  } as unknown as ReconcilerCartLine);
  return { index: cart.length - 1, action: "created" };
}

export interface WriteBundleLineInput {
  name: string;
  target: number;
  price_cents: number;
  source: string;
}

/**
 * Bundles (start_bundle) have no menu_item_id/options identity — the caller
 * already guards against a second concurrent bundle before calling this, so
 * this is always a plain append. Lives here (not at the call site) for the
 * same reason writeCartLine does: exactly one function is allowed to put an
 * entry into a cart array.
 */
export function writeBundleLine(cart: ReconcilerCartLine[], input: WriteBundleLineInput): WriteCartLineResult {
  cart.push({
    type: "bundle",
    name: input.name,
    target: input.target,
    price_cents: input.price_cents,
    selections: [],
    complete: false,
  } as unknown as ReconcilerCartLine);
  return { index: cart.length - 1, action: "created" };
}

/**
 * Whole-array cart replacement (a full-turn revert, or installing the
 * reconciler's corrected cart) — mutates `cart` in place (length reset +
 * push) so a caller holding a live reference (e.g. index.ts's `guardCart`,
 * which IS `cart.cart_json`) sees the replacement without reassignment.
 */
export function applyCartSnapshot(cart: ReconcilerCartLine[], snapshot: ReconcilerCartLine[]): void {
  cart.length = 0;
  cart.push(...snapshot);
}

/**
 * Removes exactly one line by index (remove_item, cancel_bundle, GUARD 7
 * rollback, the reconciler's own phantom-drop). The remove counterpart to
 * writeCartLine — same reasoning: exactly one function is allowed to take an
 * entry out of a cart array, so a future removal site can't reintroduce a
 * bespoke splice with its own (possibly wrong) index math.
 */
export function removeCartLine(cart: ReconcilerCartLine[], index: number): boolean {
  if (index < 0 || index >= cart.length) return false;
  cart.splice(index, 1);
  return true;
}

/** Empties a cart array in place (clear_cart). */
export function clearCart(cart: ReconcilerCartLine[]): void {
  cart.length = 0;
}

/**
 * Inserts a line immediately after `afterIndex` — the D1 quantity-split
 * create (splitting `quantity: N` into one modified unit plus a leftover
 * line). Still just a positional insert; the caller (ask-plan-engine.ts) is
 * responsible for checking whether an identical split-off line already
 * exists elsewhere and merging into it instead of calling this a second time
 * — a raw splice here would otherwise reintroduce a duplicate line by a
 * different door than the one writeCartLine's identity check already closed.
 */
export function writeSplitCartLine(cart: ReconcilerCartLine[], afterIndex: number, line: ReconcilerCartLine): void {
  cart.splice(afterIndex + 1, 0, line);
}

export interface ReconcileChange {
  menu_item_id: string;
  action: "added" | "qty_set" | "noop_reconfirm" | "dropped_unauthorized";
  qty?: number;
}

// (2026-09-14, item G instrumentation) One entry per proposal group this
// turn, regardless of outcome — captures exactly why each group did or
// didn't match a pre-turn line, so a live `dropped_unauthorized` firing can
// be reconstructed after the fact without having to catch it live in a
// debugger. This file stays pure (plain data out, still no I/O) — the
// caller (index.ts) is responsible for persisting these via error-log.ts
// when it sees an interesting action.
export interface ReconcileDiagnostic {
  menu_item_id: string;
  key: string;
  group: CartUnitProposal[];
  anyGrounded: boolean;
  preTurnLineByFullIdentity: ReconcilerCartLine | null;
  preTurnLineByPendingFallback: ReconcilerCartLine | null;
  preTurnLineByAnyStateFallback: ReconcilerCartLine | null;
  action: ReconcileChange["action"] | "line_missing_in_loop_final";
}

export interface ReconcileOutcome {
  cart: ReconcilerCartLine[];
  changes: ReconcileChange[];
  diagnostics: ReconcileDiagnostic[];
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
  const diagnostics: ReconcileDiagnostic[] = [];

  if (proposals.length === 0) return { cart, changes, diagnostics };

  const preIndex = new Map<string, ReconcilerCartLine>();
  for (const l of preTurnCart) preIndex.set(identityKey(l.menu_item_id, l.options), l);

  // (2026-09-14, cheeseburger/Temp live canary failure) A pre-turn line
  // that still had a required slot open (pending_options non-empty) has an
  // identity that is, by definition, about to change the instant that slot
  // gets filled — "no options yet" -> "Temp: Medium" is not a new order,
  // it's the SAME order finishing. `preIndex` above is keyed on the FULL
  // identity (menu_item_id + options), so a proposal reporting the
  // NOW-RESOLVED options for that same line can never match its own
  // pre-turn entry there. Combined with a bare answer like "medium" naming
  // no menu item at all (so `grounded` below is false for it), that
  // mismatch used to fall through to the "genuinely new, unauthorized"
  // branch and delete the entire line — the customer's whole order,
  // vanished on the turn that only ever answered a question the bot itself
  // asked. This mirrors applyCompiledAddItem's own continuationIdx
  // concept (ask-plan-engine.ts) — matching an in-progress line by
  // menu_item_id alone while it still has an open slot — which the
  // reconciler has no visibility into on its own; this index gives it the
  // same fact. Fallback only (checked when the full-identity lookup
  // misses), and only for a line that was genuinely still pending before
  // this turn, so a normal "same item, different real order" case is
  // untouched.
  const prePendingByMenuItemId = new Map<string, ReconcilerCartLine>();
  for (const l of preTurnCart) {
    if ((l.pending_options ?? []).length > 0 && !prePendingByMenuItemId.has(l.menu_item_id)) {
      prePendingByMenuItemId.set(l.menu_item_id, l);
    }
  }

  // (2026-09-14, PO addendum — 3 live canary captures via the diagnostics
  // above) The pending-only fallback above still missed cases where a
  // pre-turn line existed under SOME other option state that wasn't
  // "still pending" either — full match, empty options, anything. A
  // `dropped_unauthorized` firing is only ever supposed to catch a line
  // GENUINELY CREATED THIS TURN with zero prior existence; if any pre-turn
  // line shares this menu_item_id at all, this is an update to an existing
  // order, never a phantom add, regardless of what this turn's own text
  // grounds. Asymmetry: keeping an unrequested line is visible and
  // correctable; silently deleting a requested one is neither — when in
  // doubt, keep. This subsumes prePendingByMenuItemId (every pending line
  // is also "any state"); both fallbacks are kept so the diagnostics below
  // can show exactly which one resolved a given firing.
  const prePresentByMenuItemId = new Map<string, ReconcilerCartLine>();
  for (const l of preTurnCart) {
    if (!prePresentByMenuItemId.has(l.menu_item_id)) prePresentByMenuItemId.set(l.menu_item_id, l);
  }

  const groups = new Map<string, CartUnitProposal[]>();
  for (const p of proposals) {
    const key = identityKey(p.menu_item_id, p.options);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  for (const [key, group] of groups) {
    // (2026-09-13, single-writer architecture) There is no dedup step here
    // any more, by construction: writeCartLine is the only function that
    // ever creates or modifies a cart line, and it is idempotent on identity
    // — a turn's proposals can never resolve to more than one array entry
    // for the same menu_item_id+options in the first place, so there is
    // nothing left to collapse. (The array-wide "collapse every matching
    // line down to one" backstop this file used to run here was deleted
    // 2026-09-13 — it existed only to clean up after multiple writers, and
    // summing quantities across what it assumed were duplicates is exactly
    // what turned a sibling defect into sixteen pizzas the same day. See
    // supabase/functions/chat-sms/enforce-single-cart-writer.test.ts.)
    const lineIdx = cart.findIndex(l => identityKey(l.menu_item_id, l.options) === key);
    if (lineIdx < 0) {
      // The line this group refers to no longer exists in loopFinalCart —
      // e.g. a later remove_item this same turn deleted it. Nothing to
      // reconcile; the removal wins.
      diagnostics.push({
        menu_item_id: key.split("::")[0], key, group, anyGrounded: group.some(p => p.grounded),
        preTurnLineByFullIdentity: preIndex.get(key) ?? null,
        preTurnLineByPendingFallback: prePendingByMenuItemId.get(key.split("::")[0]) ?? null,
        preTurnLineByAnyStateFallback: prePresentByMenuItemId.get(key.split("::")[0]) ?? null,
        action: "line_missing_in_loop_final",
      });
      continue;
    }

    // Explicit multiplicity: check each proposal's own source phrase first
    // (scoped, so "two cokes" can't bleed onto a different item proposed in
    // the same turn); fall back to the whole message ONLY when this is the
    // sole distinct item proposed this turn, so a number elsewhere in a
    // multi-item message is never misattributed.
    let explicit: ExplicitQuantity = null;
    for (const p of group) {
      // PO 2026-09-13 ($336-$341 live incidents, reproduced 1-in-6): a
      // proposal's source_phrase is supplied by the MODEL and is frequently the
      // resolved menu item's own name, not the customer's words. Vito's item is
      // `Cheese - Large (16")` — parseExplicitQuantity's bare-number branch read
      // the 16-INCH SIZE as a quantity of sixteen and forced the line to x16.
      // That is why the failure was always exactly 16 for that pizza, why it
      // fired on turns containing no number at all ("yes"), and why it looked
      // non-deterministic: it depended purely on what the model happened to put
      // in source_phrase.
      //
      // A quantity may only ever come from something the customer actually
      // said. If the phrase is not present in their message, it is our own text
      // and carries no count.
      if (!p.source_phrase) continue;
      const inCustomerWords =
        customerMessageText.toLowerCase().includes(p.source_phrase.toLowerCase().trim());
      if (!inCustomerWords) continue;
      const fromPhrase = parseExplicitQuantity(p.source_phrase);
      if (fromPhrase) { explicit = fromPhrase; break; }
    }
    if (!explicit && groups.size === 1) {
      explicit = parseExplicitQuantity(customerMessageText);
    }

    const preTurnLineByFullIdentity = preIndex.get(key) ?? null;
    const preTurnLineByPendingFallback = prePendingByMenuItemId.get(cart[lineIdx].menu_item_id) ?? null;
    const preTurnLineByAnyStateFallback = prePresentByMenuItemId.get(cart[lineIdx].menu_item_id) ?? null;
    const existingPre = preTurnLineByFullIdentity ?? preTurnLineByPendingFallback ?? preTurnLineByAnyStateFallback;
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
      writeCartLine(cart, {
        menu_item_id: cart[lineIdx].menu_item_id, options: cart[lineIdx].options,
        quantityOnly: true, forceQuantity: finalQty, source: "reconciler",
      });
      const action = finalQty !== preQty ? "qty_set" : "noop_reconfirm";
      changes.push(
        action === "qty_set"
          ? { menu_item_id: cart[lineIdx].menu_item_id, action, qty: finalQty }
          : { menu_item_id: cart[lineIdx].menu_item_id, action, qty: preQty },
      );
      diagnostics.push({
        menu_item_id: cart[lineIdx].menu_item_id, key, group, anyGrounded: group.some(p => p.grounded),
        preTurnLineByFullIdentity, preTurnLineByPendingFallback, preTurnLineByAnyStateFallback, action,
      });
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
        removeCartLine(cart, lineIdx);
        changes.push({ menu_item_id: key.split("::")[0], action: "dropped_unauthorized" });
        diagnostics.push({
          menu_item_id: key.split("::")[0], key, group, anyGrounded,
          preTurnLineByFullIdentity, preTurnLineByPendingFallback, preTurnLineByAnyStateFallback,
          action: "dropped_unauthorized",
        });
        continue;
      }
      let finalQty = 1;
      if (explicit?.kind === "absolute") finalQty = explicit.value;
      else if (explicit?.kind === "relative") finalQty = 1 + explicit.delta;
      writeCartLine(cart, {
        menu_item_id: cart[lineIdx].menu_item_id, options: cart[lineIdx].options,
        quantityOnly: true, forceQuantity: finalQty, source: "reconciler",
      });
      changes.push({ menu_item_id: cart[lineIdx].menu_item_id, action: "added", qty: finalQty });
      diagnostics.push({
        menu_item_id: cart[lineIdx].menu_item_id, key, group, anyGrounded,
        preTurnLineByFullIdentity, preTurnLineByPendingFallback, preTurnLineByAnyStateFallback, action: "added",
      });
    }
  }

  return { cart, changes, diagnostics };
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
