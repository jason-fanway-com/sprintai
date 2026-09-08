import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeFavoriteItemsUpdate,
  resolveCustomerName,
  regularEligibility,
} from "./customer-profile.ts";

Deno.test("computeFavoriteItemsUpdate: first order seeds the list at count 1", () => {
  const result = computeFavoriteItemsUpdate([], ["Large Cheese Pizza", "Garlic Knots"]);
  assertEquals(result, [
    { name: "Large Cheese Pizza", count: 1 },
    { name: "Garlic Knots", count: 1 },
  ]);
});

Deno.test("computeFavoriteItemsUpdate: repeat item across orders increments by ORDER, not unit", () => {
  // Same item twice in ONE order must count as ONE order containing it, per
  // AC6's "count = paid orders", not a unit/quantity sum.
  const result = computeFavoriteItemsUpdate(
    [{ name: "Large Cheese Pizza", count: 2 }],
    ["Large Cheese Pizza", "Large Cheese Pizza", "Garlic Knots"],
  );
  const pizza = result.find(f => f.name === "Large Cheese Pizza");
  assertEquals(pizza?.count, 3);
});

Deno.test("computeFavoriteItemsUpdate: sorts desc by count and truncates to top 5", () => {
  const existing = [
    { name: "A", count: 10 },
    { name: "B", count: 9 },
    { name: "C", count: 8 },
    { name: "D", count: 7 },
    { name: "E", count: 6 },
  ];
  const result = computeFavoriteItemsUpdate(existing, ["F"]);
  assertEquals(result.length, 5);
  assertEquals(result[0].name, "A");
  assertEquals(result.some(f => f.name === "F"), false); // F has count 1, bumped out of top 5
});

Deno.test("resolveCustomerName: latest paid pickup_name wins over existing", () => {
  assertEquals(resolveCustomerName("OldName", "NewName"), "NewName");
});

Deno.test("resolveCustomerName: blank pickup_name never regresses a known name to anonymous", () => {
  assertEquals(resolveCustomerName("Jason", ""), "Jason");
  assertEquals(resolveCustomerName("Jason", "   "), "Jason");
  assertEquals(resolveCustomerName("Jason", null), "Jason");
  assertEquals(resolveCustomerName("Jason", undefined), "Jason");
});

Deno.test("resolveCustomerName: first-ever order with a pickup_name seeds the name", () => {
  assertEquals(resolveCustomerName(null, "Jason"), "Jason");
});

Deno.test("regularEligibility: AC6 threshold — top item needs >= 3 paid orders", () => {
  assertEquals(regularEligibility([{ name: "Pizza", count: 2 }]), null);
  assertEquals(regularEligibility([{ name: "Pizza", count: 3 }]), { name: "Pizza", count: 3 });
  assertEquals(regularEligibility([{ name: "Pizza", count: 5 }]), { name: "Pizza", count: 5 });
});

Deno.test("regularEligibility: empty favorites is not eligible", () => {
  assertEquals(regularEligibility([]), null);
});
