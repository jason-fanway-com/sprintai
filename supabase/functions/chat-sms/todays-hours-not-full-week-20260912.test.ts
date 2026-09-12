// Defect (live 2026-09-12): a customer asked "are you open" on a Saturday
// and the bot answered "Today's hours are 11:00 AM to 10:00 PM" -- Vito's
// real Saturday hours close at 11:00 PM (11:00-23:00), a weekday's close
// time. Root cause: buildSystemPromptV2 handed the model
// shop_settings.hours_line VERBATIM -- the full week as one string ("Mon
// 11:00-22:00, ..., Sat 11:00-23:00, Sun 12:00-21:00") -- under a single
// HOURS label and left the model to pick out today's row itself. It picked
// wrong.
//
// Fix: TODAY'S HOURS is now always computed deterministically from
// shop.open_hours via the same dayWindows/getBusinessDayKey helpers used
// for open/closed state elsewhere in this file (see the RESET-reply fix,
// 79d16eb0/0c3e350f/ee32d9e6) -- never left to the model. hours_line is
// still surfaced, unchanged, as a SEPARATE "THIS WEEK'S HOURS" line for
// "what are your hours this week"-type questions.
//
// getBusinessDayKey and buildSystemPromptV2 both take an injectable `now`
// (defaulting to real wall-clock time at their one real call site each) so
// this test can assert behavior AT A SPECIFIC SATURDAY TIMESTAMP regardless
// of what day it actually is when the suite runs -- same
// isConversationExpired(now: Date, ...) precedent already used in this file.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildSystemPromptV2, getBusinessDayKey } from "./index.ts";
import { dayWindows } from "../_shared/hours.ts";

// 2026-09-12 14:00 America/New_York (18:00 UTC) is a real, calendar-verified
// Saturday -- not a fixture invented to be "a Saturday", the same date this
// fix shipped on.
const SATURDAY_2PM_ET = new Date("2026-09-12T18:00:00.000Z");

function minimalShop(overrides: Partial<Record<string, unknown>>) {
  return {
    id: "shop-1", name: "Test Shop", slug: "test-shop",
    wing_flavors_included: null, wing_mix_extra: null,
    tenant_id: "tenant-1", phone_number_e164: null, sms_provider: null, reply_from_e164: null,
    open_hours: {}, timezone: "America/New_York",
    email_ticket_recipient: null, is_paused: false, pause_message: null,
    delivery_enabled: true, delivery_paused_until: null, delivery_pause_reason: null,
    delivery_fee_cents: null, shop_context: null, ai_instructions: null,
    latitude: null, longitude: null, delivery_radius_mi: null,
    ...overrides,
    // deno-lint-ignore no-explicit-any
  } as any;
}

function minimalShopSettings(hoursLine: string) {
  return {
    hours_line: hoursLine,
    fulfilment_modes: ["pickup", "delivery"],
    delivery_radius_miles: 5,
    quantity_words: {},
    upsell_enabled: true,
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("getBusinessDayKey resolves 'sat' at the fixed Saturday timestamp, regardless of real wall-clock time", () => {
  assertEquals(getBusinessDayKey("America/New_York", SATURDAY_2PM_ET), "sat");
});

// Live shop data (shops.open_hours / shop_settings.hours_line), confirmed
// 2026-09-12 -- Sat close times genuinely differ from their own weekday
// close, which is exactly what made the old model-picks-from-hours_line bug
// possible to get wrong.
const SHOPS = [
  {
    name: "Vito's Pizza",
    openHours: {
      mon: [{ open: "11:00", close: "22:00" }],
      tue: [{ open: "11:00", close: "22:00" }],
      wed: [{ open: "11:00", close: "22:00" }],
      thu: [{ open: "11:00", close: "22:00" }],
      fri: [{ open: "11:00", close: "23:00" }],
      sat: [{ open: "11:00", close: "23:00" }],
      sun: [{ open: "12:00", close: "21:00" }],
    },
    hoursLine: "Mon 11:00-22:00, Tue 11:00-22:00, Wed 11:00-22:00, Thu 11:00-22:00, Fri 11:00-23:00, Sat 11:00-23:00, Sun 12:00-21:00",
    expectedSatWindow: "11:00-23:00",
    weekdayCloseThatMustNotAppearAsToday: "11:00-22:00",
  },
  {
    name: "Zio's Pizzeria",
    openHours: {
      mon: { open: "10:00", close: "22:00", closed: false },
      tue: { open: "10:00", close: "22:00", closed: false },
      wed: { open: "10:00", close: "22:00", closed: false },
      thu: { open: "10:00", close: "22:00", closed: false },
      fri: { open: "10:00", close: "22:00", closed: false },
      sat: { open: "10:00", close: "22:00", closed: false },
      sun: { open: "10:00", close: "22:00", closed: false },
    },
    hoursLine: "Mon 10:00-22:00, Tue 10:00-22:00, Wed 10:00-22:00, Thu 10:00-22:00, Fri 10:00-22:00, Sat 10:00-22:00, Sun 10:00-22:00",
    expectedSatWindow: "10:00-22:00",
    weekdayCloseThatMustNotAppearAsToday: null, // Zio's hours are identical every day -- no wrong-day case exists for this shop, included for the sweep's completeness
  },
  {
    name: "Not Just Bagels",
    openHours: {
      mon: { open: "07:00", close: "15:00", closed: false },
      tue: { open: "07:00", close: "15:00", closed: false },
      wed: { open: "07:00", close: "15:00", closed: false },
      thu: { open: "07:00", close: "15:00", closed: false },
      fri: { open: "07:00", close: "15:00", closed: false },
      sat: { open: "07:00", close: "16:00", closed: false },
      sun: { open: "08:00", close: "14:00", closed: false },
    },
    hoursLine: "Mon 07:00-15:00, Tue 07:00-15:00, Wed 07:00-15:00, Thu 07:00-15:00, Fri 07:00-15:00, Sat 07:00-16:00, Sun 08:00-14:00",
    expectedSatWindow: "07:00-16:00",
    weekdayCloseThatMustNotAppearAsToday: "07:00-15:00",
  },
];

for (const s of SHOPS) {
  Deno.test(`${s.name}: dayWindows/getBusinessDayKey resolve Saturday's real window (${s.expectedSatWindow}) at the fixed Saturday timestamp`, () => {
    const todayKey = getBusinessDayKey("America/New_York", SATURDAY_2PM_ET);
    const windows = dayWindows(s.openHours[todayKey as keyof typeof s.openHours]);
    const rendered = windows.map(h => `${h.open}-${h.close}`).join(", ");
    assertEquals(rendered, s.expectedSatWindow);
    if (s.weekdayCloseThatMustNotAppearAsToday) {
      assert(rendered !== s.weekdayCloseThatMustNotAppearAsToday, `must not render a weekday's close time (${s.weekdayCloseThatMustNotAppearAsToday}) as today's on Saturday`);
    }
  });

  Deno.test(`${s.name}: buildSystemPromptV2's rendered TODAY'S HOURS line matches Saturday's real window, not the weekly hours_line's weekday value`, () => {
    const shop = minimalShop({ open_hours: s.openHours, timezone: "America/New_York" });
    const shopSettings = minimalShopSettings(s.hoursLine);
    const prompt = buildSystemPromptV2(
      shop, "greeting", [], [], "2:00 PM", true,
      null, false, [], null, null, null, null, true, false, true,
      null, shopSettings, null, [], false,
      SATURDAY_2PM_ET,
    );

    assert(
      prompt.includes(`TODAY'S HOURS: ${s.expectedSatWindow}`),
      `expected "TODAY'S HOURS: ${s.expectedSatWindow}" in the rendered prompt, got: ${prompt.match(/TODAY'S HOURS:.*/)?.[0]}`,
    );
    // The full week is still available for "hours this week"-type questions,
    // unchanged -- this fix must not remove it, only stop it from being the
    // TODAY source.
    assert(prompt.includes(`THIS WEEK'S HOURS: ${s.hoursLine}`), "the full week's hours_line must still be surfaced separately");
    if (s.weekdayCloseThatMustNotAppearAsToday) {
      assert(
        !prompt.includes(`TODAY'S HOURS: ${s.weekdayCloseThatMustNotAppearAsToday}`),
        `must not render a weekday's close time (${s.weekdayCloseThatMustNotAppearAsToday}) as TODAY'S HOURS on a Saturday`,
      );
    }
  });
}
