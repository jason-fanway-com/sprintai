// 00-BH: three more detectors that required the customer's WHOLE message to be
// the answer. Found by auditing every whole-message-anchored regex rather than
// waiting for the sim to trip over them one at a time. Two handle money.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readTipReply, impliesConfirmDecline } from "./turn-engine.ts";

Deno.test("00-BH tip: natural declines are read as no tip", () => {
  for (
    const m of [
      "no tip", "No tip, thanks!", "no thanks", "I don't want a tip", "skip it", "none", "not today",
      // P0 (2026-09-19, live money bug, deploy v528): "driver" between
      // "want a" and "tip" used to miss the decline entirely.
      "I don't want a driver tip",
    ]
  ) {
    assertEquals(readTipReply(m)?.kind, "decline", m);
  }
});

Deno.test("00-BH tip: natural amounts are read, in cents", () => {
  assertEquals(readTipReply("$5"), { kind: "amount", cents: 500 });
  // a bare number still works, unchanged
  assertEquals(readTipReply("5"), { kind: "amount", cents: 500 });
});

// P0 (2026-09-19, live money bug, deploy v528): "leave $5" / "5 dollars" /
// "$3.50 please" / "2 bucks" / "no more than $5" used to resolve as tip
// amounts even with no word "tip" anywhere in the message -- the exact
// "scan the whole message for any dollar figure" shape that charged a
// phantom $19.99 tip off an unrelated sentence in the live repro ("I don't
// want a driver tip. Is it really $19.99 for that?"). A tip is now read
// ONLY from an explicit phrase or the bare whole-message number -- see
// readTipReply's own header. These messages are no longer guessed at; the
// caller (turn-engine.ts's "tip" case) asks again instead.
Deno.test("00-BH tip P0 tightening: a bare dollar figure with no 'tip' word is no longer guessed", () => {
  for (const m of ["leave $5", "5 dollars", "$3.50 please", "2 bucks", "no more than $5"]) {
    assertEquals(readTipReply(m), null, m);
  }
});

Deno.test("00-BH tip: unrelated text resolves nothing rather than guessing a tip", () => {
  for (const m of ["what's the total?", "", "a large pepperoni pizza"]) {
    assertEquals(readTipReply(m), null, m);
  }
});

// P0 (2026-09-19, live money bug, deploy v528): the required explicit tip
// phrases from the PM's own spec -- all must resolve to exactly $5.00.
Deno.test("P0 tip: explicit tip phrases resolve to the stated amount", () => {
  assertEquals(readTipReply("$5 tip"), { kind: "amount", cents: 500 });
  assertEquals(readTipReply("tip $5"), { kind: "amount", cents: 500 });
  assertEquals(readTipReply("tip the driver 5"), { kind: "amount", cents: 500 });
  assertEquals(readTipReply("I want to tip the driver $5"), { kind: "amount", cents: 500 });
  assertEquals(readTipReply("five dollars for the driver"), { kind: "amount", cents: 500 });
});

// P0 (2026-09-19, live money bug, deploy v528): the exact live repro — a
// decline plus an unrelated dollar figure in a second sentence must never
// charge that number as the tip.
Deno.test("P0 tip: a decline wins over a dollar figure named in a different, unrelated sentence", () => {
  assertEquals(
    readTipReply("I don't want a driver tip. Is it really $19.99 for that?"),
    { kind: "decline" },
  );
});

Deno.test("P0 tip: capped at the subtotal", () => {
  assertEquals(readTipReply("$500 tip", { subtotalCents: 849 }), { kind: "amount", cents: 849 });
});

Deno.test("P0 tip: a number is rejected as the tip when it also names a line-item price in the same message", () => {
  assertEquals(
    readTipReply("the pizza is $19.99, tip $19.99", { subtotalCents: 5000, lineItemPricesCents: [1999] }),
    null,
  );
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
