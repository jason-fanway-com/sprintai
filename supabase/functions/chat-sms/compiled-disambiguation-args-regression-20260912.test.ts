// Regression test for the P0 fixed in commit a1b8979: the disambiguation-
// resolution add_item call site (GUARD 7's "resolved" branch, e.g. the
// numbered-pick backstop answering "1") must keep passing
// compiledEngineEnabled/customerMessage/shopPhone, or it silently falls
// through to the LEGACY add_item branch even on a compiled-engine shop —
// producing a second, invisible-to-identity-checks cart line and a real
// double-charge (observed live on Vito's Gyro, 2026-09-11).
//
// APPROACH: source-shape assertion, not a unit test calling executeTool
// directly. executeTool is a large function entangled with live Supabase
// calls, menu compilation, and ask-plan state that would need a
// disproportionate refactor to invoke in isolation for one call site — the
// spec explicitly allows a source-shape guard when that's the more robust
// option given the current code shape. This test greps the exact call site
// (identified by its anchor comment and the resolved.menu_item_id shape
// unique to this branch, so it cannot accidentally match one of the OTHER
// executeTool("add_item", ...) call sites in this file) and asserts its
// argument list still includes all three required positional args, in the
// same call expression, before the next call site could be mistaken for it.

import { assertStringIncludes } from "https://deno.land/std@0.208.0/testing/asserts.ts";

const SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

Deno.test("compiled-engine disambiguation resolution still passes compiledEngineEnabled/customerMessage/shopPhone to add_item (a1b8979 repro)", () => {
  const anchor = "P0 fix (2026-09-11, live money defect — Vito's Gyro double-charge):";
  const anchorIndex = SOURCE.indexOf(anchor);
  if (anchorIndex === -1) {
    throw new Error(
      "Could not find the a1b8979 fix's anchor comment in index.ts — the call site may have moved or been rewritten. " +
      "This test must be updated to re-locate the disambiguation-resolution add_item call site rather than silently passing.",
    );
  }

  // The call expression itself starts a few lines after the anchor comment
  // and ends at the next statement (the pending_disambiguation clear). Slice
  // a generous window and assert on the call text within it.
  const window = SOURCE.slice(anchorIndex, anchorIndex + 1500);
  const callStart = window.indexOf('executeTool(\n        "add_item"');
  if (callStart === -1) {
    throw new Error(
      "Could not find the add_item executeTool call immediately following the a1b8979 anchor comment — " +
      "the call site's formatting changed. Update this test's anchor.",
    );
  }
  const callEnd = window.indexOf(");", callStart);
  const callText = window.slice(callStart, callEnd);

  assertStringIncludes(callText, "resolved.menu_item_id", "must be the disambiguation-resolution add_item call, not a different one");
  assertStringIncludes(callText, "shop.compiled_ordering_engine_enabled === true", "compiledEngineEnabled arg must be passed");
  assertStringIncludes(callText, "userMessage", "customerMessage arg must be passed");
  assertStringIncludes(callText, "shop.phone_number_e164 ?? null", "shopPhone arg must be passed");
});
