// Unit tests for _shared/error-log.ts (migration 137).
//
// These run the REAL logError code path with a mock SupabaseClient whose
// `from().insert()` is instrumented to capture what would be written to
// error_log. Per project rule (no synthetic evidence), we do NOT hand-insert
// rows; we drive the real function and observe the insert call.
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { logError } from "./error-log.ts";

// ─── Minimal SupabaseClient mock ─────────────────────────────────────────────
// Captures the last insert payload and optionally simulates failures.
function makeSupabaseSpy(opts: { fail?: boolean } = {}) {
  let lastInsert: Record<string, unknown> | null = null;
  const client = {
    from(_table: string) {
      return {
        insert(row: Record<string, unknown>) {
          lastInsert = row;
          return Promise.resolve(
            opts.fail
              ? { data: null, error: { message: "simulated DB error" } }
              : { data: null, error: null },
          );
        },
      };
    },
  };
  // deno-lint-ignore no-explicit-any
  return { client: client as any, getLastInsert: () => lastInsert };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

Deno.test("logError: inserts a row with correct stage, phase, and error_message", async () => {
  const { client, getLastInsert } = makeSupabaseSpy();
  const err = new Error("boom");
  await logError(client, {
    phase: "chat-sms",
    stage: "tool_loop",
    error: err,
    conversationId: "conv-1",
    shopId: "shop-1",
    tenantId: "tenant-1",
    customerMessage: "hi",
  });
  const row = getLastInsert();
  assertEquals(row?.phase, "chat-sms");
  assertEquals(row?.stage, "tool_loop");
  assertEquals(row?.error_message, "boom");
  assertEquals(row?.conversation_id, "conv-1");
  assertEquals(row?.shop_id, "shop-1");
  assertEquals(row?.tenant_id, "tenant-1");
  assertEquals(row?.customer_message, "hi");
});

Deno.test("logError: non-Error object produces a string error_message", async () => {
  const { client, getLastInsert } = makeSupabaseSpy();
  await logError(client, { phase: "chat-sms", stage: "render", error: "plain string error" });
  assertEquals(getLastInsert()?.error_message, "plain string error");
});

Deno.test("logError: truncates error_message > 4000 chars", async () => {
  const { client, getLastInsert } = makeSupabaseSpy();
  const longMsg = "x".repeat(5000);
  await logError(client, { phase: "chat-sms", stage: "render", error: new Error(longMsg) });
  assertEquals((getLastInsert()?.error_message as string).length, 4000);
});

Deno.test("logError: truncates stack > 4000 chars", async () => {
  const { client, getLastInsert } = makeSupabaseSpy();
  const err = new Error("msg");
  Object.defineProperty(err, "stack", { value: "s".repeat(6000) });
  await logError(client, { phase: "chat-sms", stage: "tool_loop", error: err });
  assertEquals((getLastInsert()?.stack as string).length, 4000);
});

Deno.test("logError: is fail-open — does NOT throw when insert returns an error", async () => {
  // Supabase insert returns an error object (not throws). logError must not re-throw.
  const { client } = makeSupabaseSpy({ fail: true });
  // If logError throws, the test itself will fail — which is the evidence we need.
  await logError(client, { phase: "chat-sms", stage: "guard_deny", error: new Error("boom") });
});

Deno.test("logError: is fail-open — does NOT throw when client.from() throws", async () => {
  // deno-lint-ignore no-explicit-any
  const throwingClient = { from() { throw new Error("client exploded"); } } as any;
  await logError(throwingClient, { phase: "chat-sms", stage: "outbound_send", error: new Error("x") });
});

// Verify that assertRejects is available (sanity check for the import).
// This also proves the test harness itself works in this file.
Deno.test("assertRejects sanity check", async () => {
  await assertRejects(() => Promise.reject(new Error("expected")), Error, "expected");
});
