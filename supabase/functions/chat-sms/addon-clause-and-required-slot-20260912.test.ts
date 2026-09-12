// Regression coverage for two live NJB bugs (2026-09-12, deadline 16:07 ET):
//
//   Bug 1 — a single customer message with two add-on clauses ("add bacon
//   and add extra cheese") produced two separate modify_item tool calls in
//   the SAME assistant turn; the legacy modify_item handler treated each
//   call's `modifiers` array as the complete replacement state, so the
//   second call silently erased whatever the first call had just added.
//   Root cause: index.ts's legacy modify_item branch had no memory of an
//   earlier same-turn modify_item call for the same line. Fixed by tracking
//   which menu_item_ids have already been modified this turn
//   (modifyItemMergeKeysThisTurn) and merging (not replacing) every call
//   after the first.
//
//   Bug 2 — a required-slot (`prompt_for`) question's answer ("wheat" for
//   "white or wheat bread?") was only ever captured as a free-text
//   unverified_requests entry, never as a structured CartItem.options
//   selection, and nothing gated checkout on it being unanswered. Fixed by
//   routing a prompt_for item's answer into `options` (keyed by the
//   prompt_for question text, the slot's one stable name) in both add_item
//   and modify_item, and by pushing that same key into `pending_options`
//   when unanswered — which submit_order's existing pending_options gate
//   already blocks checkout on.
//
// executeTool is exported specifically so this logic — the deterministic
// cart-mutation core — is testable without booting the Deno.serve listener
// or a real Supabase/Stripe connection; see its export-site comment.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeTool } from "./index.ts";

// ── Minimal mock Supabase client ────────────────────────────────────────
// executeTool's add_item/modify_item paths only ever call
// `.from("order_carts").update({...}).eq("id", cartId)` (via saveCart, for
// phase="building" — never "checkout" in these tests, so the
// select(...).single() branch is never reached). submit_order's
// pending_options gate returns before touching Supabase or Stripe at all,
// so no further mocking is needed for the checkout-block test.
function mockSupabase() {
  return {
    from(_table: string) {
      return {
        update(_values: Record<string, unknown>) {
          return { eq(_col: string, _val: unknown) { return Promise.resolve({ error: null, data: null }); } };
        },
        select(_cols: string) {
          return { eq(_col: string, _val: unknown) { return { single: () => Promise.resolve({ data: null, error: null }) }; } };
        },
      };
    },
  };
}

function callTool(
  toolName: string,
  input: Record<string, unknown>,
  cart: unknown[],
  menu: unknown[],
  supabase: unknown,
  opts: { modifyItemMergeKeysThisTurn?: Set<string>; customerMessage?: string } = {},
) {
  return executeTool(
    toolName,
    input,
    cart as any,
    menu as any,
    "cart-1",
    supabase as any,
    "Test Shop",
    false,
    undefined,
    undefined,
    undefined,
    opts.customerMessage,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    opts.modifyItemMergeKeysThisTurn,
  );
}

const SANDWICH_ITEM = {
  id: "sub-1",
  name: "Turkey Sub",
  description: null,
  price_cents: 900,
  category: "Subs",
  modifiers_json: [
    { name: "Bacon", price_cents: 150 },
    { name: "Extra Cheese", price_cents: 100 },
  ],
  prompt_for: null,
  option_groups: [],
  ask_plan: null,
  bot_state: "orderable",
  bot_state_reason: null,
};

const BAGEL_ITEM = {
  id: "bagel-1",
  name: "Bagel",
  description: null,
  price_cents: 300,
  category: "Bagels",
  modifiers_json: [],
  prompt_for: "White or wheat bread?",
  option_groups: [],
  ask_plan: null,
  bot_state: "orderable",
  bot_state_reason: null,
};

// ── (a) Bug 1: two add-on clauses in one message, both land on the cart ──
Deno.test("modify_item: two add-on clauses in the same turn both land on the cart line", async () => {
  const cart = [{ menu_item_id: "sub-1", name: "Turkey Sub", quantity: 1, price_cents: 900, modifiers: [] as string[] }];
  const menu = [SANDWICH_ITEM];
  const supabase = mockSupabase();
  const mergeKeys = new Set<string>();

  // "add bacon and add extra cheese" -> the model emits two modify_item
  // calls in the same assistant turn, each stating only its own clause.
  const r1 = await callTool("modify_item", { menu_item_id: "sub-1", modifiers: ["Bacon"] }, cart, menu, supabase, { modifyItemMergeKeysThisTurn: mergeKeys });
  assert(r1.ok, `first modify_item call ("add bacon") failed: ${JSON.stringify(r1.result)}`);
  const r2 = await callTool("modify_item", { menu_item_id: "sub-1", modifiers: ["Extra Cheese"] }, cart, menu, supabase, { modifyItemMergeKeysThisTurn: mergeKeys });
  assert(r2.ok, `second modify_item call ("add extra cheese") failed: ${JSON.stringify(r2.result)}`);

  const line = cart[0];
  assert(line.modifiers.includes("Bacon"), `first add-on clause dropped — cart line modifiers: ${JSON.stringify(line.modifiers)}`);
  assert(line.modifiers.includes("Extra Cheese"), `second add-on clause dropped — cart line modifiers: ${JSON.stringify(line.modifiers)}`);
  assertEquals(line.modifiers.length, 2);
});

// A single modify_item call in a turn must still be able to shrink the
// modifiers list — this is how a genuine removal reaches the cart (either
// the model's own single call, or the deterministic option-removal path,
// which always calls modify_item exactly once). The same-turn merge fix
// must not turn every modify_item call into a union that can never remove
// anything.
Deno.test("modify_item: a lone same-turn call can still remove a modifier (no false merge)", async () => {
  const cart = [{ menu_item_id: "sub-1", name: "Turkey Sub", quantity: 1, price_cents: 900, modifiers: ["Bacon", "Extra Cheese"] }];
  const menu = [SANDWICH_ITEM];
  const supabase = mockSupabase();
  const mergeKeys = new Set<string>();

  const r = await callTool("modify_item", { menu_item_id: "sub-1", modifiers: ["Bacon"] }, cart, menu, supabase, { modifyItemMergeKeysThisTurn: mergeKeys });
  assert(r.ok, `modify_item removal call failed: ${JSON.stringify(r.result)}`);
  assertEquals(cart[0].modifiers, ["Bacon"]);
});

// ── (b) Bug 2: a required-slot answer becomes a structured modifier ──────
Deno.test("add_item: an answered required-slot (prompt_for) question lands as a structured option, not just notes", async () => {
  const cart: unknown[] = [];
  const menu = [BAGEL_ITEM];
  const supabase = mockSupabase();

  const r = await callTool(
    "add_item",
    { menu_item_id: "bagel-1", quantity: 1, options: { "Bread Type": ["Wheat"] }, source_phrase: "a bagel" },
    cart,
    menu,
    supabase,
    { customerMessage: "I'll get a bagel, wheat please" },
  );
  assert(r.ok, `add_item failed: ${JSON.stringify(r.result)}`);

  const line = cart[0] as { options?: Record<string, string[]>; pending_options?: string[]; unverified_requests?: string[] };
  assertEquals(line.options, { "White or wheat bread?": ["Wheat"] });
  assertEquals(line.pending_options, undefined, "an answered required slot must not still be pending");
  assertEquals(line.unverified_requests, undefined, "an answered required slot must not be routed to free-text unverified_requests/notes");
});

// ── (c) New gate: checkout blocked while a required slot is unresolved ───
Deno.test("submit_order: blocked while a cart line still has an unresolved required slot, and re-prompts", async () => {
  const cart: unknown[] = [];
  const menu = [BAGEL_ITEM];
  const supabase = mockSupabase();

  // Customer orders the bagel but never answers "white or wheat?".
  const addResult = await callTool(
    "add_item",
    { menu_item_id: "bagel-1", quantity: 1, source_phrase: "a bagel" },
    cart,
    menu,
    supabase,
    { customerMessage: "I'll get a bagel" },
  );
  assert(addResult.ok, `add_item failed: ${JSON.stringify(addResult.result)}`);
  const line = cart[0] as { pending_options?: string[] };
  assertEquals(line.pending_options, ["White or wheat bread?"], "unanswered required slot must be marked pending");

  const submitResult = await callTool(
    "submit_order",
    { pickup_name: "Jason" },
    cart,
    menu,
    supabase,
  );
  assertEquals(submitResult.ok, false, "checkout must not finalize while a required slot is unresolved");
  const result = submitResult.result as { error?: string; pending?: Array<{ name: string; missingGroups: string[] }> };
  assert(result.error?.toLowerCase().includes("cannot submit"), `expected a re-prompt/block error, got: ${JSON.stringify(result)}`);
  assert(result.pending?.some(p => p.missingGroups.includes("White or wheat bread?")), `pending detail must name the unresolved slot: ${JSON.stringify(result.pending)}`);
});

// Once the slot is answered, checkout's pending gate must clear (the gate
// targets the unresolved slot specifically, not the item forever).
Deno.test("submit_order: no longer blocked once the required slot is answered via modify_item", async () => {
  const cart = [{ menu_item_id: "bagel-1", name: "Bagel", quantity: 1, price_cents: 300, modifiers: [] as string[], pending_options: ["White or wheat bread?"] }];
  const menu = [BAGEL_ITEM];
  const supabase = mockSupabase();

  const modResult = await callTool(
    "modify_item",
    { menu_item_id: "bagel-1", options: { "Bread Type": ["Wheat"] } },
    cart,
    menu,
    supabase,
  );
  assert(modResult.ok, `modify_item (answering the slot) failed: ${JSON.stringify(modResult.result)}`);
  assertEquals((cart[0] as { pending_options?: string[] }).pending_options, undefined);

  const submitResult = await callTool("submit_order", { pickup_name: "Jason" }, cart, menu, supabase);
  // The Stripe key lookup is the next gate after pending_options — with no
  // STRIPE_SECRET_KEY in this test environment it fails there, which is
  // sufficient proof the pending_options gate itself no longer blocks.
  const result = submitResult.result as { error?: string };
  assert(
    !result.error?.toLowerCase().includes("cannot submit yet"),
    `pending_options gate should have cleared, got: ${JSON.stringify(result)}`,
  );
});
