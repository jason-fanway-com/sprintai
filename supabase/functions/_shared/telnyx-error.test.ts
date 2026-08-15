import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyTelnyxSendError } from "../_shared/telnyx-error.ts";

Deno.test("classifyTelnyxSendError: 10036 is a transient system error, NOT an opt-out", () => {
  // FIX 1 regression: 10036 (campaign blocked / not approved) must never be
  // treated as a customer opt-out. It must not corrupt consent state.
  assertEquals(classifyTelnyxSendError("10036"), "transient");
});

Deno.test("classifyTelnyxSendError: genuine opt-out codes are opt_out", () => {
  assertEquals(classifyTelnyxSendError("40002"), "opt_out");
  assertEquals(classifyTelnyxSendError("40003"), "opt_out");
  assertEquals(classifyTelnyxSendError("40004"), "opt_out");
});

Deno.test("classifyTelnyxSendError: unknown/undefined codes are other", () => {
  assertEquals(classifyTelnyxSendError("99999"), "other");
  assertEquals(classifyTelnyxSendError(undefined), "other");
});
