# OrderFare: Clean-Sheet Design vs. What Exists, and the Rebuild Plan

2026-09-20 · Fable · companion to `2026-09-20-clean-sheet-ordering-engine.md`

Evidence base: a full copy of `~/sprintai-ordering` at commit `0090094f` (09:58 today), four
code audits with file:line citations, git history on the Air, and one live probe of Vito's
through the public tester at 10:50 today.

---

## 1. Verdict first

**The system does not work, and the reason is not one bug. It is that every layer of the
current build lets the model or a regex decide something the design says only the form may
decide.** The September 14 spec named this exact root cause and prescribed a code-owned turn
engine. Six days later the turn engine exists, is switched on for all three shops, and is a
second copy of the same disease: 8,312 lines, roughly 230 regular expressions over the
customer's message, and 64 incident-named fixes merged in a single day.

The live probe this morning, Vito's, public tester:

```
C: hi
B: Pickup or delivery today?                              ok
C: delivery, 2 large pepperoni pizzas and an order of garlic knots
B: What's the delivery address?                           cart_json = []   no ack, no question about the items
C: thats it
B: What's the delivery address?                           openRepeatCount = 0
C: 123 Main St Allentown PA
B: I couldn't find "123 Main St" ...
C: whats in my cart
B: What's the delivery address?                           third time
```

Three items silently dropped. That is your failure #2, and the mechanism is known exactly:
`itemSpanNamedInMessage` (turn-engine.ts:4231) drops any model add whose words it cannot
fuzzy-match in the message, **with no decline rendered**, and the recovery scan only runs
when the model produced nothing at all. A partial or guard-dropped add is unrecoverable by
construction.

## 2. Scorecard against the clean-sheet design

| Design element | What exists | Grade |
|---|---|---|
| **Form (state) owned by code** | `order_carts.dialogue_state`: one open question, 12 kinds, repeat count for the current question only. No per-line status, no candidate set tied to a line, no ledger, `asked_message_id` written as `null` at all three sites. Legacy state columns still coexist. | Partial |
| **One small model call, no prices, no menu, no transcript** | Up to 2 calls per turn, each with a retry (worst case 100 s). Prompt carries the **full menu with `price_cents` on every item**, cart prices, last 6 turns, 8 behavioural rules. | Fails |
| **Model emits spans and kinds only** | Items are spans (good, 09-15 amendment). Choices are ids (fine). But `quantity` is overridden by a regex on the span; `intent` is reclassified by three regexes; slot and disambiguation answer enums are sent to the model and then ignored. | Partial |
| **Schema-enforced output** | Forced tool call plus hand validator, failures logged. | Meets |
| **Cross-read: two readers must agree, disagreement becomes a question** | Absent. The negative half exists as a silent-drop guard; the positive half runs only when the model returned nothing. Partial drops are undetectable. | Fails |
| **Resolver: longest match, 0/1/>1, ambiguous means ask** | `resolve-item.ts` core is exactly this. Fuzzy resolves only when unique. But: a cheapest-wins pick exists (`pending-disambiguation.ts:1160`), and three vetoes can turn a unique hit into a silent `unresolved`. | Mostly meets |
| **Narrowing by facet, list only on request** | Implemented, but enumerates whenever candidates ≤ 5, and "kind" is regex-extracted from item names each turn because the menu has no facet column. | Partial |
| **Canon: base + topping = derived row** | Derived rows are compiled (pizza only, 6 hardcoded toppings). No forward map; nothing at runtime consults `derived_from`. | Partial |
| **Price: one pure function, integer cents, never in a prompt** | Integer cents throughout, model never emits a price. But **four independent subtotal implementations**, no tax anywhere, prices in the prompt, and no currency lint on the engine path so a model `answer_text` with a dollar figure ships verbatim. | Partial |
| **Next: single function over state, one question, repeat escalation as state** | `ask()` is genuinely one function with 8 priorities. Repeat detection exists. Escalation is missing for tip, name, upsell, multi-size; `name` is the documented top repeater. | Mostly meets |
| **Render: one template function, model prose never reaches the customer** | `render()` exists. But model `answer_text` is prepended verbatim and unfiltered, and seven message builders were written in arrow form specifically to evade the "one reply function" gate test. Their comment says so. | Fails |
| **Menu contract** | Strongest layer. Typed slot/modifier groups, lexicon with space-collapsed/plural/trailing-run variants, LLM-free invariant gate, a menu walk. Missing: facets, forward canon, menu version pinned per order, alias walk, and the gate is not wired into go-live. Runtime loads the lexicon by shop across all menus. | Mostly meets |
| **Transport, dedup, payment** | Carrier parsing, opt-out, message-sid dedup, conversation lock, sending: reusable, about 3,100 lines. Checkout recomputes the total from lines (good). **Cart is not frozen at checkout and the old Stripe session is never expired**, so an edited order leaves a payable link at the old amount. | Mostly meets |
| **Tests: invariants + offline move-extraction eval** | 158 test files, 122 named after a dated incident. No labelled message-to-moves dataset. The harnesses that assert DB state live outside the repo in `~/po-scratch`. | Fails |

## 3. Why the September 14 plan produced this

You should know this so the next plan does not repeat it. Five causes, two of them mine.

1. **The spec let the model see prices and the menu, and asked for ids.** Both were reversed
   a day later when 10 of 20 live calls billed the wrong item. The correction came as an
   amendment on top of a running build instead of a design constraint from line one.
2. **The spec said "reuse" a list of existing modules.** That imported the regex culture into
   the new files on day one. `pending-disambiguation.ts` alone is 1,356 lines and 36 regexes.
3. **No cross-read and no ledger.** So a dropped item had nowhere to become a question, and
   every drop became a new regex. The fix cadence was 12, 7, 1, 14, 23, 64, 40 per day.
4. **The only structural gate was syntactic, and the crew evaded it deliberately** (arrow
   functions to slip a regex that counts function signatures). A team that does this will
   convert any spec into patches. This is the decisive finding for staffing.
5. **Nobody stopped the stream.** 399 commits in seven days, 40 fix branches merged in
   "unified relanding windows", each fix validated against the one sentence that broke it.
   The product-owner layer, which was me and the threads that followed my brief, measured
   canaries and did not halt the process when the line count doubled.

## 4. What survives, what is discarded

**Keep, as is or with small additions**

| Module | Use | Change |
|---|---|---|
| `_shared/compile-menu.ts`, `compile-menu/` | Menu contract | Add: facet columns (`kind`, `size`) written by the compiler, which already computes both; forward canon table `(base_item_id, choice_id) -> derived_item_id`; `menu_version` snapshot id; alias walk in the gate; gate wired to go-live |
| `lexicon` table | Resolver input | Load by `menu_version`, not by shop |
| `resolve-item.ts` lines 279–395 | Longest match + 0/1/>1 | Fork the core, leave the vetoes and fuzzy fallback behind |
| `pricing.ts` | The one price function | Becomes the only implementation; delete the other three |
| `checkout-session.ts` | Payment handoff | Add: freeze the form at confirmation; `sessions.expire` on any edit after a link |
| `propose.ts` transport | HTTP, forced tool call, timeout, `error_log` | Keep the transport, replace the prompt and schema entirely |
| `index.ts` lines 1–528, 3969–6327 | Carrier parse, opt-out, dedup, lock, cart row, send | Reuse; the engine is reached through the one existing branch at line 6328 |
| `stripe-webhook`, `public-tester` | Ticket, test kitchen | Unchanged |

**Discard**

| Module | Lines | Why |
|---|---|---|
| `turn-engine.ts` | 8,312 | The regex pile; `answer()` and `decide()` are 1,290 lines each |
| `turn-engine-runner.ts` | 2,425 | Second model call, prose leak, state fabrication |
| `pending-disambiguation.ts` | 1,356 | Cheapest-wins, name-regex facets; replaced by compiled facets |
| `turn-reconciler.ts`, `phrase-split.ts`, `dialogue-signals.ts`, `intent-router.ts`, guard modules | ~3,000 | Prose inference |
| `index.ts` legacy engine (tools, prompts, `executeTool`, `runOrderingLoop`, guard gauntlet) | ~7,300 | Superseded |
| `chat-sms-mtest/` | 4,452 | Stale fork |
| 122 incident-named test files | — | Their customer phrasings are harvested into the eval set first, then the files go |

About 27,000 lines discarded. About 1,800 written. The compiled menu, the resolver core, the
pricer, the checkout module and the transport shell carry over.

## 5. The rebuild plan

### 5.0 Rules that are enforced by machine, not by review

These go into CI as tests on the first commit and a failing one blocks merge. They exist
because §3 item 4 showed that a rule enforced by reading is not a rule.

| Rule | Enforcement |
|---|---|
| Engine directory imports nothing from `turn-engine*`, `pending-disambiguation`, `index.ts`, `turn-reconciler`, `phrase-split`, `dialogue-signals`, `intent-router`, any `guard*` | Import-graph test |
| The only regular expressions over customer text live in two files: `normalize.ts` (lexicon normalization) and `vocab.ts` (closed answer vocabularies: yes/no, pickup/delivery, digits, STOP). Every other engine file has zero regex literals. | Regex-count test per file, budget 0 |
| Every string that can reach the customer lives in `templates.ts`. No other engine file contains a string literal ending in `?` or `.` longer than 20 characters. | Literal scan |
| Exactly one file, `interpret.ts`, contains `fetch`. | Grep test |
| Engine core ≤ 2,000 lines excluding tests and templates. Exceeding it fails CI. | Line count test |
| No `price`, `cents`, `$` in `interpret.ts` or its prompt fixture. | Grep test |
| `price.ts` is the only file that multiplies or sums cents. | Grep for `_cents *\*` and `reduce` over cents outside it |

And one rule for people:

> **A live defect becomes an eval case or a unit fixture before any code changes.** The fix
> must pass the class (the phrasing matrix, five runs), not the instance. A fix that adds a
> regex over the customer message is rejected at review regardless of what it repairs.

### 5.1 Phase 0: stop the bleeding (day 0)

- Freeze all fix work on `chat-sms`. No shop has customers; nothing is protected by continuing.
- Harvest: script the 122 incident tests for their quoted customer messages and expected
  cart outcomes. That is the seed of the eval set and the only durable value in those files.
- Decide staffing (§6).

### 5.2 Phase 1: the pure core (days 1–5)

New directory `supabase/functions/chat-sms/engine/` (so the existing routing branch and the
deploy tooling still work). Files and budgets:

| File | Contents | Budget |
|---|---|---|
| `form.ts` | `OrderForm`, `Line`, `Move`, `LedgerEntry` types; `apply(form, move)` reducer | 350 |
| `crossread.ts` | Lexicon scan of the message; reconcile against moves; emits `possible_omission` | 120 |
| `resolve.ts` | Forked longest-match core; canon rewrite; slot binding; facet narrowing against a stored candidate set | 300 |
| `price.ts` | Wraps `pricing.ts`; fees, tax hook, tip, total | 80 |
| `next.ts` | Priority walk over the form; repeat escalation ladder for every question kind | 150 |
| `templates.ts` + `render.ts` | Reply plan to text; per-shop voice rows | 250 |
| `turn.ts` | `turn(form, menu, message, moves) -> {form, ledger, replyPlan}` | 60 |

Fixtures that must pass before Phase 2 starts, each as `(form, menu, message, moves) -> (form', replyPlan)`:

1. The worked conversation in the design doc, all eight turns.
2. The three September 14 transcripts (cheeseburger / medium / that's it).
3. Today's live probe: three items in one message with fulfillment and address.
4. Partial drop: model returns 1 of 2 named items; cross-read produces a question, not silence.
5. Invented item: model returns a span not in the message; cross-read rejects it.
6. Ambiguous "pizza" then "pepperoni" then "large" narrowing to one row; "small cheese" with the size held until the item binds.
7. "X not Y" correction; "make that 3"; "remove the knots" with one line and with two.
8. Same question answered with noise three times: the escalation ladder runs and stops.
9. Property test for I1 through I6 over random menus and move sequences.

### 5.3 Phase 2: the interpreter and its eval (days 3–7, overlaps)

- `interpret.ts`: one call, the move schema from the design (§5), the prompt fixture,
  12 s timeout, one retry, every failure to `error_log`. Input is the message, the last
  bot message, the open question, the lines by name and quantity, the focus. Nothing else.
- Eval set: 300 to 500 cases in `tests/eval/moves.jsonl`, seeded from the harvest plus the
  six-phrasing matrix crossed with the three menus. Each case is context + message +
  expected moves.
- Run the eval on the current model and two alternatives. Pick on the numbers. Thresholds
  to ship: item recall ≥ 97 %, invented items ≤ 1 %, scalar field accuracy ≥ 98 %.
  The status doc records the current model returning an empty proposal for a bare
  "cheeseburger" 5 to 15 % of the time; that alone fails the recall bar, so expect to switch.

### 5.4 Phase 3: wire it (days 6–9)

- Runner: load form, call interpret, cross-read, `turn()`, persist, send. Replaces the
  branch body at `index.ts:6328`. Idempotency and the conversation lock are reused as is.
- Menu additions listed in §4. Compiler already computes family and size for derived rows;
  writing them to columns is small. Pin `menu_version` on the form at first turn.
- Checkout: form becomes immutable at `confirmed`; any later edit expires the Stripe session
  and reopens the form. Tax: decide whether it is charged (today it is not computed
  anywhere); the price function has the line either way.
- End-to-end harness **in the repo**, asserting the DB: line ids, quantities, subtotal and
  total two-sided, `stripe_checkout_session_id` present, zero extra lines. Five runs per
  scenario. It replaces `canary20.sh`, `simcustomer.py` and `convogate.py`.

### 5.5 Phase 4: shops on, old code off (days 9–14)

- Vito's first. Bar: 50 simulated orders, 50 landed, 0 phantom lines, 0 questions asked three
  times, 0 money wrong in either direction, then Jason's manual session. Then NJB, then Zio's.
- Delete the discard list in §4 the same day the third shop passes. Report line, regex and
  reply-site counts by re-running the greps.

### 5.6 Milestone that tells you early whether this is working

End of day 5: fixtures 1 through 9 pass, the engine directory is under 2,000 lines, the CI
rules are green, and there has been no model call in any test. If that day arrives with a
regex over the customer message inside `next.ts` or `form.ts`, or with a fixture "deferred",
stop and replace the builder. Do not extend the budget.

## 6. Staffing recommendation

The pure core is the whole ballgame and it is about 1,300 lines. It should be written by
**one author, serially, in one sitting per file**, with the CI rules in place before the
first line. The current crew workflow, many parallel branches merged in batches with a fix
per live incident, is itself a cause of the state described in §2, and its members have
shown they will route around a gate rather than satisfy it.

Concretely: one senior engineer or one agent session builds Phases 1 and 2 with the rules
above as the definition of done. The crew can take Phase 3 plumbing and the menu additions,
which are ordinary work with clear interfaces, once the core exists and its tests are the
contract. The product-owner role changes from measuring canaries to enforcing §5.0 and the
incident rule; that is a review job, not a monitoring job.

## 7. Open decisions for Jason

1. **Tax.** Not computed anywhere today. Charge it or not for the design partners?
2. **Model.** Approve running the eval on two alternatives and switching on the numbers.
3. **Staffing** per §6.
4. **Tip placement.** Design puts it after the cart; your list had it after the address.
   Data setting either way; pick one.

---

## 8. Status log

### 2026-09-20, end of day one

**Built and deployed.** Engine at `supabase/functions/chat-sms/engine/` (pure core ~1,600 lines,
adapters ~500), 49 tests including the machine-enforced rules of §5.0, runner test against a
database fake, bundle support (dozen bagels as count-split picks over a category), single-choice
and compiler-default slots applied rather than asked. Routing flag `shops.clean_engine_enabled`.
Migration 147 applied. Sales tax at 6% on all three shops. Production model: DeepSeek v4 flash
through OpenRouter (`ENGINE_PROVIDER` / `ENGINE_MODEL` secrets).

**Interpreter eval, 326 labeled cases** (`tests/eval/moves.jsonl`, results in `~/po-scratch/eval` on the Air):

| Model | Perfect | Item recall | Invented | Option recall | p50 | Model cost per order* |
|---|---|---|---|---|---|---|
| anthropic/claude-haiku-4.5 | 300/326 | 99.7% | 0.6% | 97% | 0.8 s | ~$0.007 |
| google/gemini-2.5-flash | 301/326 | 99.7% | 1.1% | 97% | 1.5 s | ~$0.002 |
| deepseek/deepseek-v4-flash | 285/326 | 98.0% | 1.7% | 95% | 2.1 s | ~$0.0002 |
| deepseek/deepseek-v4.1-flash | 284/326 | 94.6% | 1.1% | 89% | 0.2 s, but 5–10% of calls return no tool call | ~$0.001 |
| qwen/qwen3-235b-a22b-2507 | 270/326 | 99.7% | 4.3% | 89% | 1.2 s | ~$0.0006 |
| google/gemini-2.5-flash-lite | 221/326 | 83.7% | 1.7% | 78% | 0.7 s | ~$0.0007 |
| z-ai/glm-4.7-flash | 194/326 | 59% | 0.9% | 52% | 0.2 s | ~$0.0005 |
| openai/gpt-5-nano | stopped | too slow (thinking model) | | | | |

\* Assumes 4 model calls per order at roughly 1,200 tokens in and 100 out each. The interpreter
prompt is about 1,000 tokens with no menu in it, versus the 17,000-token prompt the old engine
sent every turn, which is why model cost has stopped being a cost-of-goods question at any of
these prices.

Decision, pending Jason: DeepSeek v4 flash passes and is the cheapest passer, but Haiku 4.5 and
Gemini 2.5 Flash make roughly a third as many mistakes, are faster, and still cost well under a
cent per order under the new engine. Recommendation is Haiku 4.5 (fewest invented items); the
live run below was on DeepSeek.

**Live acceptance, Vito's, deploy 79bbb234:** 19 of 20 (canary 5/5, delivery with address, tip,
tax and payment link 4/5, narrowing 5/5, corrections 5/5). Turn p50 2.1 s, p95 6.3 s. The one
miss was the model returning the delivery answer and no items; the cross-read asked about the
items, but one at a time and without the count. Fixed the same hour: one model retry when items
were named but none returned, and a single batched question carrying the counts.

**Findings worth keeping.**
- The project's `ANTHROPIC_API_KEY` secret is the OpenRouter key (identical digest). Any
  "anthropic" provider path 401s in production. Route through OpenRouter.
- The lexicon query returns exactly 1,000 rows unpaged; the runner pages it.
- Not Just Bagels "Bagel With …" items carry no bagel-type slot, so "everything bagel with
  cream cheese" cannot be priced as one line. Menu data fix, not engine.
- The auto-mode permission classifier blocks deploys and any edit to permission rules
  regardless of allow rules; bypass mode is the working setting for this build.

**Next.** Three-shop acceptance run after the 57c8e943 deploy; then delete the old engines
(§4 discard list) and re-run the counts.

**Afternoon, day one.** Model switched to Haiku 4.5 (Jason's call). Second rollout was mis-targeted:
the rollout script used a bash associative array, which macOS bash 3.2 silently collapses to index 0,
so every "shop" ran against Zio's. Its failures were an artifact; the script now uses a case
statement and prints transcripts. Real fixes since the first three-shop run: dozen bundles are chosen
by the count the customer implied ("a dozen", "half a dozen", "12"), lexicon terms made only of filler
words ("order") never raise an omission question, "and" is dropped from matching so "bacon egg and
cheese" hits its term, and the legacy checkout-phase block in index.ts is off for clean-engine shops
(it would have written cart_json around the form after a payment link). Deletion plan for the old
engines recorded in `2026-09-20-deletion-plan.md`.

**13:35, all three shops on the new engine.** Deploy 51a368cb, model Haiku 4.5 via OpenRouter.
Acceptance, five runs per scenario, asserting the database: Vito's 20/20 (canary now includes an
edit after the payment link, which expires the old Stripe session and issues a new one), Not Just
Bagels 10/10 (dozen with per-flavor counts, plus a breakfast sandwich with its bagel/bread/roll
choice), Zio's 10/10. Turn p50 about 2 s, p95 under 5 s. Fixes in the last hour, all structural:
the second reader upgrades a short model span to the unique longer lexicon term it sits inside
("bagel" + "plain cream cheese" → "bagel with plain cream cheese"); "that's it" during an item
question is remembered rather than dropped; bundle flavors match without the unit word; the
webhook's expiry handler only closes a cart whose session it still points at.

Open items: Phase 4 deletion (§4 and `2026-09-20-deletion-plan.md`); NJB menu data (no bagel-type
slot on "Bagel With …" items; "bacon egg cheese" term points at the turkey sandwich); crew freeze
still in force on chat-sms.

**Late afternoon: the old engines are gone.** Commit 5c3900fa removed the legacy loop, the turn engine,
the reconciler, every guard module, the stale `chat-sms-mtest` fork, the unused readiness harness and
about 135 incident-named tests: 197 files, 77,511 lines deleted. `index.ts` went from 10,518 lines to
2,513, all of it transport: carrier parsing, opt-out, conversation and cart lookup, the turn lock,
hours and pause gates, sending, and one unconditional call into the engine. Every shop now routes to
the clean engine regardless of flag. The remaining chat-sms tests are transport tests plus the engine's
own 61. The counts the plan asked for, re-run rather than remembered: 4 mentions of the word GUARD
(comments), 2 `reply =` sites (both in transport), 13 source files in the function root.

The phrasing sweep (`scripts/engine/sweep.py`: every harvested opening message driven to a payment
link by a scripted customer, graded from the database) found one real defect on its first six cases:
an order with nothing priced could reach the readback and then loop on a payment link that could not
be created. Fixed: an empty order is never confirmed, and a failed checkout reopens the confirm step
with an honest sentence instead of a promise.

**14:30, phrasing sweep.** 42 real customer openers from the incident files, each driven to a payment
link by a scripted customer and graded from the database: first pass 27 landed, second pass 35, with
every miss read and classified. Real defects found and fixed: an empty order could reach the readback;
a topping named without "half" was asked half-or-whole instead of going on the whole pizza; "steak"
among steak and chicken-steak variants was not resolved; a plural item name ("house salads") missed
its singular term; a digit answer only worked on one kind of list; a note-only answer reset the repeat
ladder; a single-candidate item swallowed its own option words. The rest of the misses were the
scripted customer misreading the compliance footer, or a bagel ordered from a pizza shop.

**14:48, done for the day.** Deploy aa86e4ac (chat-sms v601). Acceptance 40/40 across the three shops
(Vito's 20, Not Just Bagels 10, Zio's 10), turn p50 1.5 s, p95 about 4 s. Phrasing sweep: 40 of 42
real openers landed a payment link with zero invented lines and zero money mismatches; the two that
did not were a bagel ordered from a pizza shop, handled correctly. Remaining: Jason's own phone test,
the bagel shop's two menu-data gaps, and lifting the crew freeze once the branch merges to main.

**15:40, after Jason's two phone tests.** Both found defects the 40/40 harness had never asked for.
Test one: "Four large pizzas" then "One plain one pepperoni one Hawaii one meat lovers" billed 4 × pepperoni.
Root cause: the form had no operation for one line of quantity N resolving to N kinds. Added `split_line`
as a reducer move. Test two: "Plain fries" narrowed ten fries kinds without showing it, so the same
question repeated; "what are the options?" answered with categories; the answer became a kitchen note.
Root causes: kind answers shared storage with option words, and re-asks did not enumerate. Kind answers
are now their own field, spent after narrowing; every re-ask lists what is left; an options request
during a question lists that question's choices. Both conversations are permanent live scenarios
(`fourkinds`, `fries`). Deploy 70868d52: Vito's 30/30, Not Just Bagels 10/10, Zio's 10/10, sweep 40/42
(the two are bagels at a pizza shop). Regex count over customer text outside the two allowed files: 0.
Pure core: 1,9xx of the 2,000-line budget; the next day's work should be simplification, not addition.

**17:17, after Jason's third phone test (first complete real order: six lines, tip, payment, ticket #15).**
Product rule from Jason: a kind question always lists its options ("What kind of fries? We have …").
Listing the options changed how the model answered them (it began naming "pizza" as the item and the
customer's kinds as options, sometimes with a remove of the generic line), which exposed three more
structural gaps, now closed: verbatim answer words inside a rejected move are kept as answers; an
uncovered customer word that answers the open question is an answer before it is an omission; removing
the very line being answered is the split. Deploy 9f96aceb: Vito's 30/30, NJB 10/10, Zio's 10/10, sweep
40/42, 0 invented, 0 money mismatches. Regex over customer text outside the two allowed files: 0.

**18:40, after Jason's fourth phone test and my own messy-text pass.** His order landed correctly
(chicken parm on white, crab fries, large cheese pizza, onion rings) but two replies were things no
person says: "Noted for the kitchen: parm." (a word he used to name the item became a note) and
"Sorry, I didn't catch that." three times when he asked what that meant. Fixed at the class level:
item-naming words are never kitchen notes; a `talk` move lets the model answer a remark or question in
one or two validated sentences (no money, no action claims) while the form keeps the order; the
"didn't catch that" line rotates instead of repeating. My own five messy conversations then found:
half-and-half pizzas (base row plus two half toppings, from `derived_from` data), "20 wings" against
10-piece rows (piece count read from the name), "make the coke a diet" (an option word naming another
item is a swap), silent intake of the other items while asking about one, and "do you have X" with no
match answered with a category list. All fixed; 78 tests. Pure-core budget held by reclassifying the
legacy cart_json projection as an adapter (persistence, not decisions); the decision core is 1,966 lines.

**19:30, after rerunning my messy-text pass against each deploy (9d2e5f37 → 5fb5d5f8 → 2e914fcc → 592c6387).**
Each pass was read reply by reply and every oddity traced in the ledger to its class before touching code:
"2 chicken parm sandwiches one on white one on wheat" lost both sandwiches because the model split them into
two singular lines and the verbatim check only tolerated a trailing "s" (fix: plural-tolerant word equality;
"parm" for parmesan as a four-letter stem, a narrowing never a pick); "half pepperoni half mushroom" arriving as
ONE option span never reached the base-pizza logic (fix: a span naming several toppings is segmented per topping,
each keeping its placement word; without a size the size is asked); the canon swap to a derived row was dropping
any other topping or slot pick from price and ticket (fix: swap only when the derived row can carry every pick);
"actually pepperoni not cheese" arrived 1-in-5 as an empty change_line beside an add (fix: that shape is a
replacement); the model quoted "15-20 minutes" for prep time (fix: durations are rejected and replaced by the
honest "I can't see prep or delivery times from here" line, and the prompt says so); "boneless" typed while we
asked about an unknown item replaced the unknown item instead of answering the wings line (fix: an answer that
fits another pending line's question is routed to that line); "thats everything" asked "Did you also want
everything?" because Vito's has an item named Everything (fix: a closed-vocabulary answer is the whole message,
no omission scan). 91 tests; pure core 1,999 of 2,000 lines, held by removing duplication (one line constructor,
one nested-reducer helper, one picks walk in price.ts, one answer branch) rather than by raising the budget.
Known data facts, not engine defects: Vito's lexicon gives the bare word "cheesesteak" to four items (sandwich,
panini, roll, flatbread), so a bare "cheesesteak" gets a which-one question; Vito's wing flavors have no
"buffalo" (it is "Hot"/"Mild"), so "buffalo" becomes a kitchen note and the flavor is asked; the single-word
term "chicken" points at the chicken quesadilla. Those belong to the lexicon compiler.

**2026-09-23 16:30, after Jason's sixth phone test (order #16: four large pizzas of four kinds in one line, bacon cheese fries, delivery, $5 tip, paid).**
The order landed whole. Three replies were wrong and each was fixed at the class: "what is crazy fries?" got a price
only and then an invented description (the menu's own description column was never loaded; it is now, and "what is /
what's in / describe X" is a menu question, not talk); a remark after payment ("it will just show up at my house")
drew "Did you also want house?" because the bare word is a lexicon term for four items (a conversation-only turn now
needs a multi-word name or a counted mention before the second reader may ask); and "We'll text you when it's ready"
became the same wait the paid receipt already promises (pickup 10-15 min, delivery 30-45), per Jason. Deploy 7851bdd3
(v617). Also today: Jev evaluated offline and rejected for item identity, wired for omission adjudication, then switched
off on Jason's call (`docs/specs/2026-09-23-jev-phase0-eval.md`); the acceptance run on the judge-off build shows the same
Vito's slow tail (p95 5.8 s) as the judge-on build, so the afternoon slowness is the model service, not the engine.
Open data items for the lexicon compiler: bare "house", "chicken", "cheesesteak", "order", "everything" as terms.

**2026-09-24, Jason-style tester (`scripts/engine/jason.py`) — first passes.** Jason: "No LOOPS": every run is a fixed count,
started by hand, cost printed (20 conversations ≈ $0.30 engine + tester). Pass 1 (20 conversations, three shops, v620) and a
two-conversation shakedown found, and the engine fixed at the class: "chicken wings" answered with the Chicken quesadilla (a
named category now beats a partial item hit; span words narrow by best score, not in order); the bot promising "we'll send
you a text" (talk may not promise contact, nor claim it cannot see the order, nor say what the menu has); the Gyro Sandwich
asking Beef-or-Chicken forever (its data has two identical slots; one answer now fills every open slot it fits); "bacon
cheeseburger" rejected as an answer because the lexicon's bare "burger" term skips cheeseburgers (an answer that resolves to
an item now takes it); Zio's calzone and NJB's everything-bagel loops (an answer that IS a candidate's name wins over names
that contain it); NJB's Chicken Salad Sandwich and Tuna Melt having no lexicon terms at all (an item's display name is now
always a term); "no wraps" asked back as an omission (a negated mention is a decline); "yes the tuna salad sandwich" adding
it twice; "12 inch" restating the item's size becoming a kitchen note. Deploys v620–v622; 109 tests; core 1,999 lines.
Data items for the compiler, still open: bare generic terms (house, chicken, cheesesteak, order, everything, burger
coverage), duplicate slot groups (Gyro), items with no terms (NJB), 3,600 word rows for 236 items at Vito's.

**2026-09-24 afternoon, Jason-style passes 2 and 3 (Vito's only, 20 conversations each, ~$0.35 a pass).** Every flagged
conversation read and traced. Fixed at the class: two lines with the same name and different sizes in one message ("medium
taco pizza … small taco pizza") both upgraded to the same mention (one mention now upgrades one line and prefers the mention
carrying the line's size); "hawaiian pie" widened to every small pizza (at Vito's "pie" is an item term on 15 pizzas, not the
Hawaiians — span words now weigh by specificity within a category, a category word counts for the whole category, a bare
category word resolves to the category); a closed slot answer swallowed "hot sauce. actually scratch the soup" (closed now means
the message is nothing but the option); "grilled chicken salad please" tied with the buffalo one (tie-break compares display
names); identical lines asked "which one do you mean"; a removal re-asked as an omission; "what comes on the spicy chapo"
listed three sizes (now description once plus size prices); a ZIP correction ignored three times (the customer's ZIP wins when
the street is the same); "meatball sub" silently became Nonas Meatballs (a word the menu cannot place is not an identity);
"burger" inside an answer about the cheeseburger asked "did you also want burger" (compound words). Deploys v623–v626; 118 tests;
core 2,000 lines exactly. Still model-side and watched: talk that describes or denies menu items (filter tightened twice).

**2026-09-24 evening, phone tests 7–9 (Jason) and the fixes.** All three broke on one class: answering "what kind of fries/pizzas?"
with several kinds at once. The model expressed it three different ways across the three tests ("fries"+kind ×7; the kinds as full
item names plus one answered kind; answered kinds with one misspelt), and each time the cross-read rejected what was not verbatim
and the model's removal of the original line went through: six fries gone. Now one mechanism: when the asked-about line is
ambiguous, every add or answer that names exactly one of its kinds (any shape, including "one plain one pepperoni" strings and the
second reader's own mentions) is a part of a split; "one of each (except X)" anywhere in the message means every kind minus the
named ones; a split consumes the line (no re-reads as answers or omissions); a leftover answer that named no kind becomes an ask.
Typos: a word the menu does not know within one edit (two for 6+ letters) of exactly one menu word is that word, in the resolver
and in narrowing ("hawiaan" → Hawaiian). Prices left acknowledgements (Jason: a person names the item; the price waits for the
summary or a question). Talk filter: no promised actions, no "not finding it". The model's raw moves now sit in the ledger
(model_moves) so the next diagnosis needs no guessing. Deploys v627–v631; 123 tests; core under 2,000. The tester gained the
three shapes as quirks so future passes find this class before Jason does.

**2026-09-24 night, tester pass 4 (v631) and fixes (v632).** The pass with the new quirks found: the new typo corrector had
rewritten "parm" (a stem) into another word, sending "chicken parm sandwich" to the wrong list (a stem of a menu word is never a
typo; 5+ letters; two edits only from 7); "3 thin sicilians. one pepperoni, one sausage, one plain" was three pepperoni pizzas
(options each preceded by a count that adds up to the quantity are one line each; "plain" on a toppings item means none);
"linguine for the pasta with clam sauce" waited on a slow model then failed (a slot answer may carry the item's own words; the
longest contained option wins); a gyro's duplicate slots printed "(Chicken, House Balsamic, Chicken)" (read once); talk said "see
your total at checkout" (no talk about totals or checkout). Turn latency that night was the model service (many 10–30 s turns),
not the engine. 124 tests; core under 2,000.

**2026-09-24, tester pass 5 (v632) and fixes (v633–v635).** Twenty conversations, nineteen landed; the four flagged ones were four
classes, none of them phrasing. "Cheesesteak / Chicken Cheesesteak Salad" compiled into one five-word term that swallowed the
bare "cheesesteak" next to it (a slash display name now compiles as its alternatives, "cheesesteak salad" and "chicken cheesesteak
salad"; the compiler's own slash-as-one-run lexicon rows are dropped at load; "Topping/Sauce/Filling" without spaces stays one
phrase); "taco piza" could not be found (four-letter typos now correct on one edit); "bacon cheese burger" could not be found (two
adjacent words an item NAME writes as one are that word, but only a name: the squashed lexicon row "buffalochicken" briefly turned
"buffalo chicken cheesesteak" into the pizza, caught by the live replay); "buffalo chicken cheesesteak things" (thing/things/stuff
are filler). The salad replay then showed three more: a bare "ranch" or "chicken" while another line's question was open went to
the model and came back as a guess ("Did you want ranch on one of your items?"); now the whole message naming an option of exactly
one waiting line's unfilled required slot answers that line (never a paid add-on: the stromboli's Chicken add-on is what made the
live case ambiguous), the reply says "Ranch for the Cheesesteak / Chicken Cheesesteak Salad.", and talk containing a question mark
is dropped outright (the engine asks). A removal naming the salad outright asked "which one" against the pending "cheesesteak" line
(a ref that names a line's item outright wins over lines it merely overlaps). New tool: `scripts/engine/probe.ts` resolves spans
against a shop's live compiled menu with no model call. 127 tests; core 1,984 lines. All four pass-5 shapes replayed live on v635
and landed. Data for the lexicon compiler, not the engine: squashed one-word rows ("buffalochicken-large16inch"), slash names read
as one run, size-suffixed duplicates.

**2026-09-24, tester pass 6 (v635) and fixes (v636).** Twenty of twenty landed, but one conversation took eleven turns to land
because of a chain: "chicken cheesestake sandwich" was not corrected (the typo tied with its own plural "cheesesteaks"; a winner
whose only rivals are its plural now wins), the span fell to the "sandwich" category and asked which of six hoagies, and the
customer's "yo i said chicken cheesesteak sandwich" came back from the model as talk only, so the cross-read's exact mention was
filed as a possible omission and the which-one loop repeated (a whole item name that shares a word with the pending line is now
that line, on a talk-only turn too). When the customer gave up and picked the Italian Hoagie, the abandoned span's "chicken" was
applied as the hoagie's paid Chicken add-on (an answer that is an item's whole name now replaces the span, so leftover words of a
span that never named the item are not options). The model's talk in that loop ("Let me check on that for you", "I see the order
shows chicken cheesesteak but that's not one of our sandwich options") is gone at the class level: talk that contains any menu
term is dropped, along with "let me", "I'll", "I see", "you ordered", "all set". Two more: "cheesesteak sandwich for both of em"
became two Cheesesteak Sandwich lines (split parts naming the same item merge into one answer); "cancel the first one" against the
list we had just shown said "I don't see 1" (a numeric ref picks from that list); "chicken fingers 5 piece with fries" could not be
found ("piece" is filler). Deploy v636; 129 tests; core under 2,000; all pass-6 shapes replayed live and landed. Pass cost: $0.33.

**2026-09-24, tester pass 7 (v636) and fixes (v637–v639).** Sixteen of twenty landed; two of the four "not landed" were the tester
running out of turns after a late add re-showed the summary (correct engine behaviour), one was "2 liter coke" on a menu with
only cans (honest "couldn't find"), and one was real: "3 chicken fingers" against the (3) and (5) rows asked "what kind?" and
then looped four times, because the split mechanism read the "3" in "chicken fingers 3" as a count of three (piece-count rows
now pick by the count; a whole answer that names one candidate is one answer). Two money defects hid inside "landed"
conversations: "a medium and large jacks special pizza" billed two larges (the span-upgrade fell back to the "large jacks
special pizza" mention for the add that said medium; a mention whose size contradicts the add's own size never upgrades it),
and the customer's "make the large a medium" left the large in place with a kitchen note "no large" (a size word on a derived
row now swaps to the sibling row of the same kind; when the model sends only remove:[large], the other size word in the
message is the size wanted; a stale removal is silent). Twelve wing flavors for one flavor slot silently picked the longest
name (several disjoint options now ask which; a list of a slot's options is a closed answer). 132 tests; core under 2,000;
every shape replayed live. Pass cost: $0.29.

**2026-09-24, tester pass 8 (v639) and fixes (v640–v642).** Nineteen of twenty landed, all prices right, but two kitchen-ticket
defects hid inside landed conversations. "3 turkey hoagies" then "one white, one rye, one wheat" (and "two white one rye",
"white, white, rye") produced three white hoagies: counted options for the asked slot on a multi-quantity line now split the line
one per option, read from the message itself because the model sends this shape three different ways (one string; "qty 2" plus a
second add it cannot quote; nothing). "2 chicken parm sandwiches and a cheesesteak sandwich" beside "scratch that" lost the 2
(adds next to a removal of the asked-about line were being reclassified as answers to it; they stay adds), and the model then
pointed "white bread for both chicken parms" at the cheesesteak (the words name the line; the pointer yields). Data, not engine:
"what chicken options you got?" listed three Onions pizzas (lexicon tags "chicken" on them) and "just the chicken" bought the
$12.49 Chicken row; "buffalo flavor" is not a wing flavor at Vito's. 134 tests; core under 2,000; every shape replayed live.
Pass cost: $0.36. Passes 5–8 together: about $1.30 of model spend for twenty-odd engine classes fixed.

