// Seeded ground-truth + transcripts for the Conversation-Judge proofs (Spec 06 §5).
// Two tenants to prove isolation. Known-bad + clean transcripts to prove the rubric.

import type {
  JudgeGroundTruth,
  JudgeTranscriptMessage,
} from "../../_shared/judge-rubric.ts";

// ── Tenant 1: NJB (Jack's-style pizza shop) ──────────────────────────────────
export const TENANT1_GROUND: JudgeGroundTruth = {
  shop_name: "Nonna's Brick (NJB)",
  timezone: "America/New_York",
  open_hours: {
    mon: [{ open: "11:00", close: "21:00" }],
    tue: [{ open: "11:00", close: "21:00" }],
    wed: [{ open: "11:00", close: "21:00" }],
    thu: [{ open: "11:00", close: "21:00" }],
    fri: [{ open: "11:00", close: "22:00" }],
    sat: [{ open: "12:00", close: "22:00" }],
    // sun: closed (omitted)
  },
  menu: [
    { name: "Margherita Pizza", price_cents: 1400, category: "Pizza" },
    { name: "Pepperoni Pizza", price_cents: 1600, category: "Pizza" },
    { name: "Garlic Knots", price_cents: 600, category: "Sides" },
    { name: "Caesar Salad", price_cents: 900, category: "Salads" },
    { name: "Cannoli", price_cents: 500, category: "Dessert" },
  ],
  has_checkout_session: true,
  cart_phase: "confirmed",
  payment_status: "paid",
};

// ── Tenant 2: a totally different shop (sushi) to prove no cross-tenant leak ──
export const TENANT2_GROUND: JudgeGroundTruth = {
  shop_name: "Blue Wave Sushi",
  timezone: "America/New_York",
  open_hours: { mon: [{ open: "16:00", close: "22:00" }] },
  menu: [
    { name: "Spicy Tuna Roll", price_cents: 800, category: "Rolls" },
    { name: "California Roll", price_cents: 700, category: "Rolls" },
    { name: "Miso Soup", price_cents: 400, category: "Sides" },
  ],
  has_checkout_session: true,
  cart_phase: "confirmed",
  payment_status: "paid",
};

function m(id: string, role: "customer" | "assistant" | "system", content: string): JudgeTranscriptMessage {
  return { id, role, content, created_at: new Date().toISOString() };
}

export interface SeedCase {
  name: string;
  expect: "clean" | "flagged";
  expectCheck?: string;
  expectSeverity?: "critical" | "major" | "minor";
  ground: JudgeGroundTruth;
  transcript: JudgeTranscriptMessage[];
}

export const SEED_CASES: SeedCase[] = [
  {
    name: "clean_order",
    expect: "clean",
    ground: TENANT1_GROUND,
    transcript: [
      m("c1", "customer", "Hi can I get a margherita pizza for pickup?"),
      m("a1", "assistant", "Absolutely! One Margherita Pizza ($14.00). Anything else?"),
      m("c2", "customer", "That's it, name is Joe"),
      m("a2", "assistant", "Great, Joe! Your total is $14.00. Here's your secure payment link to finish: [link]"),
      m("c3", "customer", "paid"),
      m("a3", "assistant", "Got it — order confirmed! We'll have it ready in about 20 minutes. Thanks Joe!"),
    ],
  },
  {
    name: "phantom_link",
    expect: "flagged",
    expectCheck: "phantom_payment_link",
    expectSeverity: "critical",
    ground: { ...TENANT1_GROUND, has_checkout_session: false, cart_phase: "checkout", payment_status: "pending" },
    transcript: [
      m("c1", "customer", "One pepperoni pizza please, pickup"),
      m("a1", "assistant", "Sure! One Pepperoni Pizza ($16.00)."),
      m("c2", "customer", "yes that's all"),
      m("a2", "assistant", "Perfect — I've sent your payment link, just tap it to pay $16.00 and you're all set!"),
    ],
  },
  {
    name: "wrong_total",
    expect: "flagged",
    expectCheck: "wrong_total",
    expectSeverity: "critical",
    ground: TENANT1_GROUND,
    transcript: [
      m("c1", "customer", "I'll do a pepperoni pizza and garlic knots"),
      m("a1", "assistant", "Great! Pepperoni Pizza ($16.00) and Garlic Knots ($6.00)."),
      m("c2", "customer", "yep"),
      m("a2", "assistant", "Your total comes to $30.00. Here's your link to pay!"),
    ],
  },
  {
    name: "invented_item",
    expect: "flagged",
    expectCheck: "invented_item",
    expectSeverity: "critical",
    ground: TENANT1_GROUND,
    transcript: [
      m("c1", "customer", "do you have buffalo wings?"),
      m("a1", "assistant", "Yes! Our Buffalo Wings are $11.00 for 10 pieces. Want to add them?"),
      m("c2", "customer", "sure add 10"),
      m("a2", "assistant", "Added 10 Buffalo Wings ($11.00)."),
    ],
  },
  {
    name: "cold_tone",
    expect: "flagged",
    expectCheck: "cold_tone",
    expectSeverity: "minor",
    ground: TENANT1_GROUND,
    transcript: [
      m("c1", "customer", "Hi! Excited to try you guys. Can I get a margherita?"),
      m("a1", "assistant", "Margherita. 14. Pay link sent."),
      m("c2", "customer", "ok thanks!"),
      m("a2", "assistant", "Confirmed."),
    ],
  },
];

// Clean batch (quiet-on-clean proof): all should produce zero flags.
export const CLEAN_BATCH: SeedCase[] = [
  SEED_CASES[0],
  {
    name: "clean_question",
    expect: "clean",
    ground: TENANT1_GROUND,
    transcript: [
      m("c1", "customer", "what time do you close today (friday)?"),
      m("a1", "assistant", "We're open until 10:00 PM on Fridays! Happy to start an order whenever you're ready. 😊"),
    ],
  },
  {
    name: "clean_two_item",
    expect: "clean",
    ground: TENANT1_GROUND,
    transcript: [
      m("c1", "customer", "caesar salad and a cannoli please"),
      m("a1", "assistant", "Yum! Caesar Salad ($9.00) and a Cannoli ($5.00) — that's $14.00. Name for pickup?"),
      m("c2", "customer", "Maria"),
      m("a2", "assistant", "Thanks Maria! Here's your secure link to pay $14.00 and lock it in."),
    ],
  },
];

// Cross-tenant isolation probe: a Tenant-1 (pizza) conversation ordering a
// Tenant-2 (sushi) item. Judged with T1 ground truth → MUST flag invented_item
// (sushi is not on NJB's menu). If T2's menu leaked in, it would be marked clean.
export const ISOLATION_CASE: SeedCase = {
  name: "isolation_probe_t1_orders_sushi",
  expect: "flagged",
  expectCheck: "invented_item",
  expectSeverity: "critical",
  ground: TENANT1_GROUND, // tenant 1's ground truth ONLY
  transcript: [
    m("c1", "customer", "can I get a spicy tuna roll?"),
    m("a1", "assistant", "Sure! One Spicy Tuna Roll ($8.00) coming up."),
    m("c2", "customer", "yes"),
    m("a2", "assistant", "Added. Your total is $8.00 — here's your pay link!"),
  ],
};
