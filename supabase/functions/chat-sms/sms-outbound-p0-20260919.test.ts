// P0 fix (2026-09-19, live conv b685494d-62e9-4a2d-b5c1-f761cd6d6c5b, commit
// 2 of p0-narrowing-and-sms-0919): outbound SMS must never fail silently,
// and message_sid must reliably mean "carrier confirmed this send" instead
// of nothing at all.
//
// Three properties covered:
//  1. splitForSms (pure): a reply over the carrier-safe ceiling splits into
//     multiple <=1500-char parts, never truncated, never mid-word when a
//     whitespace boundary exists.
//  2. handleSystemEvent, with a mocked carrier client (global fetch stubbed
//     — zero real network calls) and a fake supabase: a 2xx carrier response
//     writes the carrier's own message id onto the assistant `messages` row
//     that was saved before the send ran.
//  3. Same wiring, mocked non-2xx: an error_log row is written (stage
//     "outbound_send") and the assistant row's message_sid stays NULL —
//     NULL must reliably mean "the carrier never confirmed this send."
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleSystemEvent, splitForSms } from "./index.ts";

// ── 1. splitForSms — pure function, no fakes needed ────────────────────────

Deno.test("splitForSms: text at or under the limit is returned as a single part, unchanged", () => {
  assertEquals(splitForSms("short reply", 1500), ["short reply"]);
  assertEquals(splitForSms("x".repeat(1500), 1500), ["x".repeat(1500)]);
});

Deno.test("splitForSms: a 3,400-char reply (the live overflow shape) splits into carrier-safe parts, every part <=1500 chars", () => {
  // Real shape: words separated by spaces, long enough to force >2 parts.
  const word = "pepperoni ";
  const text = word.repeat(Math.ceil(3400 / word.length)).trim().slice(0, 3400);
  const parts = splitForSms(text, 1500);
  assert(parts.length >= 3, `3,400 chars over a 1,500 ceiling must split into at least 3 parts, got ${parts.length}`);
  for (const p of parts) {
    assert(p.length <= 1500, `every part must be <=1500 chars, got ${p.length}: ${JSON.stringify(p.slice(0, 40))}...`);
    assert(p.length > 0, "no empty parts");
  }
  // No content lost or reordered — rejoining with a single space reconstructs
  // the original word sequence (parts are individually .trim()med).
  assertEquals(parts.join(" "), text);
});

Deno.test("splitForSms: never cuts mid-word when a whitespace boundary exists near the limit", () => {
  const text = `${"a".repeat(1490)} wholeword ${"b".repeat(1490)}`;
  const parts = splitForSms(text, 1500);
  for (const p of parts) {
    assert(p.length <= 1500);
  }
  assert(parts.some(p => p.includes("wholeword")), `"wholeword" must survive intact in one part: ${JSON.stringify(parts)}`);
});

Deno.test("splitForSms: a single pathologically long word (no whitespace in range) still hard-cuts at the limit rather than growing unbounded", () => {
  const text = "x".repeat(5000);
  const parts = splitForSms(text, 1500);
  for (const p of parts) assert(p.length <= 1500);
  assertEquals(parts.join(""), text);
});

// ── 2 & 3. handleSystemEvent, mocked carrier + fake supabase ───────────────

function makeFakeSupabase(overrides: { refundedCents?: number } = {}) {
  const state = {
    messagesInserted: [] as Array<Record<string, unknown>>,
    messagesUpdated: [] as Array<{ row: Record<string, unknown>; id: string }>,
    errorLogInserted: [] as Array<Record<string, unknown>>,
  };
  const cartRow = {
    id: "cart-1",
    shops: {
      id: "shop-1",
      tenant_id: "tenant-1",
      phone_number_e164: "+15551234567",
      sms_provider: "twilio",
      timezone: "America/New_York",
      open_hours: {},
    },
    refunded_cents: overrides.refundedCents ?? 500,
    cart_json: [],
  };
  const conversationRow = {
    id: "conv-1",
    channel: "sms",
    customer_phone: "+15559876543",
    tenant_id: "tenant-1",
    metadata: {},
  };
  let msgIdCounter = 0;
  function builder(table: string) {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq(_col: string, val: unknown) { b.__lastEqId = val; return b; },
      single() {
        if (table === "order_carts") return Promise.resolve({ data: cartRow, error: null });
        if (table === "conversations") return Promise.resolve({ data: conversationRow, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      insert(row: Record<string, unknown>) {
        if (table === "messages") {
          msgIdCounter++;
          const id = `msg-${msgIdCounter}`;
          state.messagesInserted.push({ ...row, id });
          return {
            select: () => ({ single: () => Promise.resolve({ data: { id }, error: null }) }),
            then: (resolve: any) => Promise.resolve({ error: null }).then(resolve),
          };
        }
        if (table === "error_log") {
          state.errorLogInserted.push(row);
        }
        return {
          select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }),
          then: (resolve: any) => Promise.resolve({ error: null }).then(resolve),
        };
      },
      update(row: Record<string, unknown>) {
        if (table === "messages") {
          return {
            eq: (_col: string, id: string) => {
              state.messagesUpdated.push({ row, id });
              return Promise.resolve({ error: null });
            },
          };
        }
        return { eq: () => Promise.resolve({ error: null }) };
      },
    };
    return b;
  }
  return { supabase: { from: (t: string) => builder(t) } as any, state };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = Deno.env.get(k);
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
    }
  });
}

Deno.test("handleSystemEvent (mocked carrier, 2xx): Twilio's own message id is written onto the assistant row saved before the send ran", async () => {
  const { supabase, state } = makeFakeSupabase();
  const origFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  globalThis.fetch = ((url: string | URL) => {
    fetchCalls.push(String(url));
    return Promise.resolve(new Response(JSON.stringify({ sid: "SM_fake_carrier_id_123" }), { status: 201 }));
  }) as typeof fetch;

  try {
    await withEnv({ TWILIO_ACCOUNT_SID: "AC_test", TWILIO_AUTH_TOKEN: "test_token", TELNYX_API_KEY: undefined }, () =>
      handleSystemEvent(supabase, { system_event: "order_refunded", conversation_id: "conv-1", order_cart_id: "cart-1" }),
    );
  } finally {
    globalThis.fetch = origFetch;
  }

  assert(fetchCalls.some(u => u.includes("api.twilio.com")), `must call the real Twilio endpoint shape (mocked, no real network): ${fetchCalls}`);
  assertEquals(state.messagesInserted.length, 1, "the assistant reply must be saved exactly once");
  const savedId = state.messagesInserted[0].id as string;
  assertEquals(state.errorLogInserted.length, 0, "a 2xx send must not produce an error_log row");
  assertEquals(state.messagesUpdated.length, 1, "the carrier id must be written back exactly once");
  assertEquals(state.messagesUpdated[0].id, savedId, "the update must target the SAME row saveMessage returned, not a different one");
  assertEquals(state.messagesUpdated[0].row.message_sid, "SM_fake_carrier_id_123");
});

Deno.test("handleSystemEvent (mocked carrier, non-2xx): an error_log row is written (stage outbound_send) and the assistant row's message_sid stays NULL", async () => {
  const { supabase, state } = makeFakeSupabase();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ message: "The 'To' number is not a valid phone number." }), { status: 400 }))
  ) as typeof fetch;

  try {
    await withEnv({ TWILIO_ACCOUNT_SID: "AC_test", TWILIO_AUTH_TOKEN: "test_token", TELNYX_API_KEY: undefined }, () =>
      handleSystemEvent(supabase, { system_event: "order_refunded", conversation_id: "conv-1", order_cart_id: "cart-1" }),
    );
  } finally {
    globalThis.fetch = origFetch;
  }

  assertEquals(state.messagesInserted.length, 1, "the assistant reply is still saved even though the send failed — never lost");
  assertEquals(state.messagesUpdated.length, 0, "a failed send must never write a message_sid");
  assertEquals(state.errorLogInserted.length, 1, "a non-2xx carrier response must produce exactly one error_log row");
  assertEquals(state.errorLogInserted[0].stage, "outbound_send");
  assertEquals(state.errorLogInserted[0].conversation_id, "conv-1");
  // NULL on the messages row must reliably mean "never confirmed sent" —
  // this insert never set message_sid, so it stays the column default (NULL).
  assert(!("message_sid" in state.messagesInserted[0]), "the initial insert must never itself set message_sid on a failed send");
});
