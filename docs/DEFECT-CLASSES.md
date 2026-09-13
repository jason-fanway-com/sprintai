# Defect classes — the register

**Purpose:** stop fixing the same bug five times.

A *defect class* is a root cause with more than one instance. When a root cause
is identified, it is registered HERE, with a runnable detection command, and
**every known site is swept before the fix is accepted** — not just the site
that happened to surface.

## The standing rule

> A root-cause fix is not accepted until the sweep output is attached: every
> site matching the class, each marked AFFECTED or SAFE with one line of why.
>
> "I fixed the reported instance" is a symptom fix. It gets rejected.

This is the PO's job to enforce and the PO failed to enforce it on
2026-09-11/12: class C1 below was correctly diagnosed on 09-11, written into a
dispatch as "find them all, not just this one", never swept, and then rediscovered
four more times by accident over the next day.

---

## C1 — Identity judged on rendered text instead of an id

**Diagnosed:** 2026-09-11, from the Vito's double-charge P0.
**Shape:** two pieces of OUR OWN data are compared by a human-readable string
when a stable id exists. A rename, a reformat or a transpile silently breaks the
link. It fails quietly — no error, no exception, just wrong behaviour.

**Instances found (6 in 2 days):**

| # | Site | Symptom |
|---|---|---|
| 1 | cart-line dedup | same item added twice, $29.98 for one $14.99 salad |
| 2 | judge `invented_item` | correct natural phrasing scored as a hallucination |
| 3 | harness hallucination-guard | "they're already set" read as an item name |
| 4 | judge ground truth | the $0.99 platform fee read as an invented charge |
| 5 | deploy gate step 6 | type-stripped bundle can never byte-match source |
| 6 | `applyCompiledAddItem`'s own identity check (ask-plan-engine.ts) | same real dish, same id, same options, TWO lines under two different display names ("Cheese - Large (16\")" vs "Large Cheese Pizza") — $42 for one pizza |

**Instance 6 detail (2026-09-12):** ironic given instance 1 was the same
SYMPTOM — this was a regression the ORIGINAL instance-1 fix didn't reach.
`fullyResolvedExistingIdx`/`identicalExisting` (the compiled engine's own
"is this the same order" check) required `!!ci.ask_plan_selections` on the
EXISTING line before it could even be considered a match — a structural
identity requirement, not a rename-resilience one. Any existing line that
never got that field populated (created by any path other than
`applyCompiledAddItem` itself — e.g. a pre-compile legacy `add_item`, or any
future path with the same gap) was invisible to the check no matter how
identical its `menu_item_id` + `options`, so a second, genuinely-identical
add always pushed a brand-new line under `askPlan.display_name` instead of
merging. Fixed: `isExistingLineFullyResolved` no longer requires the field's
presence — it falls back to "no `pending_options`" to decide completeness
when `ask_plan_selections` is absent, so the line is still found and merged.
Regression test: `ask-plan-engine.test.ts`, "C1 fix — an existing line added
via a DIFFERENT code path...".

**Detection:**

```bash
# our-data-to-our-data comparisons keyed on a name string
grep -rnE "(item_name|\.name|display_name)[^=]*(===|!==|\.includes\()" \
  --include="*.ts" supabase/functions scripts \
  | grep -viE "test\.ts|^\s*//" \
  | grep -iE "dedup|dupl|same|match|identit|exist|already|find|resolve"
```

**Triage rule.** Matching the CUSTOMER'S words against menu text is legitimate —
text is the only input available at that boundary. Comparing two records we own
is not. If both sides have an id, compare ids.

**Known remaining exposure (2026-09-12, unswept):** ~10 sites of the form
`option_groups.find(g => g.name === groupName)`,
`modifiers_json.find(m => m.name === modName)`,
`itemGroups.find(g => g.name === name)?.id`.
Each breaks if an owner renames an option group. Owners rename things — the
09-12 `display_name` rename is what exposed C1 instance #1. **Sweep required.**

**Cart-LINE identity enumeration (2026-09-12, PO-required — every site in
supabase/functions/chat-sms/ that decides "is this cart line the SAME item"
for merging/deduping/quantity-incrementing/matching an add against an
existing line, not the broader "any name string" grep above):**

| # | Site (file:line) | Verdict | Why |
|---|---|---|---|
| 1 | ask-plan-engine.ts:1001 `continuationIdx` | SAFE | `menu_item_id` only |
| 2 | ask-plan-engine.ts:~1052 `fullyResolvedExistingIdx` | **was AFFECTED, now FIXED** | instance 6 above — required `ask_plan_selections` presence on the existing line; now `menu_item_id` + `sameResolvedOptions` (human-meaningful options, id-independent by design since the 2026-09-11 Gyro fix — see that comment), with completeness inferred from `pending_options` when the field is absent |
| 3 | ask-plan-engine.ts:~1088 `identicalExisting` | **was AFFECTED, now FIXED** | same as #2 |
| 4 | ask-plan-engine.ts:1199 `modify_item` idx | SAFE (id-based) | `menu_item_id` only, first match — pre-existing design limitation (ambiguous across 2+ lines of the same item with different options) is NOT a name-vs-id bug and is unchanged/out of scope here |
| 5 | index.ts:1947 `resolvingPendingIdx` | SAFE | `menu_item_id` + pending-group match via `resolveOptionGroupByStoredKey` (id-snapshot fallback, C1 instance #1's own fix) |
| 6 | index.ts:1982 `existing` (legacy `add_item` merge) | SAFE | `menu_item_id` + `options` + `unverified_requests` + `modifiers`, all structural comparisons, no name field involved |
| 7 | index.ts:2126/2140 `remove_item`/`modify_item` idx | SAFE (id-based) | Same shape/caveat as #4 |
| 8 | guard9-unconsented-affirmation.ts `fingerprint`/`qtyBefore`/`qtyAfter` | SAFE | Keyed on `menu_item_id` (+ `options` in the fingerprint) |
| 9 | guard13-unconsented-quantity-growth.ts `beforeById` | SAFE | Keyed on `menu_item_id`; `item.name` is only read for the customer-words-named-it check (legitimate text-to-menu-text boundary per the triage rule) |
| 10 | guard21-unconsented-growth-no-signal-20260912.ts:86 `postLines` | SAFE | `menu_item_id` only |
| 11 | pizza-topping-compose.ts:166 | SAFE | `menu_item_id` used to look up the menu row's category; not an identity/dedup comparison |
| 12 | index.ts:6392 `targetLine` | SAFE | `menu_item_id` only |
| 13 | index.ts C2b-regular `baseMenuItem` lookup (`effectiveMenu.find(m => m.name... === regularItem.name...)`) | **AFFECTED (narrow, flagged not fixed)** | Two of OUR OWN records (the customer's historical `favorite_items[].name` snapshot vs the live menu's current `name`) compared by string. Failure mode is a silent no-op (falls through to the LLM), not an overcharge — no reported incident — but it is the exact C1 shape. Fixing requires storing `menu_item_id` on `favorite_items` (a schema change); out of scope for this ticket, recommended as a follow-up dispatch. |
| 14 | Option-group/choice NAME matches with NO id fallback: index.ts:6180, 8433 (`option_groups.find(g => g.name === groupName)`) | **AFFECTED (narrow, pre-existing, unswept)** | Same shape as the "known remaining exposure" list above — stored `pending_options` group name vs live `option_groups` name, no `resolveOptionGroupByStoredKey` fallback at these two sites. Non-money (a missing-options prompt/already-said check, not a price or duplicate-line risk). Already tracked in this file's own backlog; not part of THIS ticket's required fix. |
| 15 | Option-group/choice NAME matches that ARE customer/model-text-to-menu-text (index.ts:1742,1744,1830,1918,2066,2314,2316,2334,2339 and chat-sms-mtest mirrors) | SAFE per the triage rule | These match the model's OWN tool-call input or the customer's words against live menu text — the legitimate case the triage rule carves out, not two-of-our-own-records |

**Regression test added:** ask-plan-engine.test.ts, "applyCompiledAddItem: C1
fix — an existing line added via a DIFFERENT code path (no ask_plan_selections
field, legacy display name) still merges instead of spawning a second,
differently-named line" — pushes a pre-existing line with no
`ask_plan_selections` field (simulating any other code path) and a second
`applyCompiledAddItem` call for the identical `menu_item_id` + options; asserts
the cart collapses to ONE line, quantity 2, under the ORIGINAL line's name.
Fails without the fix (verified: reverting ask-plan-engine.ts alone reproduces
`cart.length === 2`), passes with it.

---

## C2 — Shipped, reported done, had no effect

**Diagnosed:** 2026-09-12.
**Shape:** code lands and is reported complete while a switch, a wiring step or
a deploy never happened. Indistinguishable from success unless verified against
the running system.

**Instances found (4 in 2 days):**

| # | Site | Why it did nothing |
|---|---|---|
| 1 | NJB compiled engine | built, deployed, flag never set |
| 2 | test runner `--cases` | equals-form silently ignored; ran 151 as 10 |
| 3 | GUARD 2b delivery fix | read a field the query never selected (TS2339) |
| 4 | `resolver.ts` | 603 lines, 597 lines of tests, zero imports |

**Countermeasures now in place:** `scripts/deploy-function.sh` (type-check, unit
tests, version-moved, artifact check) and `scripts/check-switches.sh`.

**Detection:** never accept a commit hash as evidence. Fetch the live artifact,
read the flag from the live DB, and reproduce the original defect.

---

## C3 — The measurement is wrong, and we react to it anyway

**Diagnosed:** 2026-09-12.
**Shape:** a metric is trusted as signal while its instrumentation is broken.
Work is then aimed at the metric instead of the product.

**Instances:** the suite's Quality score measured 40/50/70/60/90% on IDENTICAL
Vito's code across five runs. Every point of movement was judge or harness bugs:
ungraded counted as failed, self-negating flags, no knowledge of test mode or
the platform fee, truncated conversations scored as give-ups, scripted customers
that never answer the question.

**Countermeasure:** Proof, critical-pass and the money checks are the numbers.
Before reacting to a metric move, confirm the instrument changed nothing. Noise
on this suite is ±20 points; a 10-point move is not signal.

---

## C4 — A confirmation word anywhere in the message licenses an irreversible action

**Diagnosed:** 2026-09-12, from three Vito's incidents in one day. The PO caught
that instance 1's fix (43f34471/GUARD 21) and instance 2's fix (70af6255) were
both symptom patches on the SAME root cause, and required this class be
registered and swept before instance 3's fix was accepted — the standing rule
this file exists to enforce, applied to itself the same day it was written.

**Shape:** `impliesOrderConfirmation(text)` (guard9-unconsented-affirmation.ts)
is a substring test — it matches "yes"/"confirm"/"that's right"/etc. WHEREVER
they sit in a message, with no view of anything else the message also says. A
confirmation means "yes to what we just discussed"; several deterministic
pre-LLM shortcuts (built specifically to stop the model mishandling
high-stakes actions) trusted that match alone as license to fire an
IRREVERSIBLE action — send a real payment link — discarding whatever else the
same message asked for.

**Instances found (4 — 3 in one day, plus a 4th found the FIRST time this
class was reintroduced after an emergency revert, same conversation family,
Vito's):**

| # | Message | What got silently discarded | Fix |
|---|---|---|---|
| 1 | "Yes delivery. But I wanted a pepperoni pizza." | The pepperoni pizza never got added; empty cart | GUARD 21 (43f34471) — general backstop for cart growth on a turn with zero naming signal |
| 2 | "Show me the order. Yes it's for me." | The read request; a payment link went out unread | CART_SUMMARY_MENTION_RE + held C2b-name/D1 (70af6255) — narrow, READ-shaped only |
| 3 | "Yes to Jason. Can you add fries to that?" | The fries; a payment link went out for the wrong total | `hasNonConfirmationContent` (confirmation-with-other-intent-20260912.ts) — general, any residual content |
| 4 | Same message as #3, replayed after #3's own fix (2d6d55a1) correctly held the submit and fell through to the ordering loop — the ordering loop DID resolve the fries correctly, but **GUARD 9** (a REVERT, not a submit) then read the same bare "yes" as unconsented growth and silently deleted them anyway | The fries, again — this time discarded by the guard suite itself, downstream of a correct resolution, not by a premature submit | `computeGuard9`'s own trigger gated on `!hasOtherIntent` too (guard9-unconsented-affirmation.ts) — see instance 4's own write-up below |

Instance 2's fix was accepted as "the reported instance", not the class — it
built a regex specific to read-requests and wired it at exactly the two sites
instance 2 happened to hit. Instance 3 hit the SAME root cause through a THIRD
different sub-shape (a mutation, not a read) at a site instance 2's fix never
touched. Instance 4 is the same failure mode again: instance 3's fix (2d6d55a1)
was itself emergency-reverted the same day for exposing a second, unrelated
bug (C1, see above) — and when the class was reintroduced correctly this time,
live acceptance testing found that fixing the SUBMIT side (C2b-name/D1) was not
enough, because a REVERT (GUARD 9) downstream of the ordering loop turned out
to be gated on the exact same `impliesOrderConfirmation` substring test, with
no view of the same message's other content either. **The triage rule below is
widened accordingly: this class is not only about `submit_order`/payment
links — any code path that treats a bare confirmation match as license to
UNDO or DISCARD something the SAME message also asked for is in scope.**

**The general rule (now centralized in `hasNonConfirmationContent`,
confirmation-with-other-intent-20260912.ts):** strip confirmation words,
name-verification filler ("it's for me"), and the customer's own
already-known name from the message; if anything real survives, the message
is NOT a bare confirmation, and no irreversible action may fire on the
strength of it alone — the other content must be handled (applied, or
answered) first, or the confirmation must be re-asked once that other
content is resolved.

**Sweep (every `impliesOrderConfirmation`/name-shape call site, 2026-09-12):**

| # | Site | Verdict | Why |
|---|---|---|---|
| 1 | C2b delivery-again confirm (set_order_type/set_delivery_address) | SAFE | Action is reversible (no money moves); composes correctly with C2b-regular, which resolves item+modifier in the same turn |
| 2 | C2's `isFillerWord` check | SAFE | Negative exclusion only (keeps a filler word from being misread as a name), not an action trigger |
| 3 | C2 name→submit (`looksLikeName`) | **AFFECTED (narrow)** | A 3-word, punctuation-light compound ("Jason add fries") satisfied the shape check and would submit with the add silently dropped. Fixed: excludes any match containing the shared add/remove/swap vocabulary (`CHECKOUT_WANTS_CHANGE_RE`) |
| 4 | C2b-name (name-confirm→submit) | **AFFECTED** — instance 2 AND 3 both hit this site | Fixed: `hasNonConfirmationContent` gates the submit; a confirmed name is still safely recorded, only the submit itself is deferred |
| 5 | GUARD 2 / GUARD 2-pending (force a name/options re-ask) | SAFE | Not an irreversible action — forces a re-ask, never sends a link |
| 6 | D1 checkout-completion-driver | **AFFECTED** — instance 2 hit this site too | Fixed: same `hasNonConfirmationContent` gate |
| 7 | PROOF-P1 (checkout-finalize-always-writes-order) | SAFE | Triggered by the MODEL'S OWN reply text claiming confirmation, not the customer's message; fires after this turn's mutations already applied |
| 8 | GUARD 3 / PHANTOM-LINK GUARD (model claimed payment without submitting) | SAFE | Same reasoning as #7; also backstopped downstream by GUARD 22 |
| 9 | The model's own direct `submit_order` tool call inside the ordering loop | SAFE | Model's own agency, not a regex shortcut; backstopped by GUARD 22 (holds any checkoutUrl generated on a turn the cart also mutated) |
| 10 | **GUARD 9** (`computeGuard9`, unconsented-add-on-affirmation revert) | **AFFECTED — instance 4** | Gated its whole revert decision on `impliesOrderConfirmation(userMessage)` alone, with no view of the rest of the message. A brand-new line the ordering loop had JUST correctly resolved from the same message's own explicit request (e.g. "add fries") got read as unconsented growth and reverted, because the customer's own words don't always literally substring-match the resolved item's full menu name (menus with several similarly-named dishes — e.g. Vito's French Fries/Bacon Cheese Fries/Nacho Cheese Fries — deliberately never auto-alias a bare word like "fries" to just one of them). Fixed: `computeGuard9` takes a `hasOtherIntent` param and skips reverting a genuinely NEW line (never an existing line's quantity bump — see below) when it's true. |
| 11 | C2b-regular (`regularItemAuthorizedThisTurn`, pre-LLM regular-offer accept → `add_item`) | SAFE | Action is reversible (a cart add, not a submit); unlike GUARD 9's revert, adding the regular on a compound "yes + something else" turn is the CORRECT outcome either way — the customer wants the regular AND the something else, not one instead of the other |
| 12 | GUARD 13 / GUARD 21 (other unconsented-growth backstops) | SAFE (checked, not this class) | Neither gates on `impliesOrderConfirmation` at all — GUARD 13 fires on ANY unnamed quantity growth regardless of confirmation wording, GUARD 21 fires only when the message names NEITHER an item NOR a quantity. Confirmed by reading both modules directly, not assumed. |

**GUARD 9's own fix is deliberately NOT a blanket disable.** `hasOtherIntent`
only exempts a **brand-new line** (no matching before-fingerprint at all) from
reversion — an **existing line's quantity silently growing** gets no such
exemption, regardless of `hasOtherIntent`, because a request for something
else is no explanation for why a DIFFERENT, already-in-the-cart line's count
went up. That shape (same item, qty 1 → 2, no textual grounding) is a separate,
already-diagnosed incident — GUARD 21's own header, conv ce84c64b — and must
stay caught even on a turn that also carries real other content.

**Detection:**

```bash
# every call site of the confirmation substring-match, for the next sweep
grep -n "impliesOrderConfirmation(" supabase/functions/chat-sms/index.ts supabase/functions/chat-sms/*.ts
```

**Triage rule (widened 2026-09-12, instance 4).** Any call site that can result
in `submit_order` firing, a payment link being generated, an existing cart
mutation being SILENTLY REVERTED/UNDONE, or any other action that cannot be
cleanly undone must gate on `hasNonConfirmationContent`, not
`impliesOrderConfirmation` alone. A site that only forces a re-ask, reverts a
silent write, or reacts to
the MODEL's own already-post-mutation claim is not this class.

---

## Flagged, NOT fixed — false removal claim on modify_item (found 2026-09-12
## during the C1/C4 acceptance run, not part of either ticket)

While driving the 4-phrasing acceptance matrix for C1/C4 live (real DB, real
LLM, no synthetic state), "yep but drop the pepperoni" — the PO's OWN baseline
phrasing, believed already working — reliably reproduced a THIRD, DIFFERENT
defect, confirmed on both this fix's branch and the pre-fix `main` baseline
(so it predates and is unrelated to the C1/C4 work here): the model's reply
claims the topping was removed ("plain large cheese pizza", "no pepperoni")
while `cart_json` still shows `options: {"Toppings": ["Pepperoni (Whole
pizza)"]}` unchanged. 4/4 runs on this branch never actually removed it; the
same phrasing reproduced without ANY confirmation word present too ("actually
remove the pepperoni"), so this is not C4-shaped (no `impliesOrderConfirmation`
gating involved) — it looks like the model sometimes narrates a `modify_item`
outcome without ever issuing the tool call.

GUARD 16 (guard16-compiled-modifier-false-claim-20260907.ts) already exists for
the mirror-image case — a false claim of ADDING a modifier that isn't in
`ask_plan_selections` — but only checks additions, not removals; a false claim
of removal (modifier still present) is currently unguarded. Not investigated
further or fixed here — flagged per this file's own standing rule ("drift gets
flagged") rather than folded into an already-large, unrelated ticket. Needs its
own dispatch: likely a GUARD 16 extension (or a new guard) that also verifies
a reply claiming "no more X" / "removed X" / "plain" against the ACTUAL
post-tool-call cart, the same way GUARD 16 verifies addition claims today.
