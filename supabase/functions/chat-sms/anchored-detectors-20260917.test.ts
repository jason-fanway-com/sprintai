// 00-BH: three more detectors that required the customer's WHOLE message to be
// the answer. Found by auditing every whole-message-anchored regex rather than
// waiting for the sim to trip over them one at a time. Two handle money.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readTipReply, impliesConfirmDecline } from "./turn-engine.ts";

Deno.test("00-BH tip: natural declines are read as no tip", () => {
  for (const m of ["no tip", "No tip, thanks!", "no thanks", "I don't want a tip", "skip it", "none", "not today"]) {
    assertEquals(readTipReply(m)?.kind, "decline", m);
  }
});

Deno.test("00-BH tip: natural amounts are read, in cents", () => {
  assertEquals(readTipReply("$5"), { kind: "amount", cents: 500 });
  assertEquals(readTipReply("leave $5"), { kind: "amount", cents: 500 });
  assertEquals(readTipReply("5 dollars"), { kind: "amount", cents: 500 });
  assertEquals(readTipReply("$3.50 please"), { kind: "amount", cents: 350 });
  assertEquals(readTipReply("2 bucks"), { kind: "amount", cents: 200 });
  // a bare number still works, unchanged
  assertEquals(readTipReply("5"), { kind: "amount", cents: 500 });
});

Deno.test("00-BH tip: an amount WINS over a decline word — never tip 0 when a number is named", () => {
  assertEquals(readTipReply("no more than $5"), { kind: "amount", cents: 500 });
});

Deno.test("00-BH tip: unrelated text resolves nothing rather than guessing a tip", () => {
  for (const m of ["what's the total?", "", "a large pepperoni pizza"]) {
    assertEquals(readTipReply(m), null, m);
  }
});

Deno.test("00-BH confirm: a decline inside a sentence is still a decline", () => {
  for (const m of ["no", "No, wait — change the size", "no, remove the onions", "actually that's wrong", "hold on", "cancel that"]) {
    assertEquals(impliesConfirmDecline(m), true, m);
  }
});

Deno.test("00-BH confirm: a plain yes is NOT a decline", () => {
  for (const m of ["yes", "Yes, confirm the order!", "looks good", ""]) {
    assertEquals(impliesConfirmDecline(m), false, m);
  }
});
