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

// 2026-09-19 P0 (live conv ae0eb19b): the customer's FIRST-EVER message — a
// full fresh order with "that's it rn" tacked on as casual filler — was read
// as closure with an EMPTY cart, so PROPOSE was never called and the order
// was silently discarded before it was ever read. An embedded "that's it"
// only means "I'm done adding items, move on" when there is something to
// move on FROM; with nothing in the cart it must fall through instead of
// closing. See impliesClosure's own header.
Deno.test("00-P0 ae0eb19b: an embedded closure phrase riding along with a real order, empty cart, does NOT close — PROPOSE must still see the order", () => {
  for (const m of [
    "yo, lemme get 2x buffalo chicken cheesesteaks w/ mild sauce and 1x french fries. that's it rn",
    "I want a large pepperoni pizza, that's it",
    "can I get a coke and fries thats all",
  ]) assertEquals(impliesClosure(m, false), false, m);
});

Deno.test("00-P0 ae0eb19b: a BARE closure with an empty cart still closes — no other plausible reading of a lone word", () => {
  for (const m of ["no", "nope", "nah", "nothing", "that's all"]) assertEquals(impliesClosure(m, false), true, m);
});

Deno.test("00-P0 ae0eb19b: an embedded closure phrase with a NON-empty cart still closes — unchanged from 00-BG", () => {
  for (const m of ["Nope, that's it for now!", "that's it, thanks"]) assertEquals(impliesClosure(m, true), true, m);
});
