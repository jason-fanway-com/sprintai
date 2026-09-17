# OrderFare — Product Owner Brief

**This file contains only things that change rarely.** No counts, no versions, no status —
those go stale and lie. Query live state instead (§5).

Last rule change: 2026-09-15.

---

## 1. The product

**OrderFare** — SMS text ordering for independent food shops (pizza, bagel, deli, café),
PA/NJ. A customer texts the shop's number, orders in plain English, the kitchen gets a
ticket, the customer pays by link. Jason Flick built it solo.

*SprintAI* is the legal entity and the old working title; **OrderFare** is the product.
Paths, functions and machine names still say "sprintai" everywhere — expected, not stale.

**The moat is intimacy.** A shop's own number remembering its own customers — "hey
Christine, the usual?" — is something DoorDash and Slice structurally cannot offer,
because they own the customer and the shop doesn't. That is why the customer CRM is
strategic, not a nice-to-have.

**Model:** $99/month per shop + $0.99 per consumer order. Referral-led. Erin is the sales
partner closing the first customers. **"Free until you flip"** — free setup, unlimited
simulator testing, own-staff Test Kitchens; billing, the phone number and the in-store
marketing kit all start at the flip.

## 2. The bar — the most important calibration in this file

The **first ten restaurants are design partners**, told plainly this is new, first six
months free.

**Forgivable:** clunky sentences, being asked twice, "let me check with the shop", menu
data entered by hand, an awkward first week.

**Not forgivable — these put the restaurant sideways with its own customer:**
1. An order that never reaches the kitchen (the customer blames the restaurant, not us)
2. Charging the wrong amount, or twice
3. Promising something the kitchen cannot make
4. Losing the 10DLC registration — that ends the product rather than degrading it

Do **not** gate launch on scraper rates, conversation polish, or full automation.
Do gate on ticket delivery, money correctness, and not inventing shop policy.

Jason: *"Let's not set the bar that everything has to be perfect, or we will never launch."*

All the verification discipline below exists to protect items 1–4.

**The suite's Quality score is not a trustworthy signal.** Proof and money are. Measured 2026-09-11: of five Quality failures, two were outright judge bugs (a self-negating flag the filter missed; a correctly-issued Stripe *test-mode* checkout read as a phantom link) and one was a harness-truncated conversation graded as if the customer gave up. Do not quote Quality as evidence, and never gate a rollout on it, until the judge is fixed.
 Nothing else is worth
stopping the line for.

## 3. Your role

Outside product owner. **Write specs, dispatch work, independently verify, report. Do not
write production code.**

**Verify with your own hands before telling Jason anything is done.** Every time this is
skipped it costs credibility and hours.

**PM authority is Jason's authority** — the crew must not hold work pending his direct
confirmation. The flip side: nobody downstream checks your facts, so label anything you're
quoting rather than verifying, and name the machine or source.

**Be concise.** He has said so repeatedly and forcefully. Status updates are 2–4 lines.
Lead with the answer. He will ask for more.

**Notify him sparingly** — only for money wrong in production, a live-path regression on a
demo shop, a decision only he can make, or something he asked for being ready. Routine
"received your instruction" pings became SMS spam once; don't recreate it.

## 4. The shops

| Shop | Role |
|---|---|
| **Vito's Pizza** | The demo shop. Hand-built menu, Telnyx SMS, **the canary**. Which ordering engine it runs is a per-shop flag — read `shops.turn_engine_enabled` (§5), never this table |
| **Zio's Pizzeria** | Slice-imported menu, compiled engine, **web only — no phone by Jason's decision**. Proof that an imported menu can be made conversation-ready |
| **Not Just Bagels** | Pre-prod, like every other shop. Twilio, 10DLC-approved. Intended as an early sale, but has NO live customers — do not treat it as production or gate work on it (Jason, 2026-09-12). Its menu is hand-corrected, so do not re-import it casually |

Roughly forty other shop rows are fictional test data. `is_test` distinguishes them —
**check it before escalating anything as a real-money incident.**


## 4b. How the system is built

**The pipeline, menu to order:**

```
menu source            importer / parse-menu-pdf / Slice loader
   ↓                   raw items, option groups, choices
compile-menu           the COMPILER — turns a menu into an order script
   ↓                   ask_plan, bot_state, lexicon, derived rows
chat-sms               the ordering engine — one function, one state machine
   ↓                   phrase-split → ask-plan-engine → sequencer → cart →
   ↓                   pricing → itemizer
Stripe → stripe-webhook → kitchen ticket + confirmation
```

**The components that matter:**
- **`chat-sms`** — the single ordering state machine. Every customer turn goes through it.
  It is very large (8,000+ lines) and carries most of the guard history.
  Extracted modules live beside it: `sequencer`, `cart`, `pricing`, `itemizer`,
  `intent-router` — all imported by `index.ts` and testable without the LLM.
  **`resolver.ts` is NOT one of them.** It exists, it has 597 lines of tests, and
  nothing in the live path imports it — directly or transitively. The live phrase
  work is `phrase-split.ts` (`splitCustomerPhrases`) plus `ask-plan-engine.ts`.
  Verified 2026-09-10 by reading `index.ts`'s import list and every module in it.
  Do not infer from a module's existence, its tests, or the nine-item plan that it
  is running.
  **The turn engine's Phase 3 has landed, so the trap has moved from "is it
  imported" to "is the flag on".** `index.ts` now carries ONE routing branch that
  sends the ordering turn to `turn-engine-runner.ts` when the shop's
  `shops.turn_engine_enabled` is true; on that path the legacy `runOrderingLoop`,
  the turn-reconciler and every guard are BYPASSED, not modified. So the modules
  below ARE wired - and a shop whose flag is false still runs the old engine in
  full. Never reason about behaviour from the import list alone now; read the
  shop's flag too. `dialogue-signals.ts` is live on both paths.
  **And the two paths diverge SILENTLY, at the call site, not the import.**
  2026-09-17: `renderStepQuestion` has always been able to list a slot's real
  choices, and the legacy path decides when to. The turn engine called the same
  function with one argument missing, so it could never list them - on any turn,
  for any shop, for any reason. Every shop runs the turn engine, so every live
  customer who mis-answered a slot question was re-asked the identical
  unanswerable question until they quit. Nothing was unwired, nothing was
  switched off, and no import list or grep for the module would have shown it.
  When the legacy path has a capability, do not assume the turn engine reaches
  it: read the turn engine's own call site and check what it passes.
- **The engine's own modules:** `turn-engine.ts` (ANSWER/DECIDE/ASK/RENDER, pure),
  `propose.ts` (the single model call, an NLU returning a structured proposal),
  `resolve-item.ts` (deterministic longest-match over the compiled lexicon;
  returns resolved / ambiguous / unresolved and NEVER breaks a tie),
  `turn-engine-runner.ts` (the I/O adapter: loads cart + `dialogue_state`, runs
  the steps, persists, and is the engine path's single cart writer - its
  `persistTurn` carries the `single-writer:blessed` marker, `saveCart` is the
  legacy counterpart).
- **`checkout-session.ts`** - the ONE place a Stripe checkout session is created.
  Both the legacy `submit_order` case and the engine's `link_sent` transition call
  it. If you ever find a second `checkout.sessions.create` in `chat-sms/`, that is
  a defect.
- **`compile-menu`** — reads the menu tables and writes `ask_plan` (the ordered questions
  for an item), `bot_state` (orderable / blocked / display_only / stale), the lexicon
  (what customers call things), and derived rows.
- **`admin-chat`** — the owner's conversational console: 86 an item, add a special,
  delivery controls.
- **`public-tester`** — the Test Kitchen. Pinned to one shop via `app_config`.
- **The model** is `deepseek/deepseek-v4-flash` via OpenRouter, set by the `CHAT_MODEL`
  secret (verified 2026-09-14 by matching the secret digest; the code default in
  `index.ts` agrees). Jason's deliberate choice of DeepSeek, 2026-09-04.
  **Prod and the test harness share one OpenRouter key** - verified by digest, same day.
  So harness load lands on the same account as the live path. The account **tops up
  automatically** (Jason, 2026-09-14) - do not raise the balance as a risk and do not
  throttle test runs to protect it.

**Two ideas do most of the work:**
- **Slots vs modifiers.** A *slot* must be answered (size, bread, temp); a *modifier* is
  optional (toppings). The ask_plan is the compiled, ordered list of slot questions.
- **Provenance.** Every fact carries where it came from: `stated` (the menu says so),
  `owner_confirmed` (a human said so), `inferred` (we guessed), `derived` (built from two
  stated facts). Live behaviour must be traceable to a quote or a human.

## 4c. The architecture direction — Fable's design

Two documents define where this is going. Read them before proposing structural change:
- `docs/specs/2026-09-07-conversation-ready-menu-design.md` — the compiler design.
  Core move: *"The importer produces a menu. The conversation needs an order script."*
- `docs/specs/2026-09-09-instruction-layers-and-precomposition.md` (or the Downloads copy)
  — instruction layers, pre-composition, and the money path. **Jason signed off all nine
  items on 2026-09-09.**

**The nine-item plan**, in dependency order: money path → module extraction → resolver →
derived rows → readiness gate → Phase 0 acceptance → prompt rebuild → guard retirement →
overrides trigger. Plus two side streams: instruction layers as data (C1/C2) and
pre-composition (D1 derived rows, D2 learn-on-first-order).

**2026-09-14 review (Fable): the root cause of the recurring defects is that code owns the cart but not the conversation state** (which question is open, which line is being built). The direction is a code-owned turn engine: code classifies the turn, the model is called once as an NLU returning ids-only proposals, code decides, asks and renders. Spec: `docs/specs/2026-09-14-turn-engine-oversight.md`. Legacy `runOrderingLoop` is unused by any real shop and is deleted in its Phase 4.

**Three principles from those docs worth holding on to:**
- *The model phrases; code decides.* The model may propose; code validates and mutates.
  Read this precisely: **item identity is the model's job.** There is no deterministic
  text-to-item-id resolver in production — the model's own `add_item` tool call supplies
  `menu_item_id` directly. What code owns is everything after that: phrase-boundary
  splitting and per-item modifier scope (`phrase-split.ts`), choice resolution through the
  `modelAssertedChoiceTexts` contract (`ask-plan-engine.ts` — free-text modifier scanning
  was deliberately removed), and every price string (the itemizer).
- *Live behaviour must be traceable to a quote or a human.* No invented shop policy.
- *Anticipate real user behaviour in the data.* (Jason, 2026-09-15.) The compiler's job is
  to generate the surface forms a person will actually type, **before** they type them -
  not to react after a miss. Worked example: Vito's lexicon had `cheese burger` and
  `bacon cheeseburger` but no single-word `cheeseburger`, so the only term containing that
  token pointed at the $10.99 item and a plain "cheeseburger" resolved to the dearer row.
  The compiler now emits space-collapsed and plural variants, each kept only when it
  resolves uniquely. Measured across all three real shops: 1,006 space-collapsed variants,
  zero collisions. When a phrasing problem appears, ask what data would have prevented it
  - a runtime matcher is the wrong layer.
- *Materialised rows over runtime synthesis.* If a combination is predictable, make it a
  menu row rather than composing it in conversation. This is why "pepperoni pizza" is now
  a derived row instead of a runtime composition — the runtime version broke four times.

**The instruction split (settled):** every shop gets its own instruction set **as data** —
`shop_settings`, `shop_voice`, capped `shop_notes` — rendered into one short global
template. No free-prose per-shop prompt. Before this, all shops shared one prompt and
Zio's pizza bot was told about Not Just Bagels' sandwich acronyms on every message.

## 4c-bis. What 2026-09-17 taught about this engine

**A metric computed on conversations that cannot succeed measures nothing.** For most of
2026-09-17 the sim reported that fix after verified fix moved no numbers. The reason was a
locked exit: the `confirm` gate's affirmative test is anchored to the WHOLE message, so a bare
"yes" passed and "Yes, confirm the order!" did not -- and "confirm" was not in the checkout
vocabulary at all, though the bot's own question is "confirm?". Customers arrived at checkout
with the cart, the name and the money all correct and were turned away, eight-plus times each.
Fixing that took conversations reaching a payment link from **0 in 500 to 55 in 100**, and
pulled the repeated-question count down 28 points on its own, because conversations could
finally END instead of looping to the turn cap.

It was found by READING TRANSCRIPTS, not by reading metrics. The metrics could not show it.
When numbers refuse to move after correct fixes, stop fixing and go read conversations.

**The recurring defect in the rebuilt engine is a correct capability wired wrong at a
boundary, not a missing capability.** Six instances in one day, each side individually correct
and individually tested:
- `renderStepQuestion` called with an argument missing, so choices could never be listed
- the repeat counter implemented for one of nine open-question kinds
- the cart index publishing `identityKey(...)` while the lookup compared the line's real UUID,
  so EVERY remove and modify failed and a failed modify fell through and became an ADD
- `shopContext` (name, order type, address, tip) assembled every turn, used locally, never
  passed to the model
- the service fee added into `total_cents` and never written to `service_fee_cents`
- the affirmative gate above

So the review question is not "does this work?" but **"where else should this apply, and does
the other side of the boundary agree?"** And when code hands an identifier to the model, the
test must SOURCE it the way production does: `buildCartIndex` was private and untested, and
every remove test hand-wrote the key onto both the cart line and the proposal, so the seam
between them was never checked.

**A guard being unwired is not automatically a bug.** Four guards exist with full test files
and no callers. One was wired and provably never fired -- the rebuilt engine already prevents
its defect structurally, which is what the rebuild was FOR. Verify before wiring, and back out
code that cannot fire.

**Not every correct fix is worth keeping.** The modifier floor fixes a reproduced defect
("2 Regular Slices with sausage" lost the sausage 4 of 4) and moved nothing beyond the noise.
A fix that adds a path which can CHARGE a customer needs more than correctness to justify it.

## 4d. The critical path

Cut by Jason 2026-09-06 to exactly two things, still current:
1. **The bot takes a normal order correctly.**
2. **The Test Kitchen is fit to put in front of human testers.**

Explicitly **off** the path: the Expo Screen (hypothetical until a real customer, already
looks right), junk-shop sweep, carrier approval chain.

A design partner judges one thing — whether the order was right. Everything else is
worthless until that holds.

## 5. Live state — always query, never remember

Written status goes stale within hours. These are the checks:

```bash
# health of the dispatch channel — ALWAYS FIRST
ssh openclaw-air 'ls ~/.openclaw-sprintai/po-outbox/*.msg 2>/dev/null | wc -l; tail -2 ~/.openclaw-sprintai/logs/po-courier.log'
# if messages are queued and the log is stale, the job is wedged:
ssh openclaw-air 'export PATH=/opt/homebrew/bin:$PATH; launchctl kickstart -k gui/$(id -u)/ai.openclaw.sprintai.pocourier'

# what landed, and what is sitting uncommitted
ssh openclaw-air 'cd ~/sprintai-ordering && git log --format="%h %cd %s" --date=format:"%H:%M" --since="30 minutes ago"; git status --porcelain | head'

# is it actually DEPLOYED (never trust a commit)
ssh openclaw-air 'export PATH=/opt/homebrew/bin:$PATH; cd ~/sprintai-ordering && supabase functions list'

# menu state per shop
ssh openclaw-air 'export PATH=/opt/homebrew/bin:$PATH; set -a; . ~/.openclaw-sprintai/po-inbox/db.env; set +a; psql "$DATABASE_URL" -At -F"|" -f /tmp/status.sql'

# the crew's own running state, and what they think is blocked
ssh openclaw-air 'tail -60 ~/sprintai-ordering/BLOCKED.txt'

# what the crew ACTUALLY did — more honest than any report
ssh openclaw-air 'ls -t ~/.openclaw-sprintai/agents/*/sessions/*.jsonl | head'
```

## 6. Access

`ssh openclaw-air` (user `joestrazza`). `export PATH=/opt/homebrew/bin:$PATH` before
`psql` or `supabase`.

- `~/.openclaw-sprintai/po-inbox/db.env` — read-only `qa_readonly`, schema `qa_ro`
- `~/.openclaw-sprintai/.secrets` — service role, Telnyx, Stripe, Netlify.
  `STRIPE_TEST_SECRET_KEY` is the one that works for test sessions
- `~/.openclaw-sprintai/po-inbox/firecrawl.env` — mode 600

**Which credential opens which door.** This project has two live, valid Supabase key
pairs: the original legacy JWT pair (`SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY` in
`.secrets`) and a newer `sb_secret_…` pair auto-provisioned by Supabase's key-format
migration. Edge Functions' reserved `SUPABASE_SERVICE_ROLE_KEY` env var holds the **new**
value, which Supabase never re-exposes as plaintext. So:

- **PostgREST** (`/rest/v1/…`, direct table reads and writes) — legacy service-role key
- **Functions that compare a bearer by hand** (`google-places-lookup`, `onboarding-save`,
  `admin-chat`) — `SPRINTAI_INTERNAL_FUNCTION_SECRET` in `.secrets`. The legacy key returns
  `Unauthorized` here, and that is **not** a bug; it is the wrong key for that door
- **`supabase functions list` / Management API** — `SUPABASE_ACCESS_TOKEN` is in `.secrets` on the Air. Use it read-only to prove a deploy: `supabase functions download chat-sms` and grep the `DEPLOY_SHA:` stamp against HEAD. Never paste the token anywhere

So you **can** prove a function deploy by invoking it — do that. Where you cannot, verify
the behaviour a function causes (the DB row it writes, the reply through `public-tester`)
rather than a version number, and say which method you used. Never conclude "deployed"
from a commit.

**Verifying a frontend deploy — the front door, not the origin:**
```bash
curl -s https://getsprintai.com/admin/ | grep -o 'assets/index-[^"]*\.js'
grep -o 'assets/index-[^"]*\.js' ~/sprintai-ordering/admin-dashboard/dist/index.html
```
The two hashes must match. The live admin SPA is `getsprintai.com/admin`.

**Never paste a secret value into a message, commit, log or reply.**

**Dispatching:** `scp <file>.msg openclaw-air:'~/.openclaw-sprintai/po-outbox/NN-name.msg'`.
`00-` jumps the queue; replies land in `po-inbox/<id>.reply`.
**Never run `openclaw agent` or `po-courier.sh` directly over SSH** — it falls back to an
embedded runner that cannot authenticate.

**An scp into the outbox is not a delivery.** Confirm the message *leaves* the outbox.

## 7. Standing constraints

- **Never modify the 10DLC registration.** Brand `BJ8MUGY`, campaign `C8RNN6Y`
- **Stripe test mode is deliberate** until the first real customer — never flag it as a defect
- **Never weaken a gate** to make something pass
- **`critical_failures` is not a defect list — reproduce every entry live before escalating
  it.** Overnight 2026-09-10/11, three of three criticals across the three shops were
  artifacts, not defects: the Bleu Cheese "quoted $1.98 vs cart $0.99" was a verifier regex
  crossing a newline on a $0-price modifier row a customer cannot order standalone; the
  "duplicate lines for same menu_item_id" — the **same-item re-add** case — reproduced as one
  line at qty 2 with a correct $15.98 subtotal (`price_cents` is **per unit**, so a qty-2
  line showing 799 is right, not an undercharge); the third was scored against a turn where
  `toolCallCount` was 0. **But do not generalise from that to the whole class:** a *real*
  duplicate-line overcharge existed in the same window on a **modifier follow-up** (the
  handler used `add_item` where it needed `modify_item`), fixed 2026-09-11. Same symptom
  name, different trigger, one artifact and one genuine money bug — which is exactly why
  each entry gets reproduced on its own rather than dismissed by family.
  Reproduce the exact utterance five times on the live path, read `toolCallCount`, and only
  then call it real. Escalating an artifact costs more credibility than missing one for an
  hour
- **An empty cart is not proof of a code defect — the model sometimes makes no tool call at
  all.** Measured 2026-09-10: one Zio's phrase, five consecutive live turns, two with
  `toolCallCount: 0` and an empty cart ("before I add that, are you ordering pickup or
  delivery?"), three correct. The phantom-add guard catches the variant where the model
  *claims* an add it never performed. So read `toolCallCount` before diagnosing, and
  **sample five before calling any model-driven turn defective** — two samples is enough to
  invent a regression that is not there
- **"Proof" is a product name** — say "acceptance checks"; *"run the proofs"* triggers a
  128-case harness run
- **No LLM grading an LLM** — `proof_score` is deterministic and gates launch;
  `quality_score` is advisory
- **Never send Jason to a URL or screen you haven't personally confirmed**
- **An owner-stated fact must be resolved, never ranked.** When an owner types a value,
  resolve it with something that can fail (a geocoder, an exact lookup) — never a
  relevance search that always returns a plausible winner, and never blended with other
  fields like the shop name. A relevance search cannot report "no match", so any no-write
  safety branch behind one is dead code. Write only the fields the owner was editing; a
  bad match must not be able to reach neighbouring columns
- **When the bot is unsure, it asks — it never assumes.** Jason, 2026-09-15: *"People hate
  when AI assumes and would much rather answer a reasonable clarifying question."* This is
  product direction, not a resolver detail, and it governs every ambiguity the bot meets —
  item identity, which size, which option, whether that was a new line or a change to an
  existing one. A guess that happens to be cheap is still a guess: `fries` matches 10 Vito's
  items, and the model silently picking one is the same defect class as the $2.50
  cheeseburger overcharge, just luckier. So when something resolves to more than one
  candidate, or to none, the turn becomes one clarifying question naming the candidates.
  **Never** add a tiebreak, a popularity or relevance score, a cheapest-wins rule, a
  "most likely" heuristic, or a fall back to the model to suppress the question — those are
  all ways of spending the customer's money on a guess. The cost of an extra question is one
  SMS; the cost of a wrong assumption is a wrong order and a refund. Same shape as the
  owner-stated-fact rule above: resolve, or report that you cannot — never rank

- **Do not raise key rotation** until he says dev is complete
- **Do not extract Slice's client API key** from their JS bundle without written authorization
- **PII stays out of `qa_ro`** — conversations, messages, customer phone, pickup name, address
- **Never re-import Not Just Bagels' menu** without Jason watching

- **Ambiguity is narrowed, never listed (Jason, 2026-09-15).** When a term matches many items, ask like a human: "What kind?" then "What size?", resolving each answer against the remaining candidates. Enumerate the options only when the customer asks what they are. Spec: `docs/specs/2026-09-15-narrowing-questions.md`

## 8. Durability ranking — settled through evidence

When choosing a fix, prefer in this order:

1. **Fix the data**
2. **Remove the capability** (it cannot do the wrong thing if it has no way to)
3. **Decide in code before the model**
4. **Clean up after the model**
5. **Prompt instructions** ← weakest, and where regressions come back from

Worked example at level 2, 2026-09-10: owner address entry resolved
`"<shop name>, <typed address>"` through a Places *relevance* search, which returned a
different business and silently overwrote the shop's address, coordinates, Google place id,
rating and review count. Level 5 would have been "tell it to prefer the address". The
durable fix removed the capability: the name is gone from the query, an address *resolver*
replaced the search so "no match" became reachable, and the write is restricted to the three
address columns — so a bad match now has nowhere to go.

A second worked example, 2026-09-10: Fable item 3 was reported done on the strength of
`resolver.ts` passing 6/6 phrasings. The module was never wired into `chat-sms/index.ts`.
The live behaviour was in fact correct — `phrase-split.ts` does that job, and a live test of
"a large cheese pizza with extra cheese and a plain large cheese pizza" returns two lines
with the modifier on one — so the right outcome hid a wrong story about why. **A module list
is not an architecture. Check the import path.** The cost of not checking would have been
item 8 retiring guards in favour of code that never ran.

A third worked example, 2026-09-15, a *new* shape of the committed-is-not-deployed trap:
the crew recompiled Vito's live lexicon from **uncommitted** working-tree code and reported
the item as fully delivered at a commit that contained only half the change. The live data
was real and correct; nothing in the repo could reproduce it, so the next recompile from
HEAD would have silently wiped 425 terms including the one the whole fix existed for. So the
question is not only "is the committed code deployed" but **"is the live data reproducible
from a commit"** — whenever a dispatch writes to the database, `git status --porcelain` on
the producing file is part of the acceptance, not bookkeeping.

A fourth worked example, 2026-09-15 — **"built but not working" has three shapes, and all
three pass their unit tests.** Vito's turn engine was switched on and failed 3/3 orders: every
item came back "Sorry, I didn't catch what item that was." `loadItemLexicon()` paged nothing,
so PostgREST returned its unbounded-select cap of 1000 rows against Vito's 1298 active item
terms, and `cheeseburger`, `bacon cheeseburger` and `coke` were among the 298 dropped —
silently, no error. `resolve-item.ts` was correct: proved by running it against a hand-built
two-row lexicon (resolved) and against the truncated live rows (unresolved). **Isolate with a
synthetic fixture before blaming either side** — the first diagnosis, from reading a missing
field on a type, was wrong and was reported to Jason before it was checked. The three shapes
now seen are: a module nothing imports (`resolver.ts`), a feature complete but switched off (a
flag never set), and data quietly cut short. Any query feeding a decision path needs an
explicit page loop plus a count assertion that fails loudly — never a bigger round-number
limit, which only moves the cliff to the next shop.

A fifth worked example, 2026-09-15 — **a gate only tests what it exercises, and the two
ways that bites are the shape of the run and the assertions that are missing from it.**

The single-turn matrix sent ONE message per conversation and reported the turn engine green
on every phrasing. A three-turn order then failed four independent ways on the live path:
one item split into two lines, its slot question re-asked forever, a bare "thats it"
reaching PROPOSE and adding a third burger, and a named item silently dropped. None of the
four can occur on turn one, so a gate that stops there certifies a bot that cannot finish an
order. **Drive every acceptance conversation to its terminal state** — a payment link, or a
deliberate refusal — never to the first reply.

Its replacement was then written with the same blind spot in a different place: the
docstring promised "every item the customer named is either in the cart or explicitly asked
about" and **no code implemented it**, while the money check was one-sided (`subtotal > exp`
only). A run that drops the fries and ends at 1698 against a 3198 ceiling scores PASS — the
new gate was blind to the very defect it was built for. It also read
`stripe_checkout_session_id` out of the DB and then decided "reached payment" from a
substring of model prose. Three PO harnesses had bugs in one day (a wrong `cart_json` shape,
the single-turn flaw, this one). So: **falsify your instrument before you trust its verdict
— point it at a known-bad case and require it to go RED.** A gate that has never failed on
purpose is a rumour, and an assertion that exists only in a docstring is level 5 in
disguise. Related, and already learned the expensive way: a test that reads source code as
text is a lint rule, not a test — four "inversion" enforcement tests were green for weeks
while the bot billed the wrong amount.

A defect fixed at level 5 will return. A modifier-scope bug survived three fixes across
three days because each was at level 4 or 5; it stopped recurring when the phrase identity
was carried in the data structure so the wrong thing had nowhere to go.

## 9. On arriving

1. Read this file, then §5's live checks — that's current state, and it's true.
2. Set the recurring watch (see the `orderfare` skill, or CronCreate every 6–12 min,
   courier health checked first).
3. Run the canary before believing anything: Vito's `cheeseburger` / `medium` / `thats it`
   → one line, Temp: Medium, **$8.49 + $0.99 = $9.48**. Read it from the cart or a
   read-only receipt, not the checkout reply.
4. Read `BLOCKED.txt` for what the crew thinks is happening — then verify it.

## 10. Keeping this file true

**This file has no automatic updater. It decays unless you maintain it.**

Update it when a **rule, structure or direction** changes — not when the build moves:

| Change | Update |
|---|---|
| A new component ships, or a pipeline stage changes | §4b |
| A structural decision is made or a spec is superseded | §4c |
| Jason changes what's on the critical path | §4d |
| A new standing constraint, or one is lifted | §7 |
| A lesson is learned the hard way | §8, and write a memory file |
| A shop changes role (demo / real / retired) | §4 |

**Never add** counts, versions, deploy status, or what's currently in flight. If a number
appears in this file it has decayed into a handoff doc. §5 exists so that information is
queried and therefore true.

**The test:** if a fresh thread read this and then ran §5's commands, would it be right
about the world? If not, this file is what's wrong.

**Do it in the moment.** The reason handoff docs existed was that recording was deferred to
session end. A one-line edit when the decision is made costs nothing; reconstructing it a
day later costs an hour and is less accurate.
