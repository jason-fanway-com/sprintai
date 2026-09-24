import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { toMoves } from "../interpret.ts";

Deno.test("toMoves: talk is kept only when it makes no money or action claims", () => {
  const ok = toMoves({ moves: [{ kind: "talk", value: "Sorry about that. Nothing changes on your order." }] });
  assertEquals(ok, [{ kind: "talk", text: "Sorry about that. Nothing changes on your order." }]);
  assertEquals(toMoves({ moves: [{ kind: "talk", value: "I removed the fries for you" }] }), []);
  assertEquals(toMoves({ moves: [{ kind: "talk", value: "That will be $12.50" }] }), []);
});

Deno.test("toMoves: a prep-time claim becomes the honest no-ETA line", () => {
  const out = toMoves({ moves: [{ kind: "talk", value: "Typically 15-20 minutes for a large pizza. I'll get you an exact time once your order is confirmed." }] });
  assertEquals(out.length, 1);
  assertEquals(out[0].kind, "talk");
  assertEquals((out[0] as { text: string }).text.includes("10-15 minutes"), true);
  assertEquals(toMoves({ moves: [{ kind: "talk", value: "About an hour for delivery tonight." }] })[0].kind, "talk");
  assertEquals((toMoves({ moves: [{ kind: "talk", value: "About an hour for delivery tonight." }] })[0] as { text: string }).text.includes("hour"), false);
});

Deno.test("toMoves: talk never promises to text, call or notify", () => {
  assertEquals(toMoves({ moves: [{ kind: "talk", value: "You're welcome! We'll send you a text when it's out for delivery." }] }), []);
  assertEquals(toMoves({ moves: [{ kind: "talk", value: "We'll text you once it's ready." }] }), []);
  assertEquals(toMoves({ moves: [{ kind: "talk", value: "You're welcome, see you soon!" }] }).length, 1);
});

Deno.test("toMoves: talk never claims it cannot see the order or what the menu has", () => {
  assertEquals(toMoves({ moves: [{ kind: "talk", value: "I can't see the total from here, but the order system will show it to you next." }] }), []);
  assertEquals(toMoves({ moves: [{ kind: "talk", value: "We don't have a plain chicken salad sandwich on our menu." }] }), []);
  assertEquals(toMoves({ moves: [{ kind: "talk", value: "The order system will show your total. Anything else I can help with?" }] }), []);
  assertEquals(toMoves({ moves: [{ kind: "talk", value: "I don't think we have a house balsamic salad. You're picking between grilled chicken or buffalo grilled chicken." }] }), []);
});
