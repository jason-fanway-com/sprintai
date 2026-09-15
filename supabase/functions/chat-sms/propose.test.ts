// Turn Engine Phase 2 gate (docs/specs/2026-09-14-turn-engine-oversight.md
// §4 Phase 2). Exercises every parse and failure path of propose.ts with a
// stubbed transport (fetchImpl) and a stubbed Supabase client — zero
// network, zero real Postgres writes. The 20 live model calls against
// Vito's real menu happen only in ~/po-scratch/propose-mx.py, never here.
import { assert, assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { proposeTurn, DEFAULT_MODEL, DEFAULT_CHAT_API, type ProposeTurnInput } from "./propose.ts";
import type { TurnEngineMenuItem, TurnEngineCartLine } from "./turn-engine.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────

const MENU: TurnEngineMenuItem[] = [
  { id: "item-cheeseburger", name: "Cheese Burger", category: "Burgers", price_cents: 849, bot_state: "orderable" },
  { id: "item-fries", name: "French Fries", category: "Sides", price_cents: 399, bot_state: "orderable" },
  { id: "item-coke", name: "Coke", category: "Drinks", price_cents: 299, bot_state: "orderable" },
  { id: "item-blocked-shake", name: "Milkshake", category: "Drinks", price_cents: 499, bot_state: "blocked" },
  // "cheese" alone must never become a lexicon alias — it's a substring of
  // two item names, same non-unique-word guarantee index.ts's own
  // buildMenuItemNames makes.
  { id: "item-grilled-cheese", name: "Grilled Cheese", category: "Sandwiches", price_cents: 599, bot_state: "orderable" },
];

const EMPTY_CART: TurnEngineCartLine[] = [];

const CART_WITH_BURGER: TurnEngineCartLine[] = [
  { menu_item_id: "item-cheeseburger", name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [] },
];

function baseInput(overrides: Partial<ProposeTurnInput> = {}): ProposeTurnInput {
  return {
    cart: EMPTY_CART,
    open: null,
    menu: MENU,
    history: [],
    message: "cheeseburger",
    ...overrides,
  };
}

// ── Fake Supabase client — records error_log inserts, zero real I/O ─────

function makeFakeSupabase() {
  const inserted: Array<Record<string, unknown>> = [];
  const supabase = {
    from(table: string) {
      assertEquals(table, "error_log");
      return {
        insert(row: Record<string, unknown>) {
          inserted.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  return { supabase, inserted };
}

// ── Fake transport helpers ───────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function toolUseResponse(input: Record<string, unknown>): Response {
  return jsonResponse({
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "toolu_1", name: "submit_proposal", input }],
  });
}

const VALID_ORDER_INPUT = {
  intent: "order",
  adds: [{ menu_item_id: "item-cheeseburger", quantity: 1, choices: [] }],
  removes: [],
  modifies: [],
};

function fixedClock(startMs = 1_000): () => number {
  let t = startMs;
  return () => (t += 1);
}

// ── Success path ──────────────────────────────────────────────────────────

Deno.test("proposeTurn: schema-valid tool_use on the first attempt succeeds, one fetch call, no error_log row", async () => {
  const { supabase, inserted } = makeFakeSupabase();
  let calls = 0;
  const result = await proposeTurn(baseInput(), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    fetchImpl: (() => {
      calls++;
      return Promise.resolve(toolUseResponse(VALID_ORDER_INPUT));
    }) as typeof fetch,
  });
  assertEquals(calls, 1);
  assert(result.ok);
  if (result.ok) {
    assertEquals(result.proposal.intent, "order");
    assertEquals(result.proposal.adds[0].menu_item_id, "item-cheeseburger");
    assertEquals(result.attempts, 1);
  }
  assertEquals(inserted.length, 0);
});

Deno.test("proposeTurn: first attempt fails, second succeeds — exactly one retry, no error_log row (not a terminal failure)", async () => {
  const { supabase, inserted } = makeFakeSupabase();
  let calls = 0;
  const result = await proposeTurn(baseInput(), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    fetchImpl: (() => {
      calls++;
      if (calls === 1) return Promise.resolve(jsonResponse({ error: "server hiccup" }, 500));
      return Promise.resolve(toolUseResponse(VALID_ORDER_INPUT));
    }) as typeof fetch,
  });
  assertEquals(calls, 2);
  assert(result.ok);
  if (result.ok) assertEquals(result.attempts, 2);
  assertEquals(inserted.length, 0);
});

// ── Failure paths — each must terminate at exactly 2 attempts and log ────

Deno.test("proposeTurn: non-200 on both attempts — reason non_200, error_log row with raw body from both attempts, capped at 2 calls", async () => {
  const { supabase, inserted } = makeFakeSupabase();
  let calls = 0;
  const result = await proposeTurn(baseInput(), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    fetchImpl: (() => {
      calls++;
      return Promise.resolve(jsonResponse({ error: "bad gateway" }, 502));
    }) as typeof fetch,
  });
  assertEquals(calls, 2, "must never make a third attempt");
  assert(!result.ok);
  if (!result.ok) {
    assertEquals(result.reason, "non_200");
    assertEquals(result.attempts.length, 2);
    assert(result.attempts.every(a => a.reason === "non_200"));
    assert(result.attempts[0].rawBody?.includes("bad gateway"));
  }
  assertEquals(inserted.length, 1);
  assertEquals(inserted[0].stage, "propose_call");
  assertEquals(inserted[0].phase, "chat-sms");
  const metadata = inserted[0].metadata as { attempts: Array<{ reason: string; raw_body: string }> };
  assertEquals(metadata.attempts.length, 2);
  assert(metadata.attempts[0].raw_body.includes("bad gateway"));
});

Deno.test("proposeTurn: fetch throws (bad endpoint / DNS / connection refused) — reason network_error, still logs", async () => {
  const { supabase, inserted } = makeFakeSupabase();
  const result = await proposeTurn(baseInput(), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    fetchImpl: (() => Promise.reject(new TypeError("error sending request for url: connection refused"))) as typeof fetch,
  });
  assert(!result.ok);
  if (!result.ok) assertEquals(result.reason, "network_error");
  assertEquals(inserted.length, 1);
});

Deno.test("proposeTurn: timeout — an attempt that never resolves before timeoutMs is aborted, reason timeout, still logs", async () => {
  const { supabase, inserted } = makeFakeSupabase();
  const result = await proposeTurn(baseInput(), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    timeoutMs: 20, // small override for the test — real default is 25s
    fetchImpl: ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as typeof fetch,
  });
  assert(!result.ok);
  if (!result.ok) assertEquals(result.reason, "timeout");
  assertEquals(inserted.length, 1);
});

Deno.test("proposeTurn: 200 response with a body that isn't valid JSON — reason malformed_json, raw body preserved verbatim, still logs", async () => {
  const { supabase, inserted } = makeFakeSupabase();
  const result = await proposeTurn(baseInput(), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    fetchImpl: (() => Promise.resolve(new Response("<html>502 Bad Gateway</html>", { status: 200 }))) as typeof fetch,
  });
  assert(!result.ok);
  if (!result.ok) {
    assertEquals(result.reason, "malformed_json");
    assert(result.attempts[0].rawBody?.includes("<html>"));
  }
  assertEquals(inserted.length, 1);
});

Deno.test("proposeTurn: valid JSON but no submit_proposal tool_use block present — reason schema_violation", async () => {
  const { supabase, inserted } = makeFakeSupabase();
  const result = await proposeTurn(baseInput(), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    fetchImpl: (() => Promise.resolve(jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "sure thing!" }] }))) as typeof fetch,
  });
  assert(!result.ok);
  if (!result.ok) assertEquals(result.reason, "schema_violation");
  assertEquals(inserted.length, 1);
});

Deno.test("proposeTurn: quantity is not an integer — schema_violation, never silently coerced (e.g. floor()'d)", async () => {
  const { supabase } = makeFakeSupabase();
  const result = await proposeTurn(baseInput(), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    fetchImpl: (() =>
      Promise.resolve(toolUseResponse({
        intent: "order",
        adds: [{ menu_item_id: "item-cheeseburger", quantity: 1.5, choices: [] }],
        removes: [],
        modifies: [],
      }))) as typeof fetch,
  });
  assert(!result.ok);
  if (!result.ok) assertEquals(result.reason, "schema_violation");
});

Deno.test("proposeTurn: unknown intent value — schema_violation, the enum is closed", async () => {
  const { supabase } = makeFakeSupabase();
  const result = await proposeTurn(baseInput(), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    fetchImpl: (() =>
      Promise.resolve(toolUseResponse({ intent: "reorder_last_time", adds: [], removes: [], modifies: [] }))) as typeof fetch,
  });
  assert(!result.ok);
  if (!result.ok) assertEquals(result.reason, "schema_violation");
});

Deno.test("proposeTurn: answer_text set under a non-question intent — schema_violation, the model has no reply authority outside intent=question", async () => {
  const { supabase } = makeFakeSupabase();
  const result = await proposeTurn(baseInput(), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    fetchImpl: (() =>
      Promise.resolve(toolUseResponse({
        intent: "order",
        adds: [{ menu_item_id: "item-cheeseburger", quantity: 1, choices: [] }],
        removes: [],
        modifies: [],
        answer_text: "Sure, adding that now!",
      }))) as typeof fetch,
  });
  assert(!result.ok);
  if (!result.ok) assertEquals(result.reason, "schema_violation");
});

Deno.test("proposeTurn: answer_text set under intent=question is accepted", async () => {
  const { supabase } = makeFakeSupabase();
  const result = await proposeTurn(baseInput({ message: "are you open on Sundays?" }), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    fetchImpl: (() =>
      Promise.resolve(toolUseResponse({
        intent: "question",
        adds: [],
        removes: [],
        modifies: [],
        answer_text: "Yes, we're open Sundays 11am-9pm.",
      }))) as typeof fetch,
  });
  assert(result.ok);
  if (result.ok) assertEquals(result.proposal.answer_text, "Yes, we're open Sundays 11am-9pm.");
});

Deno.test("proposeTurn: remove_choices must be a string array — a non-string entry is schema_violation", async () => {
  const { supabase } = makeFakeSupabase();
  const result = await proposeTurn(baseInput(), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    fetchImpl: (() =>
      Promise.resolve(toolUseResponse({
        intent: "order",
        adds: [],
        removes: [],
        modifies: [{ line_key: "item-cheeseburger::", remove_choices: [123] }],
      }))) as typeof fetch,
  });
  assert(!result.ok);
  if (!result.ok) assertEquals(result.reason, "schema_violation");
});

// ── Request shaping — proves the prompt actually carries what §3c requires

Deno.test("proposeTurn: request uses the configured model, chatApiUrl, and forces the submit_proposal tool with tool_choice", async () => {
  const { supabase } = makeFakeSupabase();
  let capturedUrl = "";
  // deno-lint-ignore no-explicit-any
  let capturedBody: any = null;
  await proposeTurn(baseInput(), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    fetchImpl: ((url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init!.body as string);
      return Promise.resolve(toolUseResponse(VALID_ORDER_INPUT));
    }) as typeof fetch,
  });
  assertEquals(capturedUrl, DEFAULT_CHAT_API);
  assertEquals(capturedBody.model, DEFAULT_MODEL);
  assertEquals(capturedBody.tool_choice, { type: "tool", name: "submit_proposal" });
  assertEquals(capturedBody.tools.length, 1);
  assertEquals(capturedBody.tools[0].name, "submit_proposal");
});

Deno.test("proposeTurn: system prompt's menu index marks a blocked item not-orderable and never fabricates a shared-word lexicon alias", async () => {
  const { supabase } = makeFakeSupabase();
  // deno-lint-ignore no-explicit-any
  let capturedBody: any = null;
  await proposeTurn(baseInput(), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    fetchImpl: ((_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return Promise.resolve(toolUseResponse(VALID_ORDER_INPUT));
    }) as typeof fetch,
  });
  const system: string = capturedBody.system;
  const menuJson = system.match(/Menu index:\n(\[.*?\])\n\n/s)![1];
  const menuIndex = JSON.parse(menuJson);
  const shake = menuIndex.find((m: { id: string }) => m.id === "item-blocked-shake");
  assertExists(shake);
  assertEquals(shake.orderable, false);
  const burger = menuIndex.find((m: { id: string }) => m.id === "item-cheeseburger");
  assertEquals(burger.orderable, true);
  // "cheese" is shared by Cheese Burger and Grilled Cheese — must never be
  // offered as a one-word alias for either.
  const grilledCheese = menuIndex.find((m: { id: string }) => m.id === "item-grilled-cheese");
  assert(!burger.lexicon.includes("cheese"));
  assert(!grilledCheese.lexicon.includes("cheese"));
});

Deno.test("proposeTurn: system prompt's cart index carries line_key computed the same way DECIDE's removes/modifies expect", async () => {
  const { supabase } = makeFakeSupabase();
  // deno-lint-ignore no-explicit-any
  let capturedBody: any = null;
  await proposeTurn(baseInput({ cart: CART_WITH_BURGER, message: "actually remove the burger" }), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    fetchImpl: ((_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return Promise.resolve(toolUseResponse({ intent: "order", adds: [], removes: [{ line_key: "item-cheeseburger::" }], modifies: [] }));
    }) as typeof fetch,
  });
  const system: string = capturedBody.system;
  const cartJson = system.match(/Cart:\n(\[.*?\])\n\n/s)![1];
  const cartIndex = JSON.parse(cartJson);
  assertEquals(cartIndex[0].line_key, "item-cheeseburger::");
  assertEquals(cartIndex[0].menu_item_id, "item-cheeseburger");
});

Deno.test("proposeTurn: history is capped to the last six entries and the current message is appended last", async () => {
  const { supabase } = makeFakeSupabase();
  // deno-lint-ignore no-explicit-any
  let capturedBody: any = null;
  const history = Array.from({ length: 10 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `turn ${i}`,
  }));
  await proposeTurn(baseInput({ history, message: "current message" }), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    fetchImpl: ((_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return Promise.resolve(toolUseResponse(VALID_ORDER_INPUT));
    }) as typeof fetch,
  });
  assertEquals(capturedBody.messages.length, 7); // last 6 history entries + current message
  assertEquals(capturedBody.messages[0].content, "turn 4");
  assertEquals(capturedBody.messages[5].content, "turn 9");
  assertEquals(capturedBody.messages[6].content, "current message");
});

Deno.test("proposeTurn: the open question is threaded into the system prompt verbatim", async () => {
  const { supabase } = makeFakeSupabase();
  // deno-lint-ignore no-explicit-any
  let capturedBody: any = null;
  await proposeTurn(baseInput({ open: { kind: "upsell", menu_item_id: "item-fries" } }), {
    supabase,
    apiKey: "test-key",
    now: fixedClock(),
    fetchImpl: ((_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return Promise.resolve(toolUseResponse(VALID_ORDER_INPUT));
    }) as typeof fetch,
  });
  const system: string = capturedBody.system;
  assert(system.includes('{"kind":"upsell","menu_item_id":"item-fries"}'));
});
