// C1 regression (2026-09-12, docs/DEFECT-CLASSES.md §C1): option_group name is not a
// stable identity — an owner can rename "Sauce" to "Dipping Sauce" at any time. Tests
// here drive the two failure modes that produced the original P0 (double charge on
// rename, silently-lost selection) and a third: a pending-required-group that can never
// be answered once its name drifts.
//
// APPROACH: call executeTool directly (same pattern as addon-clause-and-required-slot-
// 20260912.test.ts). Two turns each: turn 1 uses the PRE-rename menu; turn 2 uses the
// POST-rename menu (the group id is unchanged, only the name changed).

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeTool } from "./index.ts";

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
) {
  return executeTool(
    toolName,
    input,
    cart as any,
    menu as any,
    "cart-x",
    mockSupabase() as any,
    "Test Shop",
    false,
  );
}

// Shared item ids / option-group ids — these NEVER change across the rename.
const ITEM_ID = "wings-1";
const GROUP_ID = "og-sauce";

const CHOICES = [
  { id: "c-ranch", name: "Ranch", price_cents: 50, is_default: false },
  { id: "c-buffalo", name: "Buffalo", price_cents: 0, is_default: false },
];

// The same option group, before and after owner rename.
const GROUP_BEFORE = { id: GROUP_ID, name: "Sauce",        required: true,  min_select: 1, max_select: 1, choices: CHOICES };
const GROUP_AFTER  = { id: GROUP_ID, name: "Dipping Sauce", required: true, min_select: 1, max_select: 1, choices: CHOICES };

function wingsItem(group: typeof GROUP_BEFORE) {
  return {
    id: ITEM_ID,
    name: "Chicken Wings",
    description: null,
    price_cents: 1000,
    category: "Wings",
    modifiers_json: [],
    prompt_for: null,
    option_groups: [group],
    ask_plan: null,
    bot_state: "orderable",
    bot_state_reason: null,
  };
}

// ── Test 1: pending option resolved under renamed group ────────────────────
// Turn 1: add item (required group unanswered → pending). Group name = "Sauce".
// Turn 2: customer answers; live menu now has group renamed to "Dipping Sauce".
// Expected: the pending flag is cleared and price is correct, not stuck-pending.
Deno.test("C1 rename: pending required option is resolved when answered under the group's NEW name", async () => {
  const cart: unknown[] = [];

  // Turn 1 — add item, no sauce chosen yet. Menu uses old name "Sauce".
  const addResult = await callTool("add_item", { menu_item_id: ITEM_ID, quantity: 1 }, cart, [wingsItem(GROUP_BEFORE)]);
  assertEquals(addResult.ok, true, "add_item turn 1 should succeed");

  const line = (cart as any[])[0];
  assertEquals(line.pending_options, ["Sauce"], "required Sauce group should be pending after turn 1");
  assertEquals(line.option_group_ids?.["Sauce"], GROUP_ID, "snapshot should map old name to stable id");

  // Turn 2 — resolve sauce; live menu now calls the group "Dipping Sauce". The
  // model uses the CURRENT menu to fill options, so it passes "Dipping Sauce".
  const resolveResult = await callTool(
    "add_item",
    { menu_item_id: ITEM_ID, quantity: 1, options: { "Dipping Sauce": ["Ranch"] } },
    cart,
    [wingsItem(GROUP_AFTER)],
  );
  assertEquals(resolveResult.ok, true, "add_item turn 2 (resolve pending via renamed group) should succeed");

  // No pending option should remain.
  assertEquals(line.pending_options === undefined || line.pending_options.length === 0, true,
    "pending_options must be cleared after answering the renamed group");

  // Selection should be stored under the CURRENT name.
  assertEquals(line.options?.["Dipping Sauce"], ["Ranch"],
    "resolved selection should be keyed by current group name 'Dipping Sauce'");

  // Price must include the Ranch surcharge (+$0.50 = 50 cents).
  assertEquals(line.price_cents, 1050,
    "price must include the +$0.50 Ranch surcharge even though the group was renamed");
});

// ── Test 2: stored selection preserved after rename, price not zeroed ──────
// Turn 1: add item WITH a sauce choice already resolved. Group name = "Sauce".
// Turn 2: owner renames group to "Dipping Sauce". modify_item changes only quantity.
// Expected: stored Ranch selection is preserved; price still includes +$0.50.
Deno.test("C1 rename: stored option selection is preserved and price correct after group rename on modify_item", async () => {
  const cart: unknown[] = [];

  // Turn 1 — add item with Sauce already chosen.
  await callTool(
    "add_item",
    { menu_item_id: ITEM_ID, quantity: 1, options: { "Sauce": ["Ranch"] } },
    cart,
    [wingsItem(GROUP_BEFORE)],
  );

  const line = (cart as any[])[0];
  assertEquals(line.price_cents, 1050, "price after add_item should be 1000 + 50");
  assertEquals(line.pending_options === undefined || line.pending_options.length === 0, true,
    "Sauce was answered — no pending options after turn 1");

  // Turn 2 — modify quantity only; live menu now uses "Dipping Sauce".
  const modResult = await callTool(
    "modify_item",
    { menu_item_id: ITEM_ID, quantity: 2 },
    cart,
    [wingsItem(GROUP_AFTER)],
  );
  assertEquals(modResult.ok, true, "modify_item with quantity change should succeed");

  // Price must still include Ranch surcharge (1000 + 50 = 1050 base; quantity tracked separately).
  assertEquals(line.price_cents, 1050,
    "stored Ranch surcharge (+50¢) must survive the rename — not silently zeroed on modify");

  // Selection must still exist under its canonicalized (current) name.
  const hasRanch =
    (line.options?.["Dipping Sauce"]?.includes("Ranch") ?? false) ||
    (line.options?.["Sauce"]?.includes("Ranch") ?? false);
  assertEquals(hasRanch, true,
    "Ranch selection must survive the rename — not silently dropped");

  // Group must not re-appear as pending now that it was answered before the rename.
  assertEquals(line.pending_options === undefined || line.pending_options.length === 0, true,
    "answered group must not resurface as pending after rename");
});
