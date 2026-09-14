import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { renderNumberedPickList, renderQuotedNameList, renderNameList } from "./candidate-list.ts";

Deno.test("renderNumberedPickList: with prices, matches the original hand-built template exactly", () => {
  const items = [{ name: "Pepperoni Pizza", price_cents: 1699 }, { name: "Cheese Pizza", price_cents: 1299 }];
  assertEquals(
    renderNumberedPickList(items, "the "),
    `1) the Pepperoni Pizza — $16.99  2) the Cheese Pizza — $12.99`,
  );
});

Deno.test("renderNumberedPickList: no prices, no prefix, matches the original hand-built template exactly", () => {
  const items = [{ name: "Pepperoni Pizza" }, { name: "Garlic Knots" }];
  assertEquals(renderNumberedPickList(items), `1) Pepperoni Pizza  2) Garlic Knots`);
});

Deno.test("renderNumberedPickList: single item", () => {
  assertEquals(renderNumberedPickList([{ name: "Fries" }]), "1) Fries");
});

Deno.test("renderQuotedNameList: matches the original hand-built template exactly", () => {
  assertEquals(renderQuotedNameList(["Cheese Pizza", "French Fries"]), `"Cheese Pizza", "French Fries"`);
});

Deno.test("renderNameList: matches the original hand-built template exactly", () => {
  assertEquals(renderNameList(["Medium", "Pepperoni"]), "Medium, Pepperoni");
});

Deno.test("renderNameList: single name, no trailing separator", () => {
  assertEquals(renderNameList(["Medium"]), "Medium");
});

Deno.test("renderNameList: empty list renders empty string, never throws", () => {
  assertEquals(renderNameList([]), "");
});
