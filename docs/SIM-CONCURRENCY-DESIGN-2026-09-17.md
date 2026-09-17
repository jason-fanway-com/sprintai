# Concurrent sim runs — design note

**For the incoming PO thread. Written 2026-09-17 by the outgoing laptop session.**
Goal: run the adversarial sim suite in minutes instead of hours, without the speed
corrupting the results. Companion to `PO-HANDOFF-2026-09-17-0550.md` §2.

---

## 1. Why this is not an agent-swarm problem

The instinct is "spin up 50 agents." Don't. A simulated conversation is a script making
about 16 HTTP calls in sequence, each one blocked waiting on a model to answer. It is
**I/O-bound, not reasoning-bound.** There is no judgement happening in the loop that needs
an agent — the customer's next line comes from one model call, and the judging is
deterministic arithmetic against the cart.

Fifty agents would mean fifty supervising LLMs, fifty times the cost, and a new failure
surface (agents mis-driving the harness) to debug on top of the one we are trying to
measure. A worker pool inside the existing process gets the same wall-clock win for free
and keeps the harness a single auditable script.

**Use threads or asyncio in `simcustomer.py`. One process, N conversations in flight.**

## 2. Why it parallelises cleanly

Each conversation is already fully independent:

- its own `public-tester` session id
- its own `conversation_id` and `order_carts` row
- no shared mutable state except the results collector

Nothing in a conversation reads another conversation's state. The only shared resources are
the remote services, which is §4.

Measured baseline: ~1.05 min per conversation sequential; 500 took just over 9 hours.

| concurrency | 500 conversations | notes |
|---|---|---|
| 1 | ~9 h | today's baseline |
| 4 | ~2.2 h | very low contention risk |
| 10 | ~55 min | plausible sweet spot |
| 20 | ~28 min | needs validation per §5 |
| 50 | ~11 min | likely rate-limited before this |

Cost does not change with concurrency — same conversations, same tokens, ~$0.0131 each.
You are compressing clock time, not buying more.

## 3. Fix the suite before you speed it up

**This matters more than the concurrency work and is cheaper.**

Today personas and goals are chosen with `random.sample` / random menu picks. That means
two runs are never the same suite, so a before/after comparison confounds "did the fix
work" with "did we happen to draw harder conversations."

Make the suite **seeded and reproducible**:

- take a `--seed` argument; derive persona assignment and goal selection from it
- write the seed into `run_meta.json` alongside the deployed sha
- a run is then identified by `(seed, N, deployed_sha)` and is exactly repeatable

Then a fix is measured by running **the identical suite** before and after. Any difference
in the failure map is the fix, not the draw. Without this, concurrency just gets you to the
wrong answer faster.

## 4. What actually limits concurrency

Check each before choosing a number — do not assume:

- **`public-tester` rate limits.** Per-IP and per-browser limits were removed and the global
  daily cap was raised to 1000, but 500 conversations is ~8,000 turns. Confirm whether the
  cap counts sessions or turns before a large run.
- **OpenRouter account concurrency.** Two callers now share the key: the simulated customer
  (`openai/gpt-4o-mini`) and the ordering bot (`deepseek-v4-flash`). Both scale with N.
- **Supabase edge function concurrency** for `chat-sms` invocations.
- **PostgREST reads.** The harness reads the cart row every turn for telemetry; at N=20
  that is 20 concurrent reads per turn-tick.

Backoff: exponential retry on 429 and 5xx, and **count retries separately in the manifest**.
A run that needed 200 retries is telling you something about the concurrency level, not
about the product.

## 5. The contamination problem — the core design risk

Under load, timeouts and 5xx look exactly like product defects. A conversation that stalls
because an edge function was throttled scores as BOT STALL. A polluted map is worse than a
slow one, because it sends the next PO chasing a bug that does not exist.

Three defences, all required:

**a. Separate transport failure from product defect.** Record the HTTP status and latency of
every turn (latency is already recorded). A turn that returned non-200, timed out, or was
retried is a **transport event**, not a defect, and must be excluded from the property
counts and reported on its own line.

**b. Stamp the concurrency level on every conversation** and put it in `run_meta.json`. A
failure signature that only ever appears at high N is an artifact.

**c. The calibration protocol — do this once, properly:**

1. Pick a seed and a modest N (100 is enough).
2. Run it at concurrency 1. This is the truth baseline.
3. Run the **same seed** at concurrency 4, 10, 20.
4. Diff the failure maps against the concurrency-1 baseline.
5. The highest concurrency whose map matches the baseline is your standing setting. Back off
   one step from where divergence starts.

Record the result in `simruns/CONCURRENCY-CALIBRATION.md` so nobody re-derives it. Re-run
the calibration if the infrastructure changes — a Supabase plan change, a model swap, a new
shop with a much larger menu.

## 6. What does not change

- `require-current-deploy.sh` still gates every run. No override. Concurrency is not a reason
  to test a stale build.
- Results still land in `~/po-scratch/simruns/<ts>/`, still stamped with the **deployed sha
  read off the artifact**, still appended to `INDEX.tsv`.
- Cost is still the **measured OpenRouter credits delta**, never token arithmetic, still with
  the whole-account caveat stated. Note that at high concurrency the window is shorter, which
  makes the whole-account caveat *less* dangerous, not more.
- Still launched detached with `nohup` so it survives the session.

## 7. The real prize: an onboarding gate

Jason's stated goal is to run this every time a shop is onboarded. That changes the
requirements in two ways:

- **It must be fast enough to sit in a workflow** — minutes, not hours. That is what this
  design buys.
- **It must be a gate with a verdict, not a report.** Define which properties are blocking
  (a cart containing something the customer never asked for; a price that does not match the
  menu) and which are advisory (an extra clarifying question). A new shop's menu brings new
  collisions and new phrasings; this is the thing that would catch them before a real
  customer does.

That also argues for a **per-shop seeded suite**: the same conversations for every shop,
plus goals drawn from that shop's own menu, so results are comparable across shops.

## 8. Suggested order of work

1. Seeded, reproducible suite (§3). Cheapest, highest value, unblocks all comparison.
2. Transport-failure separation (§5a). Without it, concurrency results cannot be trusted.
3. Worker pool with configurable concurrency, default 1 until calibrated.
4. Calibration run (§5c). Record the answer.
5. Only then raise the default.

**Do not skip 1 and 2 to get to 3.** A fast harness that cannot tell a timeout from a defect
will cost more time than it saves — that is the same mistake as the single-turn matrix that
certified a bot which could not complete an order.
