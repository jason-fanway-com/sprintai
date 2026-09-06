// FIX (2026-09-06, Jason): required option groups with a recorded default
// choice (option_choices.is_default, migration 006_option_groups.sql) were
// loaded from the DB into effectiveMenu but never used anywhere — every
// group with no customer-specified selection was left `pending` and the
// model decided ad hoc what to say/assume, inconsistently across otherwise
// identical orders (e.g. which dressing "comes with" a sandwich).
//
// Fix: when a required group has no customer selection AND has exactly one
// choice marked is_default with price_cents === 0, the CODE applies that
// default deterministically at add_item time instead of leaving it to the
// model. A default that costs extra is never auto-applied (no surprise
// charges) — that case still goes to pending and gets asked, unchanged from
// before.
//
// This is a pure decision, copied here verbatim from the add_item handler in
// index.ts (which has no exports — it is a Deno.serve entrypoint), matching
// the convention already used by the other test files in this directory.
// Wiring into the real handler is checked separately via source-text
// assertions against the live file.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

interface OptionChoice {
  id: string;
  name: string;
  price_cents: number;
  is_default: boolean;
}

interface OptionGroup {
  id: string;
  name: string;
  required: boolean;
  min_select: number;
  max_select: number;
  choices: OptionChoice[];
}

// Copied verbatim: the decision made per-group when the customer supplied no
// selection for a required group.
function resolveRequiredGroupWithNoSelection(group: OptionGroup): { defaulted: string | null; pending: boolean } {
  const defaultChoice = group.choices.find(c => c.is_default && c.price_cents === 0);
  if (defaultChoice) {
    return { defaulted: defaultChoice.name, pending: false };
  }
  return { defaulted: null, pending: true };
}

function group(overrides: Partial<OptionGroup> & { choices: OptionChoice[] }): OptionGroup {
  return { id: "g1", name: "Dressing", required: true, min_select: 1, max_select: 1, ...overrides };
}

function choice(name: string, is_default: boolean, price_cents = 0): OptionChoice {
  return { id: name, name, price_cents, is_default };
}

Deno.test("default-fill: a free default choice is applied, group is not left pending", () => {
  const g = group({ choices: [choice("Ranch", true), choice("Italian", false), choice("Vinaigrette", false)] });
  const result = resolveRequiredGroupWithNoSelection(g);
  assertEquals(result.defaulted, "Ranch");
  assertEquals(result.pending, false);
});

Deno.test("default-fill: a default choice that costs extra is NOT auto-applied — stays pending", () => {
  const g = group({ choices: [choice("Extra Ranch Cup", true, 50), choice("Italian", false)] });
  const result = resolveRequiredGroupWithNoSelection(g);
  assertEquals(result.defaulted, null);
  assertEquals(result.pending, true);
  // never silently charge for a default the customer never asked for
});

Deno.test("default-fill: no default recorded — falls through to pending exactly as before this fix", () => {
  const g = group({ choices: [choice("Ranch", false), choice("Italian", false)] });
  const result = resolveRequiredGroupWithNoSelection(g);
  assertEquals(result.defaulted, null);
  assertEquals(result.pending, true);
});

Deno.test("default-fill: an item with no is_default set at all on any choice stays pending (no data yet)", () => {
  const g = group({ choices: [choice("Roll", false), choice("Bagel", false), choice("Wrap", false)] });
  const result = resolveRequiredGroupWithNoSelection(g);
  assertEquals(result.defaulted, null);
  assertEquals(result.pending, true);
});

// ── Wiring regression guards against the live file ─────────────────────────

function extractBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert(start !== -1, `start marker not found in index.ts: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert(end !== -1, `end marker not found after start in index.ts: ${endMarker}`);
  return source.slice(start, end);
}

Deno.test("add_item wiring: default-fill runs before the pending push, and never applies a priced default", () => {
  const block = extractBlock(INDEX_SOURCE, 'case "add_item": {', 'case "remove_item": {');
  const defaultIdx = block.indexOf("c.is_default && c.price_cents === 0");
  const pendingPushIdx = block.indexOf("pending.push(group.name)");
  assert(defaultIdx !== -1, "add_item must look for a free (price_cents === 0) is_default choice");
  assert(pendingPushIdx !== -1, "add_item must still fall back to pending when there's no usable default");
  assert(defaultIdx < pendingPushIdx, "the default-fill check must run BEFORE falling back to pending");
});

Deno.test("add_item wiring: a defaulted group is surfaced in the tool result so the model mentions it, not silently", () => {
  const block = extractBlock(INDEX_SOURCE, 'case "add_item": {', 'case "remove_item": {');
  assert(block.includes("defaultedGroups"), "defaulted groups must be tracked");
  assert(block.includes("defaulted_options"), "defaulted groups must be surfaced on the tool result");
  assert(/mention this casually/i.test(block), "the model must be told to mention the default, never stay silent about it");
});

Deno.test("menu prompt wiring: the default choice is marked for the model in the option list", () => {
  assert(INDEX_SOURCE.includes("c.is_default ? ' [default]' : ''"), "the system-prompt menu rendering must mark which choice is the recorded default");
});
