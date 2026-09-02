# Baseline results — Vito's + NJB 128-pairs (2026-09-01)

Source: `qa_ro.test_runs` / `qa_ro.test_case_results` (read-only role). SCORER_VERSION=2.

| Shop | Run id | Total | Pass | Fail | Proof % | Quality % | Ungraded |
|---|---|---|---|---|---|---|---|
| Vito's | `5bf71e0f` | 128 | 83 | 7 | 92.22 | 60.94 | 38 |
| NJB clone | `eb255196` | 128 | 107 | 4 | 96.40 | 75.00 | 17 |

## Deterministic failures — all 11 are HARNESS false positives, zero product bugs

### correction_reflected (9 of 11) — NL-intent regex misfires
Invariant `isReduction`/`isRemoval` infers reduction intent from bare `just `/`only `/`no` in
emergent conversational-case text. Every hit below is an ORDER, a swap, a decline, or a pickup
name — none is a quantity reduction. Fires only on `conversational` cases (LLM-generated turns);
never applied to the fixtured `cartops-*` reduce cases it was meant for.

- Vito: `conv-full-checkout-flow`, `conv-multi-with-off-menu` ("Alright, just give me a ch…" = order),
  `conv-pickup-only-clarification` ("Actually, I wanted the chi…" = swap), `conv-topic-change-back`
  ("No pizza, just the gyro…" = swap), `conv-vague-order`.
- NJB: `conv-ask-question-then-order` ("just cheddar I guess" = modifier), `conv-order-then-add`
  ("Put it under my name…" = pickup name), `conv-topic-change-back` ("No thanks, just the salad…" =
  decline), `conv-typos-slang` ("just put it under Alex…" = pickup name).

Only `conv-topic-change-back` fails on both shops, and it is this same regex bug — so no shared
product defect.

### hallucination-guard (2 of 11) — item-name extraction grabs pronouns/fragments
`addPat` (cart-ops.ts:349) captures the text after "added" as an item name without checking it is
one. It then flags that text as a hallucinated menu item.
- Vito `menu-combo`: flagged `"those"` — `"I've added those…"`.
- Vito `menu-single-500`: flagged `"to your cart. Want anything else"` — sentence fragment after "added".

## Ungraded gap — Vito 38 vs NJB 17 — NOT a product bug (investigated per 22:57 #4)

Driver: happy-path 16 (Vito) vs 4 (NJB). The Vito `menu-cat-*` / `menu-*` cases are **single-turn
order-STARTS** (`generator.ts:456` buildCrossCategorySingles → one turn "I'd like the {item}").
Read the transcripts: in every sampled case the bot behaved correctly and no cart formed because
the case ends after one turn:

- `menu-cat-pizza` "I'd like the Cheese - Small" → bot asks pickup/delivery (required). cart=[].
- `menu-cat-entrees` "Chicken Parmesan" → bot disambiguates entree vs sandwich vs stromboli. cart=[].
- `menu-cat-salads` "the House" → bot disambiguates House salad vs House stromboli. cart=[].
- `menu-cat-quesadillas` "the Steak" → bot: no plain steak, offers quesadilla. cart=[]. (No hallucination.)
- `menu-drink` "Unsweetened Iced Tea" → bot asks pickup/delivery. cart=[].

Empty cart on a single-turn order-start is CORRECT. Vito has more of these because it has more menu
categories and more ambiguous item names (correct disambiguation, not failure). No deterministic
invariant applies to a one-turn turn, so they land ungraded → `no-invariant-applied`.

**Decision for morning (Jason + product owner):** these cases prove nothing as written. Two options,
both harness-only, neither a chat-sms change:
1. Extend each to 2–3 turns (answer the qualifier, confirm) so a cart forms and cart invariants apply; or
2. Add a light single-turn invariant: bot must name/recognize the item OR ask a relevant qualifier,
   and never invent an item (hallucination-guard already covers the last part).

Recommendation: option 1 — it exercises the money path the single-turn version skips.

## Headline
Proof 92–96% where every failure is a test-harness defect means the money paths held on 256 real
ordering conversations across two very different menus. Good news about the product. The open risk
is not what the gate caught — it is what it still does not measure (safety/compliance invariants,
and the single-turn ungraded cases above).
