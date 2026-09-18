// Defect (found 2026-09-18): an owner can set shops.delivery_hours (migration
// 060/061) narrower than shops.open_hours -- e.g. kitchen open till 10pm but
// delivery cut off at 8pm -- so delivery stops earlier than pickup. It saved
// correctly from the admin settings screen, but the ordering bot
// (buildSystemPromptV2's canActuallyDeliver/deliveryAvail) never read that
// column, only shop.open_hours, so a customer could still order delivery
// after delivery hours had closed as long as the shop was still open for
// pickup.
//
// Fix: canActuallyDeliver and the DELIVERY AVAILABLE line now also check
// shop.delivery_hours for the current day/time (same dayWindows/
// isWithinAnyWindow helpers used for open_hours elsewhere in this file).
// Empty/unset delivery_hours ({}) falls back to open_hours -- shops that
// never configured this see no behavior change.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildSystemPromptV2 } from "./index.ts";

// Friday 2026-09-18, 9:00 PM America/New_York (2026-09-19T01:00:00Z) --
// calendar-verified: still Friday, still within a typical open_hours window
// (11:00-22:00), but past a narrower 11:00-20:00 delivery cutoff.
const FRIDAY_9PM_ET = new Date("2026-09-19T01:00:00.000Z");

const OPEN_HOURS_FRI = { open: "11:00", close: "22:00" };
const DELIVERY_HOURS_FRI_NARROWER = { open: "11:00", close: "20:00" };

function minimalShop(overrides: Partial<Record<string, unknown>>) {
  return {
    id: "shop-1", name: "Test Shop", slug: "test-shop",
    wing_flavors_included: null, wing_mix_extra: null,
    tenant_id: "tenant-1", phone_number_e164: null, sms_provider: null, reply_from_e164: null,
    open_hours: { fri: OPEN_HOURS_FRI }, delivery_hours: {}, timezone: "America/New_York",
    email_ticket_recipient: null, is_paused: false, pause_message: null,
    delivery_enabled: true, delivery_paused_until: null, delivery_pause_reason: null,
    delivery_fee_cents: null, shop_context: null, ai_instructions: null,
    latitude: null, longitude: null, delivery_radius_mi: null,
    ...overrides,
    // deno-lint-ignore no-explicit-any
  } as any;
}

const shopSettings = {
  hours_line: "Fri 11:00-22:00",
  fulfilment_modes: ["pickup", "delivery"],
  delivery_radius_miles: 5,
  quantity_words: {},
  upsell_enabled: true,
  // deno-lint-ignore no-explicit-any
} as any;

function renderPrompt(shop: ReturnType<typeof minimalShop>) {
  return buildSystemPromptV2(
    shop, "greeting", [], [], "9:00 PM", true,
    null, false, [], null, null, null, null, true, false, true,
    null, shopSettings, null, [], false,
    FRIDAY_9PM_ET,
  );
}

Deno.test("delivery_hours narrower than open_hours: at 9pm (past 8pm delivery cutoff, before 10pm close), delivery is unavailable", () => {
  const shop = minimalShop({ delivery_hours: { fri: DELIVERY_HOURS_FRI_NARROWER } });
  const prompt = renderPrompt(shop);

  assert(
    prompt.includes("DELIVERY AVAILABLE: No — delivery hours have ended for today."),
    `expected delivery to be reported unavailable, got: ${prompt.match(/DELIVERY AVAILABLE:.*/)?.[0]}`,
  );
});

Deno.test("delivery_hours narrower than open_hours: pickup/open-for-business is unaffected -- TODAY'S HOURS still reflects open_hours", () => {
  const shop = minimalShop({ delivery_hours: { fri: DELIVERY_HOURS_FRI_NARROWER } });
  const prompt = renderPrompt(shop);

  assert(
    prompt.includes(`TODAY'S HOURS: ${OPEN_HOURS_FRI.open}-${OPEN_HOURS_FRI.close}`),
    `expected TODAY'S HOURS to still reflect open_hours (pickup unaffected), got: ${prompt.match(/TODAY'S HOURS:.*/)?.[0]}`,
  );
});

Deno.test("delivery_hours = {} (never configured): falls back to open_hours -- delivery still available at 9pm since open_hours runs till 10pm", () => {
  const shop = minimalShop({ delivery_hours: {} });
  const prompt = renderPrompt(shop);

  assert(
    prompt.includes("DELIVERY AVAILABLE: Yes"),
    `expected unconfigured delivery_hours to fall back to open_hours (still open), got: ${prompt.match(/DELIVERY AVAILABLE:.*/)?.[0]}`,
  );
});

Deno.test("delivery_hours undefined (field absent entirely, pre-migration-era shop object): also falls back to open_hours", () => {
  const shop = minimalShop({ delivery_hours: undefined });
  const prompt = renderPrompt(shop);

  assert(
    prompt.includes("DELIVERY AVAILABLE: Yes"),
    `expected undefined delivery_hours to fall back to open_hours (still open), got: ${prompt.match(/DELIVERY AVAILABLE:.*/)?.[0]}`,
  );
});
