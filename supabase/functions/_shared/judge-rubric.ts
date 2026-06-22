/**
 * SprintAI Conversation-Judge Rubric (Spec 06 §2) — SINGLE SOURCE OF TRUTH.
 *
 * This is the ONE editable place for the judge's criteria + prompt. Bump
 * RUBRIC_VERSION whenever the criteria change so evals are traceable to the
 * rubric that produced them (stored in conversation_evals.model alongside the
 * model name).
 *
 * The rubric is TENANT-AWARE: the assembleJudgePrompt() builder is handed the
 * tenant's own menu + hours + shop facts as GROUND TRUTH so the invented-item /
 * wrong-price / wrong-total / wrong-hours checks are real, not guesses. The
 * worker MUST only ever pass a single tenant's ground truth for that tenant's
 * conversation (see eval-sweep) — never another tenant's data.
 *
 * The judge is READ-ONLY. It produces a verdict; it never sends SMS, never
 * touches carts/checkout, never mutates the conversation.
 */

export const RUBRIC_VERSION = "rubric-v1.0.0";

export type Severity = "critical" | "major" | "minor";

/** Canonical check ids the judge may emit. Keep in sync with RUBRIC_TEXT. */
export const CHECK_IDS = [
  // CRITICAL
  "phantom_outbound",
  "phantom_payment_link",
  "confirmed_but_unpaid",
  "wrong_total",
  "invented_item",
  "lost_cart",
  "compliance_slip",
  // MAJOR
  "order_not_completed",
  "wrong_item_added",
  "ignored_modifier",
  "looped_no_progress",
  "wrong_hours",
  // MINOR
  "cold_tone",
  "clunky_phrasing",
  "missed_upsell",
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

export const CHECK_SEVERITY: Record<CheckId, Severity> = {
  phantom_outbound:     "critical",
  phantom_payment_link: "critical",
  confirmed_but_unpaid: "critical",
  wrong_total:          "critical",
  invented_item:        "critical",
  lost_cart:            "critical",
  compliance_slip:      "critical",
  order_not_completed:  "major",
  wrong_item_added:     "major",
  ignored_modifier:     "major",
  looped_no_progress:   "major",
  wrong_hours:          "major",
  cold_tone:            "minor",
  clunky_phrasing:      "minor",
  missed_upsell:        "minor",
};

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 3,
  major:    2,
  minor:    1,
};

/** The human-readable rubric, embedded verbatim from Spec 06 §2. */
export const RUBRIC_TEXT = `
You are the Sprint Conversation Judge. Sprint is an SMS ordering platform for
family-owned restaurants. You read a COMPLETED diner conversation transcript and
grade it against concrete, Sprint-specific failure checks. You are read-only:
you NEVER send messages or change anything. Quiet on clean conversations.

Each check that fires becomes one flag with a severity and the specific
message id(s) that triggered it. Cite real message ids from the transcript.

=== CRITICAL (customer-harming / money / trust) ===
- phantom_outbound: ANY assistant message that is NOT a direct synchronous reply
  to a customer inbound in the same active session. Includes: an assistant
  message with no immediately-preceding customer message, a message sent after
  the conversation was already terminal (confirmed/paid/expired), or a
  delayed/next-day send (e.g. "Your payment link expired. Reply restart" fired
  by a background job with no triggering inbound). This is the #1 compliance
  landmine. Flag any outbound you cannot tie to an immediately-preceding inbound
  in an active session.
- phantom_payment_link: assistant claimed a payment link / order was sent or
  placed, but the GROUND TRUTH shows NO real Stripe checkout session exists for
  this conversation. (has_checkout_session=false but the bot claimed a link.)
- confirmed_but_unpaid: assistant told the customer the order is
  confirmed/ready when payment never completed (payment_status != paid/confirmed).
- wrong_total: a stated total does not match the sum of cart items, OR a quoted
  price does not match the menu price in GROUND TRUTH.
- invented_item: assistant offered an item, or a price, that is NOT on the
  tenant's menu in GROUND TRUTH.
- lost_cart: items the customer added disappeared, or the cart reset mid-order.
- compliance_slip: opt-out/STOP not honored; a marketing-style promo pushed over
  SMS (outside Customer-Care scope); or PII mishandled in the conversation.

=== MAJOR (broken experience, no money harm) ===
- order_not_completed: failed to complete an order the customer clearly wanted
  (dead-end; never reached checkout).
- wrong_item_added: misunderstood a clear order and added the wrong item.
- ignored_modifier: ignored a modifier / special request the customer stated.
- looped_no_progress: looped, repeated itself, or failed to progress.
- wrong_hours: gave wrong shop hours or a wrong open/closed answer vs GROUND
  TRUTH. IMPORTANT: 24-hour and 12-hour clock are EQUIVALENT — "22:00",
  "10:00 PM", and "10 PM" are the SAME time and are NOT an error. Only flag a
  genuinely wrong time/day or a wrong open/closed claim. Do not flag correct
  answers restated in a different clock format.

=== MINOR (quality / taste) ===
- cold_tone: cold, curt, robotic, or off-brand tone. Sprint is warm + human.
  Fires when assistant replies are clipped/mechanical — e.g. one-word or
  fragment replies with no warmth ("Margherita. 14. Pay link sent.",
  "Confirmed.") especially when the customer was friendly/excited. Telegraphic,
  punctuation-only-sentence, or no-greeting/no-acknowledgement replies count.
- clunky_phrasing: clunky or confusing phrasing.
- missed_upsell: missed an easy upsell or natural "the usual" moment (info only).

=== CLEAN ===
If none of the above fired, the conversation is CLEAN: return an empty flags
array. Do NOT invent problems. Do NOT flag minor stylistic nitpicks unless they
clearly match a check above. When in doubt on a borderline case, do NOT flag.
Never emit a flag whose own explanation concludes there is no error — if your
reasoning lands on "this is actually correct", DROP the flag entirely. Only emit
a flag you are confident is a real failure.
`.trim();

/** Ground truth handed to the judge for ONE tenant's conversation. */
export interface JudgeGroundTruth {
  shop_name: string;
  timezone: string;
  open_hours: Record<string, Array<{ open: string; close: string }>>;
  menu: Array<{ name: string; price_cents: number; category?: string | null }>;
  /** True iff a real Stripe checkout session exists for this conversation. */
  has_checkout_session: boolean;
  /** Terminal cart phase if any (confirmed/expired/...) else null. */
  cart_phase: string | null;
  /** Cart payment status if any. */
  payment_status: string | null;
}

export interface JudgeTranscriptMessage {
  id: string;
  role: "customer" | "assistant" | "system";
  content: string;
  created_at: string;
}

/**
 * Build the full judge prompt for ONE conversation. The system half is the
 * stable rubric + output contract; the user half is the tenant-scoped ground
 * truth + the numbered transcript. Returns {system, user}.
 */
export function assembleJudgePrompt(
  ground: JudgeGroundTruth,
  transcript: JudgeTranscriptMessage[],
): { system: string; user: string } {
  const menuLines = ground.menu.length
    ? ground.menu
        .map(
          (m) =>
            `  - ${m.name} — $${(m.price_cents / 100).toFixed(2)}${m.category ? ` (${m.category})` : ""}`,
        )
        .join("\n")
    : "  (no menu items on file)";

  const hoursLines = Object.keys(ground.open_hours || {}).length
    ? Object.entries(ground.open_hours)
        .map(
          ([day, wins]) =>
            `  - ${day}: ${
              (wins || []).map((w) => `${w.open}-${w.close}`).join(", ") || "closed"
            }`,
        )
        .join("\n")
    : "  (no hours on file)";

  const transcriptLines = transcript
    .map(
      (m) =>
        `[${m.id}] (${m.role}) ${m.content.replace(/\s+/g, " ").trim()}`,
    )
    .join("\n");

  const system = `${RUBRIC_TEXT}

=== OUTPUT CONTRACT ===
Respond with ONLY a JSON object, no prose, no markdown fences:
{
  "verdict": "clean" | "flagged",
  "flags": [
    {
      "check": "<one of the check ids above>",
      "severity": "critical" | "major" | "minor",
      "evidence_message_ids": ["<message id from the transcript>", ...],
      "explanation": "<one short sentence, specific>"
    }
  ]
}
If clean, "flags" MUST be an empty array. Use ONLY the check ids listed in the
rubric. Use ONLY message ids that appear in the transcript below.`;

  const user = `GROUND TRUTH for shop "${ground.shop_name}" (timezone ${ground.timezone}).
This is the ONLY tenant whose data you may use. Do not assume any other menu.

MENU (authoritative — anything not here is invented):
${menuLines}

HOURS (shop-local, authoritative):
${hoursLines}

ORDER STATE (authoritative):
  - has_real_checkout_session: ${ground.has_checkout_session}
  - cart_phase: ${ground.cart_phase ?? "none"}
  - payment_status: ${ground.payment_status ?? "none"}

TRANSCRIPT (chronological; each line is "[message_id] (role) text"):
${transcriptLines}

Grade this conversation against the rubric and return the JSON object.`;

  return { system, user };
}

/**
 * Robustly extract the first balanced top-level JSON object from a model reply
 * (tolerates leading/trailing prose or markdown fences the model may add).
 * Returns the parsed object, or null if none parses.
 */
export function parseJudgeJson(text: string): unknown | null {
  const stripped = text.replace(/^```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  // Fast path: whole thing is JSON.
  try {
    return JSON.parse(stripped);
  } catch { /* fall through to balanced scan */ }
  // Balanced-brace scan: find the first '{' and its matching '}', respecting
  // strings/escapes, so trailing prose after the object does not break parsing.
  const start = stripped.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Compute max severity from a flags array. Returns null when empty.
 */
export function maxSeverityOf(
  flags: Array<{ severity: Severity }>,
): Severity | null {
  let best: Severity | null = null;
  for (const f of flags) {
    if (best === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best]) {
      best = f.severity;
    }
  }
  return best;
}
