// Defect (found 2026-09-12): the RESET handler in the customer-message flow
// always replied "Text when the kitchen is open..." -- even when the shop
// was genuinely open. An open-shop customer texting RESET was wrongly told
// to come back later. Fix: the RESET reply now branches on the same
// open-hours computation the greeting-phase hours gate already used
// (isWithinAnyWindow + dayWindows), via the exported buildResetReply().
//
// These tests exercise the real exported helpers -- not a re-implementation
// of the hours-window math -- against Vito's actual Saturday hours
// (11:00-23:00) at a Saturday 13:00 America/New_York timestamp, the exact
// scenario a live customer would hit mid-Saturday-lunch-rush.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildResetReply, isWithinAnyWindow } from "./index.ts";
import { dayWindows } from "../_shared/hours.ts";

// Vito's real Saturday hours, in the shape stored on shop.open_hours.sat.
const VITOS_SATURDAY_HOURS = { open: "11:00", close: "23:00" };

// Saturday 13:00 America/New_York -> 13 * 60 = 780 minutes since midnight.
const SATURDAY_1PM_MINS = 13 * 60;

const CLOSED_LANGUAGE = /kitchen is (currently )?closed|when the kitchen is open|come back/i;

Deno.test("RESET at Saturday 1pm, Vito's 11am-11pm hours -> kitchen is open", () => {
  const windows = dayWindows(VITOS_SATURDAY_HOURS);
  const isOpen = isWithinAnyWindow(windows, SATURDAY_1PM_MINS);
  assertEquals(isOpen, true);
});

Deno.test("RESET reply when open does NOT tell the customer to come back later", () => {
  const windows = dayWindows(VITOS_SATURDAY_HOURS);
  const effectiveOpen = isWithinAnyWindow(windows, SATURDAY_1PM_MINS);
  const reply = buildResetReply(effectiveOpen);

  assertEquals(reply, "Session reset. Text anything to start a new order, or TESTMODE to test again.");
  assert(!CLOSED_LANGUAGE.test(reply), `reply wrongly claims the kitchen is closed: "${reply}"`);
});

Deno.test("RESET reply when genuinely closed (11:30pm, after Vito's 11pm close) still tells the customer to come back", () => {
  const windows = dayWindows(VITOS_SATURDAY_HOURS);
  const saturday1130pmMins = 23 * 60 + 30;
  const effectiveOpen = isWithinAnyWindow(windows, saturday1130pmMins);
  const reply = buildResetReply(effectiveOpen);

  assertEquals(effectiveOpen, false);
  assertEquals(reply, "Session reset. Text when the kitchen is open, or TESTMODE to test again.");
});
