// 00-BG: the same defect as the name question and the confirm gate, a third
// time. Every phrase below is verbatim from one run, and each was answered
// with "Anything else?" again.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { impliesClosure } from "./turn-engine.ts";

Deno.test("00-BG: real closures that were not recognised", () => {
  for (const m of [
    "Nope, that's it for now!",
    "No, that's all! Just the small Meat Lover, large Meat Lover, and side salad for pickup.",
    "That's all I want! Just the wings for pickup.",
    "Nope, that's everything! Just those three items for pickup.",
    "I think I'm good! Just the small and large Meat Lover pizzas and a side salad for pickup.",
    "that's it, thanks",
    "I'm done",
    "we're good",
    "that'll be all",
  ]) assertEquals(impliesClosure(m), true, m);
});

Deno.test("00-BG: bare closures still work", () => {
  for (const m of ["no", "nope", "nah", "nothing", "that's all"]) assertEquals(impliesClosure(m), true, m);
});

Deno.test("00-BG: must NOT close when the customer is still ordering", () => {
  for (const m of [
    "that's it but also add a coke",
    "nothing else, actually add fries",
    "that's all, one more slice please",
    "that's it, wait — change the size",
    "I want a large pepperoni",
    "",
  ]) assertEquals(impliesClosure(m), false, m);
});
