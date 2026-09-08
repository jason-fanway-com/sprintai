import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getAggregatorWaitForMs } from "./aggregator-render.ts";

Deno.test("getAggregatorWaitForMs: chownow gets a render wait — its storefront is a SPA that hydrates the menu after initial load", () => {
  assertEquals(getAggregatorWaitForMs("chownow"), 5000);
});

Deno.test("getAggregatorWaitForMs: slice gets no wait — its plain scrape already returns a usable menu (2026-09-05 measurement)", () => {
  assertEquals(getAggregatorWaitForMs("slice"), 0);
});

Deno.test("getAggregatorWaitForMs: toast gets no wait — it's blocked by an active anti-bot wall that waitFor can't fix, so spending the extra latency buys nothing", () => {
  assertEquals(getAggregatorWaitForMs("toast"), 0);
});

Deno.test("getAggregatorWaitForMs: unknown platform defaults to no wait", () => {
  assertEquals(getAggregatorWaitForMs("order_online"), 0);
  assertEquals(getAggregatorWaitForMs("owner"), 0);
  assertEquals(getAggregatorWaitForMs("some_new_platform"), 0);
});
