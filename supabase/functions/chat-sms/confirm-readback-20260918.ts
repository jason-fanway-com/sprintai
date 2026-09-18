// Turn Engine — confirm-step read-back (2026-09-18 PO dispatch, Jason
// direct). Same convention as every other open-kind's question renderer
// (renderStepQuestion in ask-plan-engine.ts, renderAmbiguousItemQuestion in
// pending-disambiguation.ts, renderUpsellOfferSentence in upsell-offer-
// 20260914.ts) — its own file, imported into turn-engine.ts's render(),
// which stays the ONLY function that assembles the final reply string
// (this file's gate test: "exactly one `): string {` function signature").
//
// Today's confirm prompt ("All good — confirm?") shows nothing but the
// standing money footer — a dropped or duplicated item goes straight to a
// payment link unseen. This replaces it with a full read-back: every real
// cart line (quantity, name, resolved options, its own price), the order
// type (+ address if delivery) and name, then the SAME money footer
// render() already appends unconditionally after the question (never
// rebuilt or reformatted here — renderLedgerFooter's own call site in
// turn-engine.ts is untouched).
//
// Shown ONCE per confirm cycle: state.openRepeatCount (already computed by
// ask()'s own carry() helper, incrementing only while the SAME question
// stays open turn over turn) is 0 exactly the turn confirm is freshly
// opened, and >0 on every re-ask after that — a decline or a change always
// leaves confirm and re-enters it fresh (repeat count resets to 0 via
// carry()'s own logic), so "shown once per cycle" falls out of that
// existing counter with no new state needed. See turn-engine.ts's own
// "confirm" case in render() for where openRepeatCount gates this.

import { renderItemizedLines, type ItemizedCartLine } from "./itemizer.ts";
import type { RenderContext, TurnEngineCartLine } from "./turn-engine.ts";

const CONFIRM_READBACK_LIGHT_LINE =
  "Here's what I've got - I'm a bot and I sometimes get things wrong, so give it a look:";
const CONFIRM_READBACK_QUESTION = "All good?";
const CONFIRM_READBACK_MAX_CHARS = 480;
// A sentinel no real item name, address, or customer name could ever
// contain — signals "send this as two separate SMS messages" to whatever
// layer actually dispatches the outbound text. That dispatch wiring is
// out of this module's scope (turn-engine.ts never sends anything); this
// is the seam a caller splits on. Never shown to a customer.
export const CONFIRM_READBACK_SPLIT_MARKER = "  SMS_SPLIT  ";

// A cart line the way the rest of turn-engine.ts already tests "is this a
// real item" (typeof menu_item_id === "string") — duplicated rather than
// imported: turn-engine.ts's own isRealCartLine is a private, unexported
// helper, and this is the one place outside that file needing the same
// one-line check.
function isRealCartLine(line: TurnEngineCartLine): boolean {
  return typeof (line as { menu_item_id?: unknown }).menu_item_id === "string";
}

function confirmReadbackOrderInfoLine(
  orderType: "pickup" | "delivery" | undefined,
  pickupName: string | undefined,
  deliveryAddress: string | undefined,
): string | null {
  const location = orderType === "delivery"
    ? `Delivery${deliveryAddress ? ` to ${deliveryAddress}` : ""}`
    : orderType === "pickup"
    ? "Pickup"
    : null;
  if (!location) return null;
  return pickupName ? `${location}, name ${pickupName}.` : `${location}.`;
}

// Every real cart line + order info + the question, as an ARRAY of atomic
// lines (never joined-then-split) — the split step below packs whole
// lines onto page 1 or 2, so an item is never cut mid-line.
function confirmReadbackLines(
  cartAfter: TurnEngineCartLine[],
  context: RenderContext,
  includeOptions: boolean,
): string[] {
  const realLines = cartAfter.filter(isRealCartLine) as unknown as ItemizedCartLine[];
  const itemLines = renderItemizedLines(realLines, context.priceIndexByMenuItemId, includeOptions)
    .split("\n")
    .filter(l => l.length > 0);
  const orderInfo = confirmReadbackOrderInfoLine(context.orderType, context.pickupName, context.deliveryAddress);
  return [CONFIRM_READBACK_LIGHT_LINE, ...itemLines, ...(orderInfo ? [orderInfo] : []), CONFIRM_READBACK_QUESTION];
}

export function buildConfirmReadback(cartAfter: TurnEngineCartLine[], context: RenderContext): string {
  const withOptions = confirmReadbackLines(cartAfter, context, true);
  if (withOptions.join("\n").length <= CONFIRM_READBACK_MAX_CHARS) return withOptions.join("\n");

  // SMS length: rule 1 — drop the options parentheses, keep every line.
  const withoutOptions = confirmReadbackLines(cartAfter, context, false);
  if (withoutOptions.join("\n").length <= CONFIRM_READBACK_MAX_CHARS) return withoutOptions.join("\n");

  // Rule 2 — still over: split into two messages. Greedy packing, whole
  // lines only, never truncated and never dropped — once page 1 is full,
  // every remaining line (items included) goes to page 2 regardless of
  // page 2's own length; this dispatch splits into two, never more.
  const page1: string[] = [];
  const page2: string[] = [];
  let used = 0;
  let splitting = false;
  for (const line of withoutOptions) {
    const cost = line.length + (page1.length > 0 ? 1 : 0);
    if (!splitting && used + cost <= CONFIRM_READBACK_MAX_CHARS) {
      page1.push(line);
      used += cost;
    } else {
      splitting = true;
      page2.push(line);
    }
  }
  if (page2.length === 0) return page1.join("\n");
  return `${page1.join("\n")}${CONFIRM_READBACK_SPLIT_MARKER}${page2.join("\n")}`;
}
