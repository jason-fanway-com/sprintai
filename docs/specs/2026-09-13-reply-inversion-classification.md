# Reply-inversion classification (analysis only, no code changed)

Source spec: `docs/specs/2026-09-13-reply-inversion.md` (86a26fe4).
Target file: `supabase/functions/chat-sms/index.ts` (9,643 lines at time of this pass).

This document is read-only analysis. Nothing in `index.ts` was modified to produce it.

## Method

`grep -n -E '\breply\s*=' supabase/functions/chat-sms/index.ts` returns **68** lines.
One is a false positive: line 4023 is `typeof (data as Record<string, unknown>).reply === "string"` — a
type comparison inside a ternary, not an assignment to a variable named `reply`. That leaves **67 real
assignment/reassignment sites** to something named `reply`, including the one at line 3259 inside
`runOrderingLoop` (a different function/scope than the main handler's `let reply` at line 7354, but it
is the site where the model's raw text first becomes a `reply` value that is later threaded out as
`loopResult.reply` and assigned into the handler's `reply` at line 7410).

No `reply +=` sites exist. No line contains two `reply =` occurrences (68 line-matches = 68 total
occurrences, confirmed with `grep -oE`).

## Part 1: Reply-site classification (67 sites)

Legend — **FACT**: asserts items/quantities/prices/totals, must render from `cart_json`. **VOICE**:
greeting/apology/clarifying question/warmth, no cart-content assertion. **MIXED**: reply string contains
both a code-rendered fact fragment and either raw/scrubbed model prose or a directly-interpolated
fact fragment that bypasses the shared renderers.

"Renderer" column: **itemizer** = `renderItemizedRecap`/`renderLedgerFooter` (itemizer.ts, the spec's
named target renderers). **dedicated** = a different but still code-only template function
(`renderMissingOptionsPrompt`, `renderDisambiguationReask`, `honestFallbackReply`, `buildResetReply`,
`nameConfirm`, `candidateOptionText`, `renderStepQuestion`). **direct** = cart/item data is
string-interpolated inline at the call site, not through any shared function. **none** = no cart data
present (pure literal/ternary of literals). **raw-model** = the model's own text, unfiltered or only
lightly scrubbed.

| # | Line | Snippet | Class | Renderer | Why |
|---|------|---------|-------|----------|-----|
| 1 | 3259 | `const reply = textBlocks.map(b => b.text ?? "").join("").trim();` | MIXED (model-authored, content unknown until runtime) | raw-model | This is the *origin* of the model's free text becoming a reply at all. Nothing here constrains what the model said — it could enumerate items, quote a total, or just say hello. This is the taproot of the whole defect class; every downstream guard is a patch on what comes out of this line. |
| 2 | 5642 | `const reply = buildResetReply(effectiveOpen);` | VOICE | dedicated (`buildResetReply`) | Reset acknowledgement + hours status; no cart contents/prices. |
| 3 | 5651 | `const reply = "Your order is confirmed and paid. Thank you!";` | VOICE | none | Literal, no cart data. |
| 4 | 5683 | `` const reply = `Here's your order:\n\n${recap}${linkLine}`; `` | MIXED | itemizer (`recap = renderItemizedRecap(...)`) + direct (`linkLine`) | The FACT half (item list, prices) is itemizer-rendered. `linkLine` is a code literal about the payment link, not model text — this site is already fully code-authored end to end (no model prose at all), so it's "MIXED" only in the sense of two code fragments, not a hallucination risk. |
| 5 | 5694 | `const reply = "No problem! Starting fresh. What would you like to order?";` | VOICE | none | Literal. |
| 6 | 5798 | `const reply = isRepeatCheck ? "..." : "...";` | VOICE | none | Two literal checkout-reminder strings, no digits/items. |
| 7 | 5835 | `const reply = "Sorry, our menu is not available right now...";` | VOICE | none | Literal. |
| 8 | 6079 | `const reply = pending.action === "remove_option" ? "..." : "...";` | VOICE | none | Two literal decline acks. |
| 9 | 6100 | `const reply = "That option isn't on that item anymore — anything else?";` | VOICE | none | No item name or price stated. |
| 10 | 6124 | `` const reply = removeResult.ok ? `Removed ${target.matched_value} from the ${target.name}.${footerOptRemove...}` : "..."; `` | MIXED | itemizer for footer; **direct** for the removed-option/item names | The removal fact (which option, which item) is a raw template-string interpolation of `target.matched_value`/`target.name` — this is code (not model), but it is *not* routed through `renderItemizedRecap`, so it's a second, parallel "fact-rendering" path outside the itemizer. Money footer is itemizer-rendered. |
| 11 | 6163 | `` const reply = addResult.ok ? `Got it — ${candidateNameForConfirm(resolved)} added.${footerGuard7...}` : "..."; `` | MIXED | itemizer for footer; **direct** for item name | Same shape as #10 — deterministic code, but the item-name fact bypasses the shared itemizer. |
| 12 | 6504 | `` const reply = !modResult.ok ? "..." : nextQuestion ? `Got it — ${appliedNames}. For the ${nextQuestion.item_name}...` : `Got it — ${appliedNames} on the ${pendingQuestion.item_name}...`; `` | MIXED | itemizer for footer; **direct** for `appliedNames`/item names | `appliedNames` is built by joining resolved choice names directly (line 6503), not through itemizer. |
| 13 | 6573 | `` const reply = removeResult.ok ? `Removed ${target.matched_value} from the ${target.name}.\n\n${receiptOptRemove}...` : "..."; `` | MIXED | itemizer (`receiptOptRemove = renderItemizedRecap(...)`) for the full receipt; **direct** for the removed-option clause | Same pattern as #10 but this one *also* attaches a full itemized receipt afterward — belt-and-suspenders, but the leading sentence is still a parallel direct-interpolation fact path. |
| 14 | 6592 | `` const reply = `Which one did you want to remove ${optionRemovalPhrase} from? ${listStr}. Reply with the number.`; `` | FACT | **direct** | `listStr` is built at line 6591 (`m.name`, `m.price_cents` joined manually) — a candidate list with real prices, entirely deterministic/code, but not through any shared renderer. |
| 15 | 6623 | `const reply = "Just to make sure — did you want to remove your last item, or are you all set...";` | VOICE | none | No item/price named. |
| 16 | 6692 | `` const reply = `I don't see "${capturedName}" in your cart — you currently have: ${cartNames}...`; `` | FACT | **direct** | `cartNames` lists every current cart item's name — deterministic, but a hand-built join, not itemizer. |
| 17 | 6700 | `` const reply = `Which one did you want to remove? ${listStr}. Reply with the number.`; `` | FACT | **direct** | Same shape as #14 — cart-line names listed manually. |
| 18 | 6981 | `` const reply = `Here's your order:\n\n${recap}\n\nPutting this in for ${customerContext.name}, right?`; `` | MIXED | itemizer (`recap`) + none (name confirm) | Fully code-authored; recap via itemizer, name-confirmation is a literal template. |
| 19 | 7379 | `reply = "placeholder";` | N/A | none | Immediately overwritten by the deterministic checkout-URL handler later in the same turn (comment says so explicitly); never reaches a customer as-is. |
| 20 | 7385 | `reply = deliveryOfferDeterministicReply;` | VOICE/FACT (content-dependent, but code-authored) | dedicated (message built by `set_delivery_address`'s own code path, ~line 6767–6796) | Not model text — a deterministic message string assembled elsewhere in the same file when a delivery-address confirmation fails/succeeds. Not routed through itemizer, but also never model-authored. |
| 21 | 7410 | `reply = loopResult.reply;` | MIXED/FACT-capable | **raw-model** | **This is the single highest-value site in the whole file.** It assigns the model's own free text (see #1) straight into the handler's `reply`, with zero constraint on content. Every guard from here to the end of the function exists to catch what this one line lets through. This is the exact site the 19:07 Vito's transcript exploited: the model was free to enumerate "three items" here and nothing downstream caught it (see Part 2). |
| 22 | 7443 | `reply = deferSlotQuestionForOrderType ? stripDeferredStepQuestion(reply, ...) : enforceVerbatimStepQuestion(reply, ...);` | MIXED | dedicated (verbatim step-question text is forced in/out) | Only the *step-question clause* is deterministically enforced; the rest of `reply` is still whatever the model wrote at #21, untouched by this call. |
| 23 | 7457 | `reply = grounded;` (`stripInventedActions(reply)`) | MIXED | scrubber, not a renderer | Removes invented "I'll check with the kitchen" promises only. Item/price prose, if any, passes through unchanged. |
| 24 | 7552 | `` reply = cartItems.length > 0 ? `Got it! Here's where things stand:\n\n${renderItemizedRecap(...)}\n\nAnything else?` : "What would you like to order?"; `` | FACT | **itemizer** | Reconciler-corrected cart rendered from `cart_json` directly; this is one of the 14 "already-right" sites the spec references. |
| 25 | 7616 | `reply = honestFallbackReply(guardCart, false, !isLifetimeFirstContact);` | VOICE | dedicated (`honestFallbackReply`) | Inspected the function body (index.ts:3524-3535): it never lists items or prices — it's a name-prompt or generic "what would you like" message, branching only on cart emptiness/bundle-completeness, not on cart *contents*. Safe by construction. |
| 26 | 7619 | same call | VOICE | dedicated | Same function, exception path. |
| 27 | 7622 | same call | VOICE | dedicated | Same function, P1-tripped path. |
| 28 | 7667 | `` reply = `Your cart:\n\n${renderItemizedRecap(cartItems, ...)}\n\nAnything else or ready to checkout?`; `` | FACT | **itemizer** | PROOF-P2 cart-restore path; already correct. |
| 29 | 7685 | `reply = "I don't have anything in your cart yet. What would you like to order?";` | VOICE (trivially true) | none | Only reached when `guardCart.length === 0` is already verified by the guard's own `if` — the "fact" (empty cart) is a pre-verified boolean gate, not an assertion built from unverified data. |
| 30 | 7697 | `reply = "Sorry, I described that wrong. What can I get started for you?...";` | VOICE | none | Generic apology, no item claim. |
| 31 | 7717 | `reply = kept.length >= 15 ? kept : "Let me get that started for you!...";` | MIXED | none for literal branch; **raw-model** (scrubbed) for `kept` | `kept` is the model's own reply with one offending sentence removed — everything else is still unverified model prose. |
| 32 | 7730 | `reply = honestFallbackReply(guardCart, false, !isLifetimeFirstContact);` | VOICE | dedicated | Same as #25-27. |
| 33 | 7752 | `reply = fallback;` (one of two literals per `guardCart.length`) | VOICE | none | Neither literal names an item or price. |
| 34 | 7778 | `reply = "Sorry, I didn't actually add that — let me try again...";` | VOICE | none | Literal. |
| 35 | 7806 | `` reply = `Sorry, that didn't go through — could you say "${[...named1f].join('", "')}" again?`; `` | VOICE | direct (but echoes the **customer's own** words, not cart state) | `named1f` is extracted from the customer's own message this turn, not from `cart_json` — it is not a claim about what's in the cart. |
| 36 | 7808 | `` reply = `Sorry, that didn't go through — want me to add your usual, the ${regularItem.name}?`; `` | VOICE (a question, not an assertion) | direct | Phrased as an offer/question, not "X is in your cart." Still names an item directly rather than through a renderer, but it does not assert cart state. |
| 37 | 7810 | `reply = "Your cart is empty. What would you like to order?";` | VOICE (trivially true) | none | Reached only when `guardCart.length === 0`, same reasoning as #29. |
| 38 | 7819 | `` reply = `Your cart:\n\n${renderItemizedRecap(guardCart)}\n\nWhat else can I add?`; `` | FACT | **itemizer** | GUARD 1f cart-not-empty branch; already correct. |
| 39 | 8053 | `reply = renderDisambiguationReask(guard7CandidatesForPending, priorReplyTextGuard7);` | FACT | **dedicated** (`renderDisambiguationReask`, pending-disambiguation.ts) | Lists real candidate items/prices for a forced numbered re-ask; code-only. |
| 40 | 8062 | `` reply = `We've got a couple options called "${menuItem.name}" — ${optionsText}. Which one?`; `` | FACT | **dedicated** (`candidateOptionText` per-candidate) + direct join | `optionsText` built from `candidateOptionText()` calls, a small dedicated helper, but the surrounding sentence and join are inline, not itemizer. |
| 41 | 8129 | `reply = renderDisambiguationReask(guard7bCandidatesForPending, priorReplyTextGuard7b);` | FACT | **dedicated** | Same as #39, GUARD 7b's backstop. |
| 42 | 8348 | `` reply = repeated && shop.phone_number_e164 ? `${reply} ${question} If texting isn't...` : `${reply} ${question}`.trim(); `` | MIXED | dedicated (`question = renderStepQuestion(...)`) appended to **raw-model** prefix | The appended clause is a code-rendered canonical step question. The `${reply}` prefix is whatever survived every guard above it — still potentially raw/lightly-scrubbed model prose. |
| 43 | 8376 | `` if (!reply.includes(sentence)) reply = `${reply} ${sentence}`.trim(); `` | MIXED | none for the appended sentence (a fixed warning, no cart facts); prefix is **raw-model** | The append itself is safe VOICE text ("could you tell me again..."); the risk is entirely in the untouched `${reply}` prefix. |
| 44 | 8427 | `` reply = orderableSiblings.length > 0 ? `${reply} Correction — ... What IS available in that category: ${[...new Set(orderableSiblings)].join(", ")}.` : `${reply} Correction — ...`; `` | MIXED | direct (menu item names joined inline) appended to **raw-model** prefix | Appended fact list is deterministic (from `effectiveMenu`) but hand-joined, not itemizer; prefix risk as above. |
| 45 | 8578 | `` reply = `${reply} Just to be clear — I couldn't confirm "${asksText1216}" as an option here...`; `` | MIXED | direct append to **raw-model** prefix | `asksText1216` is a deterministic, deduped list of unconfirmed option asks — code-built, not itemizer-routed. |
| 46 | 8774 | `` reply = `${reply} Just to be clear — ${itemNames17} doesn't have that kind of option here...`; `` | MIXED | direct append to **raw-model** prefix | Same shape as #45, GUARD 17. |
| 47 | 8843 | `` reply = `${reply} ${missingClauses.join(" ")}`; `` | MIXED | direct append to **raw-model** prefix | `missingClauses` names menu items + option groups directly (GUARD 8); deterministic but not itemizer-routed, and prefix is still raw model prose. |
| 48 | 8940 | `reply = renderMissingOptionsPrompt(guardCart.filter(...).map(...));` | FACT | **dedicated** (`renderMissingOptionsPrompt`, sequencer.ts) | Full replace; GUARD 10's revert path. Already correct. |
| 49 | 9057 | `reply = guardCart.length > 0 ? "Sorry, which item did you want more of?" : "Sorry, which item would you like?...";` | VOICE | none | Neither literal names a specific item. |
| 50 | 9081 | `` reply = `Here's our full menu — take a look and let me know what you'd like: https://getsprintai.com/m/${shop.slug}`; `` | VOICE | none | A link, not a cart-content claim. |
| 51 | 9102 | `reply = renderMissingOptionsPrompt(guardPendingItems.map(...));` | FACT | **dedicated** | GUARD 2-pending; already correct. |
| 52 | 9112 | `reply = customerContext?.name ? nameConfirm(customerContext.name) : NAME_ASK;` | VOICE | dedicated (`nameConfirm`) / none (`NAME_ASK`) | Confirms/asks the customer's *name*, not cart contents. |
| 53 | 9178 | `reply = stripped;` (`repairOrphanedPunctuation(stripLlmMoneyLines(reply))`) | MIXED | scrubber, not a renderer | GUARD 2c: strips money figures from the model's own sentence, keeps everything else (including any item enumeration) untouched. |
| 54 | 9183 | `` reply = `Your cart:\n\n${renderItemizedRecap(guardCart)}\n\nWhat else can I add?`; `` | FACT | **itemizer** | GUARD 2c fallback-to-recital path; already correct. |
| 55 | 9209 | `` reply = `All set! Here's your order:\n\n${renderItemizedRecap(guardCart, guardDeliveryFee, guardDriverTip)}\n\nPayment link — tap to finish: ` + submitResult.checkoutUrl; `` | FACT | **itemizer** | D1 checkout-completion success path; already correct. |
| 56 | 9228 | `reply = renderMissingOptionsPrompt(pending);` | FACT | **dedicated** | D1 submit_order-failed, pending-options path. |
| 57 | 9230 | `reply = "Pickup or delivery today?";` | VOICE | none | Literal. |
| 58 | 9232 | `reply = "What's the delivery address?";` | VOICE | none | Literal. |
| 59 | 9234 | `reply = NAME_ASK;` | VOICE | none | Literal constant. |
| 60 | 9237 | `` reply = errMsg ? `I couldn't finish that — ${errMsg}` : "I couldn't finish that order — let's try again."; `` | MIXED (code-generated, not model) | direct | `errMsg` is `submit_order`'s own structured error string (e.g. a missing-field reason), not model prose — deterministic but not itemizer-routed. Low risk (system-authored), still worth noting as an inline fact path. |
| 61 | 9334 | `reply = "Your payment link was already sent -- check your texts or email for it...";` | VOICE | none | Literal. |
| 62 | 9361 | `reply = honestFallbackReply(guardCart, false, !isLifetimeFirstContact);` | VOICE | dedicated | Same function as #25-27, #32; no item/price enumeration. |
| 63 | 9365 | same call | VOICE | dedicated | Same. |
| 64 | 9370 | `reply = honestFallbackReply(guardCart, !!incompleteBundle, !isLifetimeFirstContact);` | VOICE | dedicated | Same. |
| 65 | 9397 | `reply = stripLlmMoneyLines(reply);` | MIXED | scrubber, not a renderer | Phase A: strips LLM-emitted totals/fees/status lines. Item-enumeration prose (the actual 19:07 defect) is not a "money line" and is NOT stripped by this call. |
| 66 | 9417 | `reply = renderMissingOptionsPrompt(pendingForPrompt);` | FACT | **dedicated** | HARD GATE override when a name-ask coincides with unresolved required options. |
| 67 | 9430 | `` reply = `${reply}\n\n${footer}`; `` (`footer = renderLedgerFooter(...)`) | MIXED | **itemizer** for the footer; prefix is **raw-model** (scrubbed by #65 only) | **This is the exact shape of the 19:07 Vito's incident.** The money footer is itemizer-rendered and therefore always arithmetically correct — which is precisely why the spec's "no guard caught it" transcript still had a *consistent* total: the footer was right, the model's own item-enumeration sentence prefixed onto it was not, and nothing between #21 and here re-verifies item-count/identity in the prefix (only money is scrubbed, at #65/#53). |

### Total count

**67** real `reply =` sites (68 regex matches minus 1 false positive at line 4023). The spec's claim of "48" undercounts by 19; a prior pass's "66" was one short — the discrepancy is exactly the runOrderingLoop-internal site (#1, line 3259), which is easy to miss because it's in a different function/scope than the handler's `let reply` at line 7354 and doesn't share its type declaration.

Of the 67: **12 already route their FACT content fully through `renderItemizedRecap`/`renderLedgerFooter`/`renderMissingOptionsPrompt`/`renderDisambiguationReask`** end-to-end with no raw model prose attached (#24, 28, 38, 39, 41, 48, 51, 54, 55, 56, 66, and the footer-only half of #67 — see Part 3 for the precise "not yet done" count, which nets out differently because several of these are MIXED with a still-raw prefix).

## Part 2: Guard census

Distinct guard identifiers found in the file (via `grep -n -E '^\s*//\s*(──\s*)?(GUARD|Guard|PROOF)'` plus cross-references), separated into **active** (code still runs) and **retired/dead** (comment/header remains, no live code path):

**Active (31):** Guard C (2953, saveCart phase downgrade — different function, not part of the reply chain), Guard 1 (7679), 1b (7688), 1c (7734), 1d (7756), 1e (7700), 1f (7782), 1g (7721), Guard 2 (9084), 2b (9243), 2c (9115), Guard 3 (9296, "POST-TURN PHANTOM-LINK SAFETY NET"), Guard 4 v3 (7824), Guard 7 (7954), 7b (8080, no separate header but a distinct live `else` branch of Guard 7), 7c (6186), Guard 8 (8778), Guard 10 (8847), Guard 11 (8146), Guard 12 (8196), Guard 15 (8380), Guard 16 (8433), Guard 17 (8581), Guard 19 (9021), Guard 22 (9553), Guard F (9439, "fake-checkout gate"), the unnumbered "stale pending option unaddressed" guard (8321, D3/D5 fix), the unnumbered "unresolved named segment" guard (8356, D1 fix), the unnumbered "menu link" guard (9069), PROOF-P1 (7602), PROOF-P2 (7645).

**Retired/dead (6):** Guard 9 (comment block at 8948-8994 says "retired 2026-09-12... Replaced by the turn reconciler above" — confirmed: lines 8948-9020 are 100% comments, zero executable code), Guard 13 (retired 2026-09-12, replaced by the reconciler's idempotency rule), Guard 18 (attempted 2026-09-08, pulled before shipping, its file and tests deleted 2026-09-11 — never wired), Guard 20 (retired 2026-09-12, replaced by turn reconciler), Guard 21 (retired 2026-09-12, replaced by turn reconciler), PROOF Guard P3 (removed 2026-08-30 per its own "REMOVED" comment at line 7672-7677).

Real total: **31 active guards** (the spec's "32" is close — within one of an exact reproduction, plausibly a rounding/inclusion difference such as whether Guard 9's still-present comment block is counted).

### GUARD 1c, 1d, 1f, 1g — what each actually checks

**GUARD 1c** (`claimsItemInCart`, cart.ts:25) fires only when the reply contains one of three specific
regex shapes, **all of which require the literal phrase "in your/the cart"**:
`"X in your cart"`, `"you have X in your cart"`, `"I've got X in your cart"`. It does **not** match any
sentence that merely lists item names without that exact phrase.

**GUARD 1d** (`claimsAddedWithoutMutation`, phantom-add-guard.ts:80) only trips when
**`cartBefore` and `cartAfter` are identical (`JSON.stringify` equal) or the cart shrank** — i.e. the
model claimed an add happened but nothing was actually written. If the cart genuinely changed size or
content at all this turn, the function returns `false` on its very first check (line 87-89) before ever
inspecting the reply text.

**GUARD 1f** (`evaluateGuard1f`, guard1f-correction-claim-20260909.ts:94) has the same shape as 1d but
for correction/removal claims ("fixed it", "removed that", "updated to just one") — it only trips when
`cartBefore`/`cartAfter` show no mutation matching the claimed correction.

**GUARD 1g** (`claimsOffMenuItem`, index.ts:3884) fires only on three templated phrase shapes:
`"we have/I can add/offer/recommend/how about/would you like/try our/we carry X"`,
`"added X to your cart"`, or `"X is/are $N"` — and only when the captured name `X` matches **no** menu
item and **no** current cart item.

### Does the spec's claim hold?

**Directly falsified for the 19:07 incident itself.** Re-reading the transcript against these four
detectors: the reply was *"Got it, adding a large plain cheese pizza. I've got your items: large cheese
pepperoni pizza, french fries, and a large plain cheese pizza. Confirm? Subtotal: $25.99..."* against a
cart that genuinely held 2 lines (an add DID happen this turn, so `cartBefore !== cartAfter` — **GUARD
1d does not fire**, per its own first-line early-return). The enumeration sentence never contains the
literal phrase "in your cart" — **GUARD 1c does not fire**. No off-menu item name was claimed (all three
named items are real menu items) — **GUARD 1g does not fire**. GUARD 1f is a correction-claim detector,
not an add-claim detector, and doesn't apply to this reply shape at all. This matches the spec's own
"no guard caught it" framing exactly, and shows *why*: these four guards check for narrow, specific
phrasings tied to single-item add/remove/correction claims — none of them are built to check
"does the count/identity of items in this sentence match `cart_json`'s actual lines," which is the
actual defect class.

**Would they become unreachable/deletable under the spec's proposed fix? Partially — not uniformly.**
The spec's own scope (point 3) only bans the model from *enumerating items by name* and *stating
totals*; it does not propose banning the model from ever mentioning a specific item name, or from ever
narrating that it took an add/remove/correction action. Given that narrower scope:

- **GUARD 1g** (off-menu item name mentioned) plausibly does **not** become fully dead: the model can
  still say things like "Got it, adding the [wrong name]!" in VOICE narration even after enumeration is
  banned, since narrating *that an action happened* is explicitly still allowed ("the model may add
  warmth around it"). A wrong item name in that narration is still a real hallucination risk 1g is built
  to catch.
- **GUARD 1d / 1f** (phantom add/correction claims) check for a *mismatch between a claimed action and
  an actual mutation* — a structurally different failure mode from "the model listed the wrong set of
  items." Banning enumeration does nothing to stop the model from falsely narrating "I added it!" when
  no tool call fired at all. These two guards protect against a sibling defect class, not the one this
  spec targets, and the spec's blanket "they have nothing to catch" does not hold for them unless the
  model is *also* barred from narrating any add/remove/correction action in its own words (a broader
  change than what's specified).
- **GUARD 1c** is the closest match to "becomes unreachable" — but only if the fix also prevents the
  model from asserting a *single* named item is in the cart (e.g., "yeah, the pepperoni's in there"),
  not just from *enumerating the whole cart*. As scoped, 1c's specific trigger phrase ("in your/the
  cart") isn't obviously covered by "never list items" — it's a different phrasing pattern the spec
  doesn't explicitly target.

**Bottom line for Part 2:** only GUARD 1g and (with a phrasing caveat) GUARD 1c have a plausible path to
true unreachability under the spec as written; GUARD 1d and GUARD 1f detect a distinct failure mode
(false action-narration without mutation) that survives the enumeration/totals ban as scoped. Retiring
all four "without leaving them as belt-and-braces" (spec's own words) would need the model's allowed
vocabulary to be narrowed further than point 3 currently describes — specifically, barring the model
from naming *any* specific cart item or claiming *any* action outcome in its own words, not just from
listing the full cart or stating totals.

## Part 3: Summary

- **Real total `reply =` site count: 67**, vs. the spec's claimed 48 (undercount of 19; a prior
  incomplete pass found 66, one short of the definitive number because it likely missed the
  runOrderingLoop-scoped site at line 3259).
- **Real total active-guard count: 31**, vs. the spec's claimed 32 (within one; plausibly a
  counting-convention difference, e.g. whether Guard 9's still-present-but-dead comment block counts).
  6 additional guards (9, 13, 18, 20, 21, P3) are named in comments but already retired/dead code today
  — they are not part of the 31 that would need retiring under this spec.
- **FACT/MIXED sites NOT yet fully routed through a shared renderer end-to-end** (i.e., still carrying
  either raw/lightly-scrubbed model prose, or a directly-interpolated fact fragment that bypasses
  `renderItemizedRecap`/`renderLedgerFooter`/`renderMissingOptionsPrompt`/`renderDisambiguationReask`):
  **#1, 3, 4(partially — code-only but not itemizer for linkLine, low priority), 10, 11, 12, 13, 14, 16,
  17, 21, 22, 23, 31, 35(low-risk), 36(low-risk), 40, 42, 43, 44, 45, 46, 47, 53, 60(low-risk), 65, 67**
  — roughly **26 of the 67 sites** carry either raw model prose or a direct (non-itemizer) fact
  interpolation. The single highest-leverage item among these is **#21 (`reply = loopResult.reply`,
  line 7410)**, since every other raw-model-prose site downstream (#22, 23, 31, 42, 43, 44, 45, 46, 47,
  53, 65, 67) is really just "whatever survived from #21, minus one guard's specific scrub" — fixing the
  model's vocabulary at the source (spec point 3) collapses most of these at once rather than requiring
  26 independent fixes.
- **Confirm/refute 1c/1d/1f/1g dead-code claim: refute as stated, confirm partially.** See Part 2 —
  1g and (with a caveat) 1c have a real path to unreachability; 1d and 1f detect a materially different
  failure mode (false action-narration without a matching cart mutation) that the spec's scoped fix
  (ban enumeration + totals only) does not close. Deleting all four "without leaving them as
  belt-and-braces," as the spec instructs, would leave the 1d/1f failure mode with no detector unless
  the model's allowed vocabulary is narrowed further than the current spec text describes.
