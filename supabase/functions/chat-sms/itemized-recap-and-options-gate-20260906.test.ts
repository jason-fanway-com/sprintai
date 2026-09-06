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
// submit_order's own specific error (which already names the exact missing
// item/option/field) and using a phrase ("one moment") the system prompt's
// own banned-phrase list explicitly forbids (index.ts line ~722). A real
// rejection was hidden behind a friendly non-answer.
//
// New feature — a deterministic itemized recap (line-by-line, with chosen
// options), following the renderLedgerFooter pattern, so the customer sees
// exactly what's in the cart at the moment they're asked to confirm/pay —
// not just a dollar total.
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

function renderItemizedRecap(cart: AnyCartItem[]): string {
  return cart.map(i => {
    if ((i as BundleItem).type === "bundle") {
      const b = i as BundleItem;
      const detail = b.selections.map(s => `${s.quantity}x ${s.flavor}`).join(", ");
      return `1x ${b.name}${detail ? ` (${detail})` : ""}`;
    }
    const r = i as CartItem;
    const detail = r.modifiers?.length > 0
      ? r.modifiers.join(", ")
      : (r.options ? Object.entries(r.options).map(([k, v]) => `${k}: ${v.join(", ")}`).join("; ") : "");
    return `${r.quantity || 1}x ${r.name}${detail ? ` (${detail})` : ""}`;
  }).join(", ");
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

// ── renderItemizedRecap ─────────────────────────────────────────────────────

Deno.test("renderItemizedRecap: single item, no options", () => {
  const cart: AnyCartItem[] = [
    { menu_item_id: "1", name: "Fries", quantity: 2, price_cents: 399, modifiers: [] },
  ];
  assertEquals(renderItemizedRecap(cart), "2x Fries");
});

Deno.test("renderItemizedRecap: item with modifiers", () => {
  const cart: AnyCartItem[] = [
    { menu_item_id: "1", name: "Turkey Club", quantity: 1, price_cents: 999, modifiers: ["no mayo"] },
  ];
  assertEquals(renderItemizedRecap(cart), "1x Turkey Club (no mayo)");
});

Deno.test("renderItemizedRecap: item with option-group choices", () => {
  const cart: AnyCartItem[] = [
    {
      menu_item_id: "1", name: "Gyro", quantity: 1, price_cents: 1099, modifiers: [],
      options: { "Bread Type": ["Pita"], "Dressing": ["Tzatziki"] },
    },
  ];
  assertEquals(renderItemizedRecap(cart), "1x Gyro (Bread Type: Pita; Dressing: Tzatziki)");
});

Deno.test("renderItemizedRecap: multiple lines and a bundle join with commas", () => {
  const cart: AnyCartItem[] = [
    { menu_item_id: "1", name: "Fries", quantity: 1, price_cents: 399, modifiers: [] },
    { type: "bundle", name: "Wing Bundle", target: 2, price_cents: 1299, complete: true, selections: [{ flavor: "BBQ", quantity: 1 }, { flavor: "Buffalo", quantity: 1 }] },
  ];
  assertEquals(renderItemizedRecap(cart), "1x Fries, 1x Wing Bundle (1x BBQ, 1x Buffalo)");
});

Deno.test("renderItemizedRecap: item with neither modifiers nor options has no parenthetical", () => {
  const cart: AnyCartItem[] = [
    { menu_item_id: "1", name: "Soda", quantity: 1, price_cents: 199, modifiers: [], options: {} },
  ];
  assertEquals(renderItemizedRecap(cart), "1x Soda");
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

Deno.test("GUARD 2 wiring: the name-ask reply includes the itemized recap", () => {
  const block = extractBlock(
    INDEX_SOURCE,
    "// ── Guard 2: order confirmation + no pickup name",
    "// ── Guard 2c: hallucinated total",
  );
  assert(block.includes("renderItemizedRecap(guardCart)"), "GUARD 2's name-ask reply must include the itemized recap");
});

Deno.test("D1 wiring: the hardcoded banned-phrase fallback is gone", () => {
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
  assert(block.includes("renderItemizedRecap(guardCart)"), "D1's success reply must include the itemized recap");
});

Deno.test("system prompt still bans 'one moment' (sanity check the rule we're enforcing actually exists)", () => {
  assert(/Banned in every wording:.*one moment/i.test(INDEX_SOURCE.replace(/\n/g, " ")), "the banned-phrase list must still include 'one moment'");
});
