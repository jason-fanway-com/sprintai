# OrderFare / chat-sms — Architecture Review Brief

**Prepared 2026-09-14 for a fresh review thread. Written by the outgoing product-owner agent.**

You are being asked for **architectural oversight**. The product works most of the time and
fails a minority of the time in ways that keep recurring after being declared fixed. The
owner (Jason) has lost confidence that the reported "done" states are real. Your job is to
judge whether the structural diagnosis below is correct, and to say what should actually be
built — not to continue the patch queue.

Assume nothing in this document is true because it is written here. Every factual claim has
a command next to it. Run them.

---

## 1. What the product is

SMS-based ordering for independent food shops (pizzerias, delis) in PA/NJ. A customer texts
the shop's number; a bot takes the order conversationally, prices it, and issues a Stripe
payment link. $99/month per shop plus $0.99 per order.

Three shops exist, **all pre-production test shops, no live customers**:

| Shop | id | Role |
|---|---|---|
| Vito's Pizza | `e0000000-0000-0000-0000-000000000001` | **the dev/test/demo shop — all work is validated here** |
| Zio's Pizzeria | `2cba7b51-211c-4437-8910-1af4dcc03498` | web ingestion proof only |
| Not Just Bagels | `b0000000-0000-0000-0000-000000000001` | intended early sale, still pre-prod |

Commercial stakes: Jason has been telling a sales partner (Erin) for several weeks that the
product is nearly finished. It is not demo-ready. That is the pressure behind everything here.

---

## 2. The system, physically

One Supabase edge function does essentially all of it.

```
supabase/functions/chat-sms/index.ts     10,114 lines   <- the ordering state machine
supabase/functions/chat-sms/*.ts            37 modules  <- extracted helpers
supabase/functions/chat-sms/*test.ts        69 files    942 tests, all passing
turn-reconciler.ts                         716 lines    <- cart write authority
ask-plan-engine.ts                       1,367 lines    <- compiled option/slot resolution
```

Repo lives on a remote Mac ("the Air"), reachable as `ssh openclaw-air`, at `~/sprintai-ordering`.
Deployed as Supabase edge function `chat-sms`. **Currently v444, HEAD `0a66af6f`.**

Two generations of ordering logic coexist:
- **Legacy**: an LLM tool-calling loop (`runOrderingLoop`) that decides everything.
- **Compiled** (`ask_plan`, `bot_state`, flag `compiled_ordering_engine_enabled`): pre-compiled
  per-item question plans so option resolution is deterministic. This is the settled direction —
  legacy needs per-shop prompt tuning and buys fluency with improvisation, and the improvisation
  is what invents shop policy and misstates money. **Do not reopen that decision.**

Model is `deepseek/deepseek-v4-flash` via OpenRouter. The model has been tested and is **not**
the cause of the defects below; that was established over a full test series.

Verify this section:
```bash
ssh openclaw-air 'cd ~/sprintai-ordering && wc -l supabase/functions/chat-sms/index.ts && ls supabase/functions/chat-sms/*.ts | grep -vc test && git log -1 --oneline'
```

---

## 3. The invariant that was supposed to exist

On 2026-09-11 Jason gave the architectural instruction that everything since has nominally
been serving:

> "Invert who owns the cart: **model proposes, code decides and writes.** The modules for that
> already exist (cart, pricing, itemizer, ask-plan-engine), and most of the 36 guards exist
> because the model owns state — they'd stop being necessary rather than needing maintenance."

That is the correct instinct and it is the frame for your review. Two halves:

- **Write inversion** — the model may not mutate the cart; it proposes, code decides and writes.
- **Reply inversion** — any sentence asserting cart contents, quantities, prices or totals must
  be rendered by code from `cart_json`. The model may add warmth only.

---

## 4. What is actually true today

### 4a. Write inversion: REAL

`writeCartLine` in `turn-reconciler.ts` is genuinely the only cart mutation path. A static
enforcement test (`enforce-single-cart-writer.test.ts`) covers three bypass families —
`.push(`, `.splice(`, and `cart_json:` in DB updates. Zero bypasses. This part is done and
it holds.

```bash
ssh openclaw-air 'cd ~/sprintai-ordering && deno test --allow-all supabase/functions/chat-sms/enforce-single-cart-writer.test.ts'
```

### 4b. Guards: genuinely reduced

36 → **26** unique guards. Real progress, driven by retiring guards whose reason for existing
went away.

### 4c. Reply inversion: **NOT DONE — and was reported as done**

This is the central finding of this brief.

The enforcement test `reply-inversion-enforce-cart-fact-renderer.test.ts` does exactly one
thing: for each `reply =` statement, it scans `${...}` template interpolations for a direct
`.name` / `.price_cents` / `.quantity` / `.price` property access.

It therefore proves: *hand-authored template strings do not interpolate cart fields.*

It does **not** prove the invariant. At `index.ts:7657` there is:

```js
reply = loopResult.reply;
```

The model's own prose, assigned to the reply wholesale. The enforcement test contains **zero
references** to that path — it is not a template literal, so there is nothing for the scanner
to see. Confirm:

```bash
ssh openclaw-air 'cd ~/sprintai-ordering && grep -n "reply = loopResult.reply" supabase/functions/chat-sms/index.ts && grep -c "loopResult\|modelReply\|warmth" supabase/functions/chat-sms/reply-inversion-enforce-cart-fact-renderer.test.ts'
```

**A lint was built and an invariant was reported.** Everything in section 5 follows from that gap.

### 4d. The reply surface is growing, not shrinking

| When | `reply =` sites |
|---|---|
| Before the reply-inversion work | 50 |
| After "item A complete" | 43 |
| **Now** | **52** |

Each item closed on 2026-09-14 *added* branches (the upsell wiring added one; the
decline path added two). Progress was reported against the stale 43 rather than a re-count.

```bash
ssh openclaw-air 'cd ~/sprintai-ordering && grep -cE "^\s*(reply|finalReply)\s*=" supabase/functions/chat-sms/index.ts'
```

---

## 5. Defect inventory, with root causes

These are all real, all reproduced live, all on Vito's. Note the pattern in the "traces to" column.

| # | Defect | Root cause found | Traces to |
|---|---|---|---|
| 1 | Single pizza charged $336 / $341 ("x16") | `parseExplicitQuantity` read the `16` in `Cheese - Large (16")` as quantity sixteen — from a **model-supplied `source_phrase`** | Cause A |
| 2 | Reconciler wiped entire carts, 30% (measured 3/10, all $0.00) | groundedness judged against current-turn text only; `source_phrase: "cheeseburger medium"` | Cause A |
| 3 | **15% of canary conversations end with NO ORDER** (measured 3/20 by DB subtotal) | model emits `source_phrase: "cheeseburger medium"` — words spanning two turns; grounding is a **contiguous substring** search, never matches, add silently dropped | Cause A |
| 4 | Bot says "Got it — a Cheese Burger added" over an **empty cart** | model prose reaching the customer via `reply = loopResult.reply` on a turn with no write behind it | Cause B |
| 5 | Upsell never fired after a required option answered on a separate turn | the deterministic pending-option resolver returns to the customer and never reaches the upsell wiring — a whole branch with no fact rendering | Cause B |
| 6 | Driver-tip question displaced the food upsell, 4/9 runs | tip ask is a **prompt rule** (`index.ts:1053`, `:1503`) racing a code render, winning ~44% on delivery | Cause B |
| 7 | "no thanks" didn't show the cart, 2/9 runs | no mutation that turn → reply inversion never engaged → whole turn handed to model prose | Cause B |
| 8 | (H) Action succeeded, reply never said so — salad added, never named | fact renderer not wired into that path | Cause B |
| 9 | (F) Secondary intent dropped ~20% — "correct, and a side salad" | the model simply never proposes the second item | **separate** |
| 10 | (E) SMS silent drop — inbound saved, no assistant row, no reply | unknown, instrumentation only | **separate** |

### Cause A — `source_phrase` is model-authored prose that code makes binding decisions on

Defects 1, 2 and 3 are the same bug three times. A proposal carries a **string the model
invented**, and code then re-interprets it: parses integers out of it, substring-searches it
against the transcript to decide whether the add is authorized.

That is the model still owning state, laundered through a text field. Each fix so far has been
another heuristic layered on the same untrustworthy input (reject phrases not in the customer's
words → judge against history instead of the current turn → judge token-wise instead of
contiguously). Every one of those was correct locally and none removed the class.

The proposal should carry **references, not prose**: `menu_item_id`, option `choice_id`s, an
explicit integer `quantity`, and the id of the message the evidence came from. Grounding becomes
a lookup. `"cheeseburger medium"` becomes unrepresentable.

### Cause B — there is no single place where a reply is assembled

52 `reply =` sites across an unbounded number of branches: the LLM loop, the pending-option
resolver, the decline path, the cart-summary shortcut, the delivery-offer path, the name-submit
path, deterministic guards. Defects 4–8 are each *a different branch* where either code-rendered
facts were missing or model prose leaked a cart claim.

The 2026-09-14 sequence is the tell: fixed the upsell in the LLM-loop branch → found the
pending-option resolver had no upsell wiring → found the tip racing the render → found the
decline path had no cart render → then the canary surfaced a *third* add path claiming an add
over an empty cart. That is not bad luck. **The architecture permits an unbounded number of
reply exits, so each fix covers one branch and the next is undiscovered until a customer or a
canary trips it.**

The proposed shape: one reply assembler. Every path returns `(facts[], question?, warmth?)`;
a single function renders and emits; `reply =` exists in exactly one place; facts derive from
the cart diff. Then "the reply claimed an add that didn't happen" is impossible by construction
rather than by a guard — and most of the 26 remaining guards lose their reason to exist, which
is what Jason predicted on the 11th.

**Questions for you (the reviewer):** Is that the right shape? Is it achievable incrementally
on a 10k-line function, or does it require extracting the turn pipeline first? Is there a third
cause being missed? Is the compiled path the right place for this, making legacy irrelevant?

---

## 6. Why this kept being reported as finished

Relevant because it shapes what evidence you should trust.

1. **The tests pass.** 942 green, including the reply-inversion enforcement test, while the bot
   told a customer an item was added over an empty cart. The test proves a lint, not the invariant.
2. **Money-based checks can't see it.** A dropped add means an empty cart, so nothing is
   overcharged, so every money assertion passes. A test that only notices overcharges is half a test.
3. **The defects are probabilistic.** Identical code produces different outcomes — 15%, 20%, 30%,
   44% failure rates. Any 5-run gate passes a 15% defect roughly 44% of the time. Several
   "verified" versions (v409, v411, v413, v415) were each certified off one clean run and rolled back.
4. **Cart-based tests pass while replies lie.** Every automated check inspected `cart_json`. The
   customer reads the *reply*. Jason's own manual tests found essentially every real defect;
   the automated matrix found none of them. `scripts/conversation-quality-test.sh` now asserts
   on reply text and immediately started finding things.

---

## 7. Ground rules that apply to any work here

- **All work is validated at Vito's.** It is the dev and test shop. Do not propose freezing it.
- **No shop is in production.** Do not add rollout gates to "protect" any shop.
- **Five clean runs minimum, ten for anything under ~20% failure.** One clean run is a sample.
- **"Committed" is not "deployed."** Prove a deploy by fetching the live artifact. `scripts/deploy-function.sh`
  stamps the commit SHA into the bundle and verifies it. It needs `SUPABASE_ACCESS_TOKEN` sourced
  from `~/.openclaw-sprintai/.secrets` or it stops silently at step 4/6 and leaves the old version live.
- **A feature can be complete and switched off.** Check for the flag.
- **Never certify a language fix on one phrasing.** Use a matrix.
- **Durability ranking:** fix the data > remove the capability > fix the code > cleanup > change the prompt.
  Prompt rules are the weakest lever and lose races against code (defect 6 is the proof).
- **Edge function logs are retained ~1 minute.** Anything not persisted to the `error_log` table
  is lost. That table has now cracked two defects; keep the instrumentation permanently.

Useful commands:
```bash
# canary — must be one line, Temp: Medium, $8.49 + $0.99 = $9.48
ssh openclaw-air 'cd ~/po-scratch && bash tk.sh start'      # then: bash tk.sh <sid> "cheeseburger"

# reply-level acceptance
ssh openclaw-air 'cd ~/sprintai-ordering && bash scripts/conversation-quality-test.sh'

# the error log (this is where the evidence lives)
# table: error_log, columns stage / error_message / customer_message / metadata
```

---

## 8. State as of handoff

**Deployed: v444, HEAD `0a66af6f`** — "item H — cross-turn phrase grounding gap + reply-inversion
mutation-claim escape". This is the crew's patch for defects 3 and 4, landed minutes before this
brief. **It is UNVERIFIED — nobody has run the 20-run database-level canary against it.** Verifying
it is the first concrete task, and the acceptance is: run the canary 20 times, assert
`subtotal_cents = 849` all 20 times, zero empty carts. Not reply text — the database.

Burn-down list:

| Item | State |
|---|---|
| A — reply inversion | reported done; **actually a lint, see 4c** |
| B — option removal ($16.50) | done, verified 5/5 |
| C — real food upsell | done, verified live (offer text and price come from `menu_items.upsell` resolved against the live menu; "yes" adds at the right price; never twice per conversation) |
| C2 — tip beat the food upsell | done, verified 10/10 clean quality runs |
| D — "no thanks" renders cart | closed by C2's deterministic decline path |
| G — reconciler cart-wipe | done at the time; **defect 3 is its boundary reopening** |
| P0 — 15% no-order | patched in v444, **unverified** |
| F — secondary intent dropped ~20% | not started |
| E — SMS silent drop | not started, instrumentation only, no speculative fix |
| H — action happened, reply silent | partially addressed in v444, unverified |

Parked deliberately: prompt prefix caching (spec written, `docs/specs/2026-09-12-prompt-prefix-caching.md`),
staging→test→promote pipeline (revisit after the first real customer).

---

## 9. What Jason is asking for

Not another item off the queue. He wants someone to zoom out and determine whether the two
causes above are the real ones, and what should be built so that "done" means done. His words:
*"You need to zoom out and learn the cause of these failures instead of patching symptoms."*

The honest summary of the last three days: a partial job was labelled complete, and the work
since has been patching branches of a thing already reported as handled. That is why it reads
as whack-a-mole to him. It is whack-a-mole.
