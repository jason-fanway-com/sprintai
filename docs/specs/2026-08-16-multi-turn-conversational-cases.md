# Multi-Turn Conversational Test Cases — Standard Spec

**Date:** 2026-08-16
**Owner:** Lead (SprintAI_bot)
**Status:** Implements the "simulated" mode of the Shop Conversation Test Suite design spec (2026-08-13). Extends the suite from single-turn scripted cases to realistic, messy, multi-turn conversations.

## What changed

The Production Readiness suite now ships a **conversational category**: LLM-driven multi-turn cases where a customer-simulator plays a persona toward a goal, and the judge grades the **whole transcript** — not a single scripted exchange. This is what makes the suite a faithful rehearsal of a real customer, catching failures that scripted cases can't (drift, loops, lost context, partial-cart states).

## Standard composition (per shop)

```
100 total cases
├─ 85 single-turn (scripted)
│   ├─ 69 menu-derived  (generator.ts — happy-path/edge, built from the shop's own menu)
│   └─ 16 library       (library.ts — adversarial/compliance, menu-agnostic, every shop)
└─ 15 conversational    (library.ts — multi-turn, LLM customer-simulator)
```

The conversational count is fixed at 15; the menu-derived count floats to 69 to keep the total at 100. If a shop's menu is too small to yield 69 derived cases, the generator falls back gracefully (fewer derived cases, total drops below 100) rather than fabricating orders.

## Scenario taxonomy (the 15 conversational cases)

Each is a realistic, messy exchange that would be hard to script deterministically:

| id | Theme | Why it's multi-turn |
|---|---|---|
| conv-order-then-add | Add an item mid-conversation | Tests cart accumulation across turns |
| conv-swap-bread | Modify bread type after adding | Tests in-place modifier change |
| conv-cancel-item | Remove one item of several | Tests partial-cart removal |
| conv-ask-question-then-order | Hours/options Q first, then order | Tests context preserved across a detour |
| conv-vague-order | "something with egg" → clarify → order | Tests clarification loop |
| conv-multi-with-off-menu | One on-menu + one off-menu item | Tests partial accept + graceful decline |
| conv-upsell-declined | Upsell offered, declined | Tests no-pressure behavior |
| conv-upsell-accepted | Upsell accepted, upgrade applied | Tests modifier application |
| conv-pickup-only-clarification | Delivery asked at pickup-only shop | Tests permanent-pickup messaging |
| conv-why-expensive | Price challenge, then order anyway | Tests polite price defense |
| conv-typos-slang | Typos + slang, bot decodes | Tests robust interpretation |
| conv-topic-change-back | Off-topic detour, return to order | Tests focus recovery |
| conv-group-order | ~5 distinct items for an office | Tests multi-item capture + quantities |
| conv-off-menu-declined | Off-menu (sushi) declined, alternatives | Tests redirect to real menu |
| conv-full-checkout-flow | Full order → confirm → total + pickup | Tests end-to-end checkout |

## Multi-turn driving (runner.ts)

- **One `session_id` across all turns.** The bot's 24h conversation/cart reuse welds every turn to a single conversation, so the cart accumulates and the order state is real — this is the whole point of multi-turn. Each turn calls the chat-sms web endpoint with the **same** `session_id`.
- **Customer-simulator LLM** (`deepseek/deepseek-v4-flash` via OpenRouter) plays the persona. Per turn it receives the persona, goal, current phase, and turn count, and returns `{done, goal_reached, next_message}`.
- **Termination:** the simulator stops when the goal is satisfied, the conversation naturally ends, or `max_turns` (hard cap, ≤6) is hit. On API/parse failure it falls back to deterministic "stop" (`goal_reached=false`) so a run can't hang.
- **Unreached-goal annotation:** if the simulator runs out of turns without reaching the goal, the final assistant reply is annotated with a `[SYSTEM: goal not reached]` note so the judge sees the shortfall explicitly.

## Multi-turn judging (judge.ts)

- The **full transcript** (all turns) is passed to the shared rubric judge, not just the last exchange.
- Each case's `success_criteria` are injected as the grading focus on top of the standard rubric. A criterion with a mapped `check_id` fails iff that check fires; unmapped criteria fail on any critical/major flag (conservative).
- Judge post-processing (self-negating flag filter, `wrong_total` only-when-explicit-total filter) applies identically to conversational transcripts.

## Type model (library.ts)

```ts
interface ConversationalCase {
  id: string;                 // "conv-*" prefix
  category: "conversational";
  criticality: Criticality;   // "normal" by default
  label: string;
  persona: string;            // diner description for the simulator
  goal: string;               // what the customer wants by conversation end
  max_turns: number;          // hard cap on customer messages
  seed_message?: string;      // optional first message; else simulator generates it
  success_criteria: SuccessCriterion[];
}
type AnyCase = TestCase | ConversationalCase;
```

`isConversationalCase()` is the type guard that dispatches `runCase` to the conversational driver. `AnyCase` is carried through the runner/judge/scorecard/persist/fix pipeline unchanged.

## Safety

- Conversational cases obey the **same hard safety gate** as scripted cases: the runner refuses to run against a protected shop or one with a phone number, and never touches Twilio. The test clone has no `phone_number_e164`.
- The `test:true` web flag (gated to non-live Supabase keys) bypasses business hours and uses test Stripe — so conversations can run regardless of shop hours without touching real payment.

## Verification (Melvin)

- Multi-turn cases drive **several turns on one `session_id`** (not one-shot).
- Judge scores the **whole thread**, not a single exchange.
- Generator includes conversational cases for **any shop** (not just NJB).
- Full run persists; no regression vs the prior single-turn passing set.
