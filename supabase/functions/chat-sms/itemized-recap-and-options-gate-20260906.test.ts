// FIX (2026-09-06, Jason): two related checkout-path bugs, plus a new
// itemized recap.
//
// Bug 1 — GUARD 2 asked for the pickup name unconditionally on any order
// confirmation, even when a cart line still had an unresolved REQUIRED
// option group (e.g. dressing on a sandwich). The customer got asked their
// name instead of being re-asked the one thing actually blocking checkout.
//
// Bug 2 — D1 (the checkout-completion driver) called submit_order and, on
// ANY failure, replaced the reply with a hardcoded "Almost there — let me
// just confirm your order details first. One moment!" — discarding
// submit_order's own specific error and using a phrase the system prompt's
// own banned-phrase list explicitly forbids (index.ts line ~722).
//
// New feature — a deterministic itemized recap. FIRST VERSION (commit
// 7745171) put this inline inside GUARD 2's own reply — but Jason's live
// test (2026-09-06 19:37) showed the model asks for the pickup name on its
// OWN initiative far more often than GUARD 2 has to force it (GUARD 2 is
// only a backstop), so the recap never appeared on the common path. FIXED:
// the recap now lives in Phase A (index.ts, runs on every reply once the
// cart has items), which fires whenever the CURRENT reply asks for the
// pickup name — regardless of whether GUARD 2 or the model composed it. It
// is also a full priced receipt now (line items + subtotal + fee + total),
// not just names — Jason's exact ask: "Luca only caught a $37 error because
// he happened to read a number."
//
// These are pure functions, copied here verbatim from index.ts (which has
// no exports — it is a Deno.serve entrypoint), matching the convention
// already used by reply-punctuation.test.ts and
// guard9-unconsented-affirmation-add-20260906.test.ts in this same
// directory. Wiring into the real guard blocks is checked separately below
// via source-text assertions against the live file.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

// ── Copied verbatim from index.ts ──────────────────────────────────────────

interface CartItem {
  menu_item_id: string;
  name: string;
  quantity: number;
  price_cents: number;
  modifiers: string[];
  options?: Record<string, string[]>;
  pending_options?: string[];
}

interface BundleItem {
  type: "bundle";
  name: string;
  target: number;
  price_cents: number;
  selections: Array<{ flavor: string; quantity: number }>;
  complete: boolean;
}

type AnyCartItem = CartItem | BundleItem;

const SERVICE_FEE_CENTS = 99;

function padReceiptLine(label: string, amount: string, width = 38): string {
  const gap = Math.max(1, width - label.length - amount.length);
  return `${label}${" ".repeat(gap)}${amount}`;
}

function renderItemizedRecap(cart: AnyCartItem[], deliveryFeeCents?: number, driverTipCents?: number): string {
  const lines: string[] = [];
  let subtotal = 0;
  for (const i of cart) {
    if ((i as BundleItem).type === "bundle") {
      const b = i as BundleItem;
      if (!b.complete) continue;
      subtotal += b.price_cents;
      const detail = b.selections.map(s => `${s.quantity}x ${s.flavor}`).join(", ");
      lines.push(padReceiptLine(`${b.name}${detail ? ` (${detail})` : ""}`, `$${(b.price_cents / 100).toFixed(2)}`));
      continue;
    }
    const r = i as CartItem;
    const lineTotal = r.price_cents * (r.quantity || 1);
    subtotal += lineTotal;
    const qtyPrefix = (r.quantity || 1) > 1 ? `${r.quantity}x ` : "";
    const detail = r.modifiers?.length > 0
      ? r.modifiers.join(", ")
      : (r.options ? Object.entries(r.options).map(([k, v]) => `${k}: ${v.join(", ")}`).join("; ") : "");
    lines.push(padReceiptLine(`${qtyPrefix}${r.name}${detail ? ` (${detail})` : ""}`, `$${(lineTotal / 100).toFixed(2)}`));
  }
  const totalCents = subtotal + SERVICE_FEE_CENTS + (deliveryFeeCents ?? 0) + (driverTipCents ?? 0);
  lines.push(padReceiptLine("Subtotal", `$${(subtotal / 100).toFixed(2)}`));
  lines.push(padReceiptLine("Service fee", `$${(SERVICE_FEE_CENTS / 100).toFixed(2)}`));
  if (deliveryFeeCents) lines.push(padReceiptLine("Delivery fee", `$${(deliveryFeeCents / 100).toFixed(2)}`));
  if (driverTipCents) lines.push(padReceiptLine("Driver tip", `$${(driverTipCents / 100).toFixed(2)}`));
  lines.push(padReceiptLine("Total", `$${(totalCents / 100).toFixed(2)}`));
  return lines.join("\n");
}

function isAskingForPickupName(text: string): boolean {
  return /\bname\b/i.test(text)
    && /pickup|pick up|under (?:what|which)|who(?:'s| is) (?:this|it) for|order for|(?:for|on) (?:the|this|your) order/i.test(text);
}

// Reconstructs D1's failure-branch decision only (not the whole guard) so it
// can be exercised directly against every submit_order error shape.
function classifyD1Failure(errMsg: string | undefined): string {
  if (errMsg && /still need options chosen/.test(errMsg)) {
    const missing = errMsg
      .replace(/^Cannot submit yet — these items still need options chosen: /, "")
      .replace(/\. Ask the customer.*$/, "");
    return `Almost — I still need to know: ${missing}. What'll it be?`;
  } else if (errMsg && /pickup or delivery/i.test(errMsg)) {
    return "Pickup or delivery today?";
  } else if (errMsg && /delivery address/i.test(errMsg)) {
    return "What's the delivery address?";
  } else if (errMsg && /pickup name is required/i.test(errMsg)) {
    return "Got it! What's your name for the order?";
  } else {
    return errMsg ? `I couldn't finish that — ${errMsg}` : "I couldn't finish that order — let's try again.";
  }
}

const BANNED_PHRASES = ["one moment", "let me check", "give me a sec", "hold on while i"];

function assertNoBannedPhrase(text: string) {
  const lower = text.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    assert(!lower.includes(phrase), `reply must never contain banned phrase "${phrase}" — got: ${text}`);
  }
}

// ── padReceiptLine ──────────────────────────────────────────────────────────

Deno.test("padReceiptLine: pads short label out to the amount at the fixed width", () => {
  assertEquals(padReceiptLine("Subtotal", "$26.99", 20), "Subtotal      $26.99");
});

Deno.test("padReceiptLine: a label that would overflow the width still gets at least one space", () => {
  const out = padReceiptLine("A Very Long Item Name That Overflows", "$1.00", 20);
  assert(out.includes(" $1.00"), `must still separate label from amount: "${out}"`);
});

// ── renderItemizedRecap ─────────────────────────────────────────────────────

Deno.test("renderItemizedRecap: single item shows its own price plus subtotal/fee/total", () => {
  const cart: AnyCartItem[] = [
    { menu_item_id: "1", name: "Fries", quantity: 1, price_cents: 399, modifiers: [] },
  ];
  const out = renderItemizedRecap(cart);
  assert(out.includes("Fries") && out.includes("$3.99"), "must show the line item and its price");
  assert(out.includes("Subtotal") && out.includes("$3.99"), "subtotal must equal the single line item");
  assert(out.includes("Service fee") && out.includes("$0.99"), "service fee must be shown");
  assert(out.includes("Total") && out.includes("$4.98"), "total must be subtotal + service fee");
});

Deno.test("renderItemizedRecap: quantity multiplies the line price, not just the display", () => {
  const cart: AnyCartItem[] = [
    { menu_item_id: "1", name: "Fries", quantity: 3, price_cents: 399, modifiers: [] },
  ];
  const out = renderItemizedRecap(cart);
  assert(out.includes("3x Fries") && out.includes("$11.97"), `3x $3.99 must show as $11.97 line total, got:\n${out}`);
});

Deno.test("renderItemizedRecap: options/modifiers still shown in the parenthetical", () => {
  const cart: AnyCartItem[] = [
    { menu_item_id: "1", name: "Gyro", quantity: 1, price_cents: 1099, modifiers: [], options: { Dressing: ["Tzatziki"] } },
  ];
  const out = renderItemizedRecap(cart);
  assert(out.includes("Gyro (Dressing: Tzatziki)"), `must include the option detail, got:\n${out}`);
});

Deno.test("renderItemizedRecap: multiple items each get their own line, in order", () => {
  const cart: AnyCartItem[] = [
    { menu_item_id: "1", name: "Large Cheese Pizza", quantity: 1, price_cents: 2100, modifiers: [] },
    { menu_item_id: "2", name: "Garlic Knots", quantity: 1, price_cents: 599, modifiers: [] },
  ];
  const out = renderItemizedRecap(cart);
  const lines = out.split("\n");
  assert(lines[0].startsWith("Large Cheese Pizza") && lines[0].includes("$21.00"));
  assert(lines[1].startsWith("Garlic Knots") && lines[1].includes("$5.99"));
  assert(out.includes("Subtotal") && out.includes("$26.99"));
  assert(out.includes("Total") && out.includes("$27.98"), `matches Jason's own worked example ($21.00 + $5.99 + $0.99 = $27.98), got:\n${out}`);
});

Deno.test("renderItemizedRecap: delivery fee and driver tip appear as their own lines when present", () => {
  const cart: AnyCartItem[] = [{ menu_item_id: "1", name: "Fries", quantity: 1, price_cents: 399, modifiers: [] }];
  const out = renderItemizedRecap(cart, 300, 200);
  assert(out.includes("Delivery fee") && out.includes("$3.00"));
  assert(out.includes("Driver tip") && out.includes("$2.00"));
  assert(out.includes("Total") && out.includes("$9.98"), `$3.99 + $0.99 + $3.00 + $2.00 = $9.98, got:\n${out}`);
});

Deno.test("renderItemizedRecap: an incomplete bundle contributes no price (not settled yet)", () => {
  const cart: AnyCartItem[] = [
    { menu_item_id: "1", name: "Fries", quantity: 1, price_cents: 399, modifiers: [] },
    { type: "bundle", name: "Wing Bundle", target: 2, price_cents: 1299, complete: false, selections: [] },
  ];
  const out = renderItemizedRecap(cart);
  assert(!out.includes("Wing Bundle"), "an incomplete bundle must not appear on the receipt");
  assert(out.includes("Subtotal") && out.includes("$3.99"), "subtotal must exclude the incomplete bundle's price");
});

Deno.test("renderItemizedRecap: uses plain text only — no box-drawing characters", () => {
  const cart: AnyCartItem[] = [{ menu_item_id: "1", name: "Fries", quantity: 1, price_cents: 399, modifiers: [] }];
  const out = renderItemizedRecap(cart);
  assert(!/[│┃║─━═┌┐└┘├┤┬┴┼]/.test(out), `must be plain text (reads correctly in an SMS), got:\n${out}`);
});

// ── isAskingForPickupName ────────────────────────────────────────────────────

Deno.test("isAskingForPickupName: matches the literal NAME_ASK phrase", () => {
  assert(isAskingForPickupName("What's your name for the order?"));
});

Deno.test("isAskingForPickupName: matches GUARD 2's plain reply", () => {
  assert(isAskingForPickupName("Got it! What's your name for the order?"));
});

Deno.test("isAskingForPickupName: does not match an unrelated reply that happens to say 'name'", () => {
  assert(!isAskingForPickupName("Sorry, we don't have a menu item by that name."));
});

// ── D1 failure classification ───────────────────────────────────────────────

Deno.test("D1 fix: pending required option re-asks the specific option, not a vague reassurance", () => {
  const errMsg = "Cannot submit yet — these items still need options chosen: Gyro (needs: Dressing). Ask the customer for each missing option, then use modify_item to set them.";
  const reply = classifyD1Failure(errMsg);
  assertEquals(reply, "Almost — I still need to know: Gyro (needs: Dressing). What'll it be?");
  assertNoBannedPhrase(reply);
});

Deno.test("D1 fix: missing order type asks pickup-or-delivery directly", () => {
  const reply = classifyD1Failure("Cannot submit order. Please confirm pickup or delivery first.");
  assertEquals(reply, "Pickup or delivery today?");
  assertNoBannedPhrase(reply);
});

Deno.test("D1 fix: missing delivery address asks for the address directly", () => {
  const reply = classifyD1Failure("Please provide a delivery address first.");
  assertEquals(reply, "What's the delivery address?");
  assertNoBannedPhrase(reply);
});

Deno.test("D1 fix: missing pickup name re-asks the name, not a vague reassurance", () => {
  const reply = classifyD1Failure("Cannot submit order. A pickup name is required — ask the customer for their name first.");
  assertEquals(reply, "Got it! What's your name for the order?");
  assertNoBannedPhrase(reply);
});

Deno.test("D1 fix: an unmapped/unexpected failure is stated honestly, never a vague reassurance", () => {
  const reply = classifyD1Failure("Payment system not configured. Please call the shop directly.");
  assertEquals(reply, "I couldn't finish that — Payment system not configured. Please call the shop directly.");
  assertNoBannedPhrase(reply);
});

Deno.test("D1 fix: no error message at all still avoids the banned reassurance", () => {
  const reply = classifyD1Failure(undefined);
  assertEquals(reply, "I couldn't finish that order — let's try again.");
  assertNoBannedPhrase(reply);
});

// ── Wiring regression guards against the live file ─────────────────────────

function extractBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert(start !== -1, `start marker not found in index.ts: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert(end !== -1, `end marker not found after start in index.ts: ${endMarker}`);
  return source.slice(start, end);
}

Deno.test("GUARD 2 wiring: unresolved required options are checked BEFORE the name-ask branch", () => {
  const block = extractBlock(
    INDEX_SOURCE,
    "// ── Guard 2: order confirmation + no pickup name",
    "// ── Guard 2c: hallucinated total",
  );
  const pendingIdx = block.indexOf("guardPendingItems.length > 0");
  const nameAskIdx = block.indexOf("!hasPickupName && impliesOrderConfirmation");
  assert(pendingIdx !== -1, "GUARD 2 must check guardPendingItems before asking for the name");
  assert(nameAskIdx !== -1, "GUARD 2's name-ask branch must still exist");
  assert(pendingIdx < nameAskIdx, "the pending-options check must appear BEFORE the name-ask branch (it must run first)");
});

Deno.test("GUARD 2 wiring: the name-ask reply is left plain (Phase A owns the receipt, not this guard)", () => {
  const block = extractBlock(
    INDEX_SOURCE,
    "// ── Guard 2: order confirmation + no pickup name",
    "// ── Guard 2c: hallucinated total",
  );
  assert(
    !block.includes("renderItemizedRecap"),
    "GUARD 2 must NOT embed its own recap — Phase A attaches it universally so it appears whether GUARD 2 or the model asked for the name",
  );
});

Deno.test("D1 wiring: the hardcoded banned-phrase fallback is gone, and the success reply includes the priced receipt", () => {
  const block = extractBlock(
    INDEX_SOURCE,
    "// ── D1 (2026-08-29): CHECKOUT COMPLETION DRIVER",
    "// ── Guard 2b: SILENT ORDER-TYPE REVERT",
  );
  assert(
    !block.includes("Almost there — let me just confirm your order details first. One moment!"),
    "D1's old vague, banned-phrase fallback must not still be present",
  );
  assert(block.includes("submitResult.result as { error?: string }"), "D1 must read submit_order's actual error to classify the failure");
  assert(block.includes("renderItemizedRecap(guardCart, guardDeliveryFee, guardDriverTip)"), "D1's success reply must include the priced itemized recap, with fees");
});

Deno.test("Phase A wiring: the itemized recap is attached whenever the CURRENT reply asks for the pickup name, regardless of who composed it", () => {
  const start = INDEX_SOURCE.indexOf("// ── Phase A: Deterministic money/status rendering");
  assert(start !== -1, "Phase A section must exist");
  const end = INDEX_SOURCE.indexOf("\n  }\n", start);
  const block = INDEX_SOURCE.slice(start, end);
  assert(block.includes("isAskingForPickupName(reply)"), "Phase A must check whether THIS TURN's reply is a name-ask");
  assert(block.includes("!hasPickupName"), "Phase A must only attach the receipt when we don't already have a name");
  assert(block.includes("renderItemizedRecap(guardCart, guardDeliveryFee, guardDriverTip)"), "Phase A must attach the priced receipt, with fees, at the name-ask moment");
});

Deno.test("wiring: isAskingForPickupName is shared between C2 (prior-turn check) and Phase A (this-turn check)", () => {
  const occurrences = INDEX_SOURCE.split("function isAskingForPickupName(").length - 1;
  assertEquals(occurrences, 1, "must be defined exactly once, as a single source of truth");
  const c2Start = INDEX_SOURCE.indexOf("// ── C2 (2026-08-29): Pre-LLM name→submit shortcut");
  const c2End = INDEX_SOURCE.indexOf("\n  }\n", c2Start);
  assert(INDEX_SOURCE.slice(c2Start, c2End).includes("isAskingForPickupName(lastAssistant.content)"), "C2 must call the shared helper, not its own inline regex");
});

Deno.test("system prompt still bans 'one moment' (sanity check the rule we're enforcing actually exists)", () => {
  assert(/Banned in every wording:.*one moment/i.test(INDEX_SOURCE.replace(/\n/g, " ")), "the banned-phrase list must still include 'one moment'");
});
