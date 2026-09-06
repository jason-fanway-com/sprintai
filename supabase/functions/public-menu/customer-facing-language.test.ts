// DEFECT (Jason 2026-09-06, live browser review of /m/<slug>): a category
// with no option groups rendered a highlighted dev-facing note — "No add-ons
// or choices are configured for this category yet." — on the public page a
// restaurant texts to real customers. That word describes our database, not
// something a restaurant would say, and it read like the page was
// half-built. The fix: say nothing. A category with no add-ons is not an
// error; the items and prices are the content.
//
// index.ts calls Deno.serve() at module scope (binds a real port), so it
// can't be imported directly by a test runner — same constraint as
// chat-sms/index.ts. These assertions run against the actual source text
// (Deno.readTextFileSync) so a future edit that reintroduces this note fails
// loudly.
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `function ${name} not found in source`);
  const nextFn = source.indexOf("\nfunction ", start + 1);
  return nextFn >= 0 ? source.slice(start, nextFn) : source.slice(start);
}

Deno.test("public-menu: the exact old dev-facing sentence is gone", () => {
  assert(!SOURCE.includes("configured for this category"));
  assert(!SOURCE.includes("No add-ons or choices are"));
});

Deno.test("public-menu: no-options-note class and its markup are gone", () => {
  assert(!SOURCE.includes("no-options-note"));
});

Deno.test("public-menu: renderCategory emits no note div at all for an empty-options category", () => {
  const fnBody = extractFunction(SOURCE, "renderCategory");
  // Regression guard on the code path itself, not just the string: there
  // must be no conditional note/div wired into this function anymore.
  assert(!fnBody.includes("no-options-note"));
  assert(!fnBody.toLowerCase().includes("configured"));
  assert(!/anyOptions/.test(fnBody), "renderCategory should no longer branch on whether any item has options");
});
