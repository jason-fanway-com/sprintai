import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applicationFeeRefundCents, planRefund, type RefundInput } from "./refund-rules.ts";

// the worked example: $21.00 pizza + $1.26 tax, $7.99 delivery, $3.00 tip, $1.49 fee = $34.74
const base: RefundInput = { foodTaxCents: 2226, feeCents: 149, courier: true, deliveryCents: 799, tipCents: 300, stage: "requested", initiatedBy: "customer", foodRefundCents: 2226 };
const pick = (p: ReturnType<typeof planRefund>) => [p.cancelCourier, p.foodRefundCents, p.platformRefundCents, p.customerRefundCents, p.uberChargeCents, p.shopOwesCents];

Deno.test("customer cancels before a driver accepts: everything back, courier cancelled free", () => {
  assertEquals(pick(planRefund(base)), [true, 2226, 1248, 3474, 0, 0]);
});
Deno.test("customer cancels after a driver accepts: $5 kept from OrderFare's share", () => {
  assertEquals(pick(planRefund({ ...base, stage: "assigned" })), [true, 2226, 748, 2974, 500, 0]);
});
Deno.test("customer cancels after pickup: shop's call on the food, delivery and tip owed to Uber, fee kept", () => {
  assertEquals(pick(planRefund({ ...base, stage: "picked_up", foodRefundCents: 0 })), [false, 0, 0, 0, 1099, 0]);
});
Deno.test("shop cancels after a driver accepts: customer gets everything, the $5 goes on the shop's balance", () => {
  assertEquals(pick(planRefund({ ...base, stage: "assigned", initiatedBy: "shop", foodRefundCents: 0 })), [true, 2226, 1248, 3474, 500, 500]);
});
Deno.test("own drivers: the fee comes back only when the whole order is refunded", () => {
  const own = { ...base, courier: false, stage: "none" as const, deliveryCents: 300, tipCents: 0 };
  assertEquals(pick(planRefund(own)), [false, 2226, 149, 2375, 0, 0]);
  assertEquals(pick(planRefund({ ...own, foodRefundCents: 500 })), [false, 500, 0, 500, 0, 0]);
});
Deno.test("Uber's own reported cancellation fee wins over the default", () => {
  assertEquals(planRefund({ ...base, stage: "assigned", uberReportedFeeCents: 700 }).platformRefundCents, 548);
});
Deno.test("application fee handed back is proportional to the share refunded", () => {
  assertEquals(applicationFeeRefundCents(1212, 1248, 1248), 1212);
  assertEquals(applicationFeeRefundCents(1212, 1248, 748), 726);
  assertEquals(applicationFeeRefundCents(1212, 1248, 0), 0);
});
