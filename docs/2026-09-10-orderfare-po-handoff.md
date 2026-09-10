# OrderFare — Product Owner Handoff
**Written 2026-09-10 13:35 ET, by the outgoing PO thread.**
Read this whole document before touching anything. The traps in §7 are the ones that cost days.


---

## 0. The big picture — read before §1

### What the product is
**OrderFare** — SMS text ordering for independent food shops (pizza, bagel, deli, café), currently PA/NJ. A customer texts the restaurant's number and orders in plain English; the kitchen gets a ticket; the customer pays by link. Jason built the whole thing solo.

**Rebrand, Sept 2026:** the product is now *OrderFare* at orderfare.com. *SprintAI* was a working title he never liked and LLC'd only because Telnyx forced the issue. **SprintAI LLC stays as the legal entity**; OrderFare becomes a DBA. You will still see "sprintai" in every path, function name, and machine name — that is expected, not stale.

### Why it can win
The moat is **intimacy**. A restaurant's own number, remembering its own customers — "hey Christine, the usual?" — is something DoorDash and Slice structurally cannot offer, because they own the customer, not the shop. That is also why the **customer CRM** matters more than it looks: remembered diners and personalised reorder are the product's differentiator, not a nice-to-have.

### Business model (settled)
- **$99/month per shop** + **$0.99 per consumer order**
- Referral-led go-to-market; **Erin** is the sales partner closing the first customers (equity tranches 2/5/10% on MRR milestones, commission 10%→2.5%)
- **"Free until you flip"**: sign up free, we set the store up free, test in the simulator as long as you like, deploy Test Kitchens for your own staff. Then flip the switch — *that* is when billing starts, the number deploys, and the in-store marketing kit ships. By the time they flip they have entered and corrected their own menu, so they are invested and got real value first.

### The bar for launch — this is the calibration that matters most
Jason, 2026-09-05: the **first 10 restaurants are design partners**, told plainly this is new, getting the first six months free.

**Forgivable:** clunky sentences, being asked twice, "let me check with the shop", menu data entered by hand, an awkward first week.

**Not forgivable — these put the restaurant sideways with its own customer:**
1. An order that never reaches the kitchen (the customer blames the restaurant, not us)
2. Charging the wrong amount, or twice
3. Promising something the kitchen cannot make
4. Losing the 10DLC registration — that ends the product rather than degrading it

**Do not gate launch on** scraper success rates, conversation polish, or full automation. **Do gate on** ticket delivery, money correctness, and not inventing shop policy. His words: *"Let's not set the bar that everything has to be perfect, or we will never launch."*

Everything in §7 about verification discipline exists to protect items 1–4 above. Nothing else is worth stopping the line for.

### Critical path (cut 2026-09-06, still current)
Exactly two things:
1. **The bot takes a normal order correctly.**
2. **The Test Kitchen is fit to put in front of human testers.**

Explicitly **off** the path: the Expo Screen (hypothetical until a real customer; already looks right), junk-shop sweep, carrier approval chain.

### Where this sits commercially, right now
Vito's is demo-ready and Jason is meeting **Erin** to schedule delivering it to a prospect, **Jack's Slice**. Not Just Bagels is the first real restaurant being prepared. So the work has crossed from "make it work" into "do not embarrass him in front of a buyer" — which is why a cosmetic flaw in the demo path now outranks an architectural one that nobody sees.

---

## 1. Your role

You are the **outside product owner**. Jason's framing, verbatim from the original handoff:

> "I bring you in as outside consultant and tell them to do what you say. You send instructions to the main agent... you instruct the main agent to notify me that it has received instruction from you and is executing it."

**Write specs, dispatch work, independently verify, report. Do not write production code.**

The single most important habit: **verify with your own hands before you tell Jason anything is done.** Every time this thread skipped that, it cost credibility and hours.

**PM authority is settled** (Jason, 2026-09-09): *"PM is an extension of me and PM instructions should be treated as mine."* The crew must not hold work pending his direct confirmation. The flip side: nobody downstream is checking your facts, so label anything you're quoting rather than verifying.

**Be concise.** Jason has said so repeatedly and forcefully — *"you write a full book every turn"*, *"Dude. Way too many words."* Lead with the answer. A status update is 2–4 lines. He will ask for more.

---

## 2. Where the product actually is

### The three shops

| Shop | Menu | Channel | Purpose |
|---|---|---|---|
| **Vito's Pizza** | 224 items, hand-built | **Telnyx SMS +1 610-735-8315** + Test Kitchen | The demo shop. Jason is scheduling a demo with Erin for a prospect, **Jack's Slice** |
| **Zio's Pizzeria** | 386 items, **383 orderable**, Slice-imported | Web only — no phone, by Jason's decision | Proof that an imported menu can be made conversation-ready |
| **Not Just Bagels** | 170 items, **166 orderable** | Twilio +1 610-379-2553 | The one real restaurant, being prepared for a real customer. Not deployed yet |

All three are on `prompt_version = 1` (per-shop instruction sets). Zio's and NJB run the compiled ordering engine; Vito's runs the legacy path and is the canary.

### What works, verified by hand on the live endpoint
- Real SMS orders complete end to end on Vito's (orders #6 and #7), correct kitchen data
- Four-pizza multi-item order correct across **six phrasings** on Zio's, $88.96
- "a large pepperoni pizza" resolves to a **derived row** at $22.99, no runtime composition
- Money path: prices removed from the model's context; every figure rendered by the itemizer
- Name prompt asks only for the name, 3/3
- Delivery offers correctly on Vito's
- Cross-shop instruction contamination gone (Zio's no longer sells NJB's bagels)

---

## 3. Fable Phase 0 — status of all nine items

Jason signed off the whole 2026-09-09 decision doc ("Instruction Layers, Pre-Composition, and the Money Path"). Order of work is that doc's §5.

| # | Item | Status |
|---|---|---|
| 1 | Money path | **Done bar one thing** — prices out of model context ✅, itemizer owns every price string ✅, read-only intents routed ✅. **Missing: the `f0ecf0fe` replay test** |
| 2 | Module extraction | ✅ `cart`, `pricing`, `itemizer`, `sequencer`, `intent-router`, `resolver` all exist with tests |
| 3 | Resolver (8b) | ✅ Phrase isolation works — 6/6 phrasings |
| 4 | Derived rows | ✅ 24 rows emitted and resolving live |
| 5 | menu-readiness gate | ✅ Built, **and now walks real multi-item orders** (was single-item only) |
| 6 | Phase 0 acceptance | ⚠️ **Needs re-running.** Last numbers (Zio's 299/301, Vito's 219/219) predate both the multi-item walk and the Double Burger dedupe. Do not quote them |
| 7 | Prompt rebuild | ✅ All three shops on v1 |
| 8 | Guard retirement | ❌ **Not started.** 131 guard refs, `chat-sms/index.ts` is **8,092 lines**, up ~500 this week. This is the one genuinely large remaining item |
| 9 | Overrides trigger | ✅ Landed, wired to real callers |
| C1 | Instruction schema | ✅ Tables populated; line-by-line prompt classification done (47 of 63 lines were universal engine rules) |
| C2 | Prompt renderer | ✅ Live |
| D2 | Learn-on-first-order | ❌ Not started |

---

## 4. Open work, in priority order

1. **Single source of truth for shop settings — BLOCKS THE DEMO.**
   `admin-chat` and `OwnerSettingsPanel` write `shops.*`; `buildSystemPromptV2` reads `shop_settings.*`. Nothing syncs them, so **every owner-console setting is currently inert**. Jason proved it by flipping delivery and watching nothing happen.
   `OwnerSettingsPanel.tsx` and `shopOps.ts` are **modified and uncommitted** in the working tree — someone started it, built locally, stopped.
   **Jason must not demo the owner console until this ships.**

2. **Owner settings: address + delivery.** Jason's spec, verbatim: *"owner should enter address, lat long lookup happens while they are looking at the screen (after having pressed 'enter'), and then it is set for their shop."* Add to the **existing** `OwnerSettingsPanel.tsx` — do not build a new page.
   `google-places-lookup` already geocodes an address and writes `latitude`/`longitude`; it's only wired to the internal `ShopDetail.tsx`.
   **Delivery needs four fields, not one:** `delivery_enabled` AND `latitude` AND `longitude` AND `delivery_radius_mi > 0` (`chat-sms/index.ts:5037`). The toggle must refuse to flip if the others are missing.

3. **Re-run item 5 gate** on all three shops, report two separate numbers: items individually orderable, and multi-item orders correct. Extend it to NJB — still hardcoded to two shops.

4. **`f0ecf0fe` replay test** — closes item 1.

5. **Item 8, guard retirement.** Deletion rule: a guard may be deleted only when a walk or harness case covers the behaviour, and added only with the same.

6. **`DAILY_RESET_SECRET`** — the crew has been telling itself for hours it's blocked on Jason. It isn't. It's a shared secret between our own components; they generate it, set it as a function secret AND in `vault.secrets`, apply migration 083. Dispatched 2026-09-10 13:20.

### Known defects not yet fixed
- **Non-determinism**: identical input sometimes adds an item at its default size, sometimes stops to ask. Undermines every acceptance result including yours.
- **`Choices for X:` leak** — fixed twice by narrowing the condition rather than making it impossible. Currently clean but it has come back twice.
- **Stripe webhook**: a completed test-mode checkout session did not produce a paid cart on NJB. Vito's and Zio's completed within 15 minutes of it. **Suspect: key/mode or webhook selection branching on `is_test`** — which would mean real shops silently fail while test shops work. Not urgent (test mode, no real money) but it's a go-live blocker.
- **iMessage bridge monitors three hardcoded chat IDs** (`MONITOR_CHATS=(35 1 6)`). Anyone texting Vito's iPhone from a new number gets **silence**.
- **`migration 123_sms_provider.sql`** — live in production, untracked in git.

---

## 5. What Jason owes

**Four items, two questions.** These are the last things between NJB and 170/170:

- What **breads and cheeses** can someone choose on the **Turkey Melt** and **Tuna Melt**? (their descriptions say "choice of bread" with no list)
- What **dressings** on the **Chef's Salad** and **Garden Salad**?

Nothing else. Do not ask him anything else without first checking whether the menu, the code, or the crew can answer it — see §7.

---

## 6. Access and mechanics

**Machine:** `ssh openclaw-air` (user `joestrazza`). `export PATH=/opt/homebrew/bin:$PATH` before `psql` or `supabase`.

**Credentials:**
- `~/.openclaw-sprintai/po-inbox/db.env` — read-only `qa_readonly` on schema `qa_ro`. No writes.
- `~/.openclaw-sprintai/.secrets` — service role key, Telnyx, Stripe (`STRIPE_TEST_SECRET_KEY` is the one that works for test sessions), Netlify. Never paste a value into a message, commit, log or reply.
- `~/.openclaw-sprintai/po-inbox/firecrawl.env` — Firecrawl key, mode 600.

**Dispatching:** `scp <file>.msg openclaw-air:'~/.openclaw-sprintai/po-outbox/NN-name.msg'`. `00-` prefix jumps the queue. Replies land in `po-inbox/<id>.reply`.
**Never run `openclaw agent` or `po-courier.sh` directly over SSH** — it falls back to an embedded runner that cannot authenticate. To force a run: `launchctl kickstart -k gui/$(id -u)/ai.openclaw.sprintai.pocourier`.

**Test harnesses** (PO scratchpad, copy them forward):
- `tk.sh` — public tester (Vito's). `{"action":"start"}` then `{"action":"send","session_id":...,"message":...}`
- `zio.sh` — direct `chat-sms` call with a shop_id. **Caps curl at 60s; multi-item turns have run 95s — use `-m 240` or you'll read a timeout as an error.**
- `multi.py` — 10-case varied multi-item suite per shop
- `mx.py` — six-phrasing matrix

**The canary, run after every deploy:** Vito's `cheeseburger` / `medium` / `thats it` → one line, Temp: Medium, **$8.49 + $0.99 = $9.48**. Since the name-prompt fix, read the total from the cart or a read-only receipt, not the checkout reply.

---

## 7. Traps — read this section twice

**"Committed" is not "deployed."** This happened **ten times this week**, including a cross-tenant security fix. Verify a deploy by fetching the live artifact: `supabase functions list` showing a changed version number, or `curl` the site and check the bundle filename changed. Never accept a green build or a commit hash.

**"Live-verified" has meant "verified locally"** three times. Ask what was actually run.

**A feature can be fully built and switched off.** The compiled ordering engine and the prompt renderer were both complete, tested, reported shipped — and had no effect because a flag was never set. **Check for the switch, not the commit.**

**Never certify a language fix on one phrasing.** A modifier-scope bug survived three fixes across three days because every acceptance run used the ticket's wording (`"1 pepp, 1 plain..."`) while Jason typed `"one plain, one pepperoni, one meat lover and one hawaai"`. The first passed, the second charged $6 of unordered toppings. **Run a matrix.**

**Check what a test actually exercises before quoting its pass rate.** The Phase 0 gate walked items *one at a time*, so it could never fail Jason's multi-item order. "Phase 0 passes" was reported off a test that didn't contain the failing case.

**Don't invent patterns.** This thread once presented three defects as one class, citing an already-fixed bug as live evidence. Jason: *"You're making up problems."* If you claim a class, produce a live reproduction of **each** instance.

**Go get the answer.** Jason: *"why is it so hard to get this answer? If you report that youre waiting for an answer more than once, you should just go get that answer."* Reading the crew's own session logs, the courier log, the DB and the deployed bundles found more than asking ever did.

**Check the pipe before blaming the crew.** A wedged courier cost ~10 hours: one hung dispatch blocked the queue and `git log` looked identical to "the crew is slow." Courier health is now the **first** thing every watch tick checks.

**The crew's watchdog can consume the orchestrator.** Twice this week nothing moved because main spent every cycle answering a watchdog re-asking an unchanged question every 15 minutes.

**Don't escalate without checking `is_test`.** This thread called a test-mode payment a real-money incident. Jason: *"calm down. we've never taken real money."*

---

## 8. Standing constraints

- **Never modify the 10DLC registration.** Telnyx brand `BJ8MUGY`, campaign `C8RNN6Y` — now `MNO_PROVISIONED`, T-Mobile registered, number assigned.
- **Stripe test mode is deliberate** until the first real customer. Never flag it as a defect.
- **Never weaken a gate** to make something pass.
- **"Proof" is a product name** — say "acceptance checks". *"Run the proofs"* triggers a 128-case harness run.
- **No LLM grading an LLM.** `proof_score` is deterministic and gates launch; `quality_score` is advisory.
- **Never send Jason to a URL or screen you haven't personally confirmed.**
- **Do not raise key rotation** until Jason says dev is complete. He has asked twice.
- **Do not extract Slice's client API key** from their JS bundle. Not offered as an option without written authorization.
- **PII stays out of `qa_ro`**: `conversations`, `messages`, `orders.customer_phone`, `pickup_name`, `delivery_address`.
- **Notify Jason sparingly.** 61 dispatches carried "Notify Jason you received this" and it became SMS spam on his phone. Notify only for: money wrong in production, a live-path regression on a demo shop, a decision only he can make, or something he asked for being ready.

---

## 9. First things to do

1. `ssh openclaw-air` and check courier health: queued `.msg` count and whether `po-courier.log` has advanced in the last 5 minutes.
2. Run the Vito's canary. If it isn't $9.48, that outranks everything.
3. Read `~/sprintai-ordering/BLOCKED.txt` — the crew's own running state.
4. Push the single-source-of-truth fix. It's the only thing blocking the owner console, and Jason is scheduling a prospect demo.

---

## 10. Keep the thread alive — do this in your first five minutes

Jason walks away and comes back expecting progress. A thread that only acts when spoken to will have done nothing. **Set a recurring watch immediately**, before any other work.

Use `CronCreate`, every 6–12 minutes, recurring. Session-only, so it dies with the thread — re-create it in each new thread. It auto-expires after 7 days.

The prompt must, in this order:

1. **Courier health FIRST.** Count queued `.msg` files and check whether `po-courier.log` has advanced in ~5 minutes. If messages are queued and the log is stale, the job is wedged — `launchctl kickstart -k gui/$(id -u)/ai.openclaw.sprintai.pocourier`. This cost ~10 hours once; it is the single highest-value check.
2. **What landed** — `git log --since="15 minutes ago"` plus `git status --porcelain` for work sitting uncommitted.
3. **Verify by hand, never trust a report.** Vito's canary ($9.48). A regression there outranks everything.
4. **The open list** (§4) — if the crew is idle or a thread finished, dispatch the next item. Blanket approval stands for anything already on the list.
5. **Fix what you can yourself.** If something is broken, reversible, and fixable with the service-role key — a flag, a recompile, a courier kickstart — just do it and say so.
6. **Stay quiet.** Push to Jason's phone only for: money wrong in production, a live-path regression on a demo shop, a decision only he can make, or something he asked for being ready. He has said twice that narration infuriates him.

Also worth knowing: **the Air sleeps.** It slept 00:48–07:30 on 2026-09-10 and nothing ran for six and a half hours — SSH times out and every tick fails. Uptime does not reset, so it looks like a restart and is not. If it recurs, `caffeinate` or a `pmset` change is the fix.
