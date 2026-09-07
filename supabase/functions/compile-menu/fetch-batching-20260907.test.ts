// P0 incident (2026-09-07): the first real compile run against Zio's (492
// option_groups, 3430 option_choices) silently wrote bot_state='blocked' for
// 183 items that actually have real, stated choices. Root cause: index.ts's
// fetchAllRows() fetched option_choices via a single `.in("option_group_id",
// groupIds)` call with all ~492 group UUIDs in one request — the resulting
// URL is long enough that the fetch fails outright
// (`TypeError: fetch failed`, reproduced independently against the live DB,
// not a PostgREST-level error). fetchAllRows's error handling
// (`if (error) { console.error(...); break; }`) swallowed this silently and
// returned an empty array, so the compiler believed every one of those
// groups had zero choices. The response still said `ok: true` with no
// indication anything failed.
//
// FIX: (1) fetchAllRows now THROWS on any fetch error instead of returning
// partial/empty data — a compiler whose entire job is correctness must fail
// the whole run loudly, never write plausible-looking wrong data. (2) A new
// fetchAllRowsBatchedIn() chunks the `.in()` VALUE LIST itself (not just the
// result page) into batches of IN_BATCH_SIZE, for any filter whose id count
// scales with menu size. Verified live post-fix: Zio's went from 20/220
// orderable (183 wrongly blocked) to 203/220 orderable with the remaining 17
// genuinely pending 2 real owner questions (bread on Wraps, temp on
// Burgers) — confirmed by re-querying the live DB and diffing two
// consecutive compile runs for idempotency (0 diffs, excluding compiled_at).
//
// index.ts calls Deno.serve() at module scope, so it is never imported
// directly by tests (same constraint as every chat-sms/*.test.ts file in
// this codebase). This file mirrors fetchAllRows/fetchAllRowsBatchedIn
// verbatim from their current index.ts source, with a source-text
// regression check at the bottom.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

// Test mirror note: the real index.ts types queryBuilder as returning a
// PromiseLike and casts through `as any` before calling `.range()` (since
// real supabase-js builders are both chainable AND thenable). This mirror
// types the builder by what's actually called on it (`.range()`) instead,
// so a minimal fake object doesn't need to implement `.then()` too.
type RangeQuery<T> = { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> };

const FETCH_PAGE_SIZE = 1000;
async function fetchAllRows<T>(
  queryBuilder: () => RangeQuery<T>,
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await queryBuilder().range(from, from + FETCH_PAGE_SIZE - 1);
    if (error) {
      throw new Error(`fetchAllRows failed at offset ${from}: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < FETCH_PAGE_SIZE) break;
    from += FETCH_PAGE_SIZE;
  }
  return rows;
}

const IN_BATCH_SIZE = 150;
async function fetchAllRowsBatchedIn<T, K>(
  ids: K[],
  queryBuilder: (batch: K[]) => RangeQuery<T>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += IN_BATCH_SIZE) {
    const batch = ids.slice(i, i + IN_BATCH_SIZE);
    rows.push(...await fetchAllRows(() => queryBuilder(batch)));
  }
  return rows;
}

// A fake Supabase-shaped query builder: supports .range() (used inside
// fetchAllRows) and resolves against an in-memory table filtered by an
// `.in()`-equivalent predicate baked into the fixture.
function fakeQuery<T>(allRows: T[], failOnBatchContaining?: unknown) {
  return (batch: unknown[]) => {
    const shouldFail = failOnBatchContaining !== undefined && batch.includes(failOnBatchContaining);
    return {
      range: (from: number, to: number) => {
        if (shouldFail) return Promise.resolve({ data: null, error: { message: "TypeError: fetch failed" } });
        return Promise.resolve({ data: allRows.slice(from, to + 1), error: null });
      },
    };
  };
}

Deno.test("fetchAllRowsBatchedIn: chunks a 492-id list into batches of 150 (4 batches: 150,150,150,42)", () => {
  const ids = Array.from({ length: 492 }, (_, i) => `id-${i}`);
  const batchSizes: number[] = [];
  const qb = (batch: unknown[]) => {
    batchSizes.push(batch.length);
    return { range: () => Promise.resolve({ data: [], error: null }) };
  };
  return fetchAllRowsBatchedIn(ids, qb).then(() => {
    assertEquals(batchSizes, [150, 150, 150, 42]);
  });
});

Deno.test("fetchAllRowsBatchedIn: recovers ALL rows across batches, matching the live Zio's incident shape (3430 choices across 492 groups)", async () => {
  const groupIds = Array.from({ length: 492 }, (_, i) => `group-${i}`);
  // Each group "has" 7 choices, 3444 total — close to the real 3430/492 shape.
  const allChoices = groupIds.flatMap(gid => Array.from({ length: 7 }, (_, i) => ({ id: `${gid}-c${i}`, option_group_id: gid })));
  const rows = await fetchAllRowsBatchedIn(groupIds, batch => {
    const inBatch = allChoices.filter(c => batch.includes(c.option_group_id));
    return { range: (from: number, to: number) => Promise.resolve({ data: inBatch.slice(from, to + 1), error: null }) };
  });
  assertEquals(rows.length, allChoices.length);
});

Deno.test("fetchAllRows: a fetch error now THROWS instead of silently returning partial/empty data (the actual incident)", async () => {
  const qb = () => ({ range: () => Promise.resolve({ data: null, error: { message: "TypeError: fetch failed" } }) });
  let threw = false;
  try {
    await fetchAllRows(qb);
  } catch (e) {
    threw = true;
    assert((e as Error).message.includes("fetch failed"));
  }
  assert(threw, "fetchAllRows must throw on a fetch error, not silently return an empty/partial array");
});

Deno.test("fetchAllRowsBatchedIn: a failure in ANY batch throws (never silently drops that batch's rows)", async () => {
  const ids = Array.from({ length: 300 }, (_, i) => `id-${i}`); // 2 batches of 150
  const qb = fakeQuery([], "id-200"); // id-200 is in the second batch
  let threw = false;
  try {
    await fetchAllRowsBatchedIn(ids, qb);
  } catch {
    threw = true;
  }
  assert(threw, "a failure in the second batch must propagate, not be swallowed");
});

Deno.test("regression: index.ts's fetchAllRows throws on error, not console.error+break", () => {
  assert(
    !/fetchAllRows error at offset.*break;/s.test(INDEX_SOURCE.replace(/\n/g, " ")),
    "fetchAllRows must not silently swallow an error and break — this is the exact 2026-09-07 incident",
  );
  assert(INDEX_SOURCE.includes("throw new Error(`fetchAllRows failed at offset"), "fetchAllRows must throw on a fetch error");
});

Deno.test("regression: index.ts defines fetchAllRowsBatchedIn and uses it for option_groups and option_choices", () => {
  assert(INDEX_SOURCE.includes("async function fetchAllRowsBatchedIn"), "fetchAllRowsBatchedIn must exist");
  assert(INDEX_SOURCE.includes('fetchAllRowsBatchedIn<OptionGroupRow, string>(itemIds'), "option_groups fetch must use batched .in()");
  assert(INDEX_SOURCE.includes('fetchAllRowsBatchedIn<OptionChoiceRow, string>(groupIds'), "option_choices fetch must use batched .in()");
});
