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

**Instances found (5 in 2 days):**

| # | Site | Symptom |
|---|---|---|
| 1 | cart-line dedup | same item added twice, $29.98 for one $14.99 salad |
| 2 | judge `invented_item` | correct natural phrasing scored as a hallucination |
| 3 | harness hallucination-guard | "they're already set" read as an item name |
| 4 | judge ground truth | the $0.99 platform fee read as an invented charge |
| 5 | deploy gate step 6 | type-stripped bundle can never byte-match source |

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

**Instances found (3 in 1 day, same conversation family, Vito's):**

| # | Message | What got silently discarded | Fix |
|---|---|---|---|
| 1 | "Yes delivery. But I wanted a pepperoni pizza." | The pepperoni pizza never got added; empty cart | GUARD 21 (43f34471) — general backstop for cart growth on a turn with zero naming signal |
| 2 | "Show me the order. Yes it's for me." | The read request; a payment link went out unread | CART_SUMMARY_MENTION_RE + held C2b-name/D1 (70af6255) — narrow, READ-shaped only |
| 3 | "Yes to Jason. Can you add fries to that?" | The fries; a payment link went out for the wrong total | `hasNonConfirmationContent` (confirmation-with-other-intent-20260912.ts) — general, any residual content |

Instance 2's fix was accepted as "the reported instance", not the class — it
built a regex specific to read-requests and wired it at exactly the two sites
instance 2 happened to hit. Instance 3 hit the SAME root cause through a THIRD
different sub-shape (a mutation, not a read) at a site instance 2's fix never
touched. That is exactly what this file exists to prevent.

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

**Detection:**

```bash
# every call site of the confirmation substring-match, for the next sweep
grep -n "impliesOrderConfirmation(" supabase/functions/chat-sms/index.ts
```

**Triage rule.** Any call site that can result in `submit_order` firing, a
payment link being generated, or any other action that cannot be cleanly
undone must gate on `hasNonConfirmationContent`, not `impliesOrderConfirmation`
alone. A site that only forces a re-ask, reverts a silent write, or reacts to
the MODEL's own already-post-mutation claim is not this class.
