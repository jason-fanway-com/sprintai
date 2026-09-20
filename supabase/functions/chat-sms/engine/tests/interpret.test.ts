import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { toMoves } from "../interpret.ts";

Deno.test("toMoves: talk is kept only when it makes no money or action claims", () => {
  const ok = toMoves({ moves: [{ kind: "talk", value: "Sorry about that. Nothing changes on your order." }] });
  assertEquals(ok, [{ kind: "talk", text: "Sorry about that. Nothing changes on your order." }]);
  assertEquals(toMoves({ moves: [{ kind: "talk", value: "I removed the fries for you" }] }), []);
  assertEquals(toMoves({ moves: [{ kind: "talk", value: "That will be $12.50" }] }), []);
});
