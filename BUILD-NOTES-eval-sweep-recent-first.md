# BUILD NOTES — fix/eval-sweep-recent-first

**Branch:** `fix/eval-sweep-recent-first` (off `origin/main` @ `e9d5351`)
**Scope:** `supabase/functions/eval-sweep/index.ts` (function `selectCandidates` only) + proof files.
**Order path:** BYTE-UNCHANGED (md5 verified before == after; git diff empty for all 6 files).

---

## The bug (confirmed against prod data)

`selectCandidates()` builds the per-sweep candidate set from two sources:

1. **Idle query** — `conversations` with `last_message_at < idleCutoff`, ordered
   `last_message_at ASC, id ASC`, `LIMIT cap*3` (= 150 at the prod cap of 50).
2. **Terminal-cart force-include** — `order_carts` with `phase IN ('confirmed','expired')`.

Because the idle query ordered **oldest-first** and capped at `cap*3`, only the
**oldest 150** idle conversations ever entered the set. A freshly-active idle
conversation (newest `last_message_at`) sorts to the END and falls OUTSIDE the
150 window whenever there are >150 older idle rows.

Observed: real NJB test conversation `be210325-54fb-4e19-a465-025ab294337e`
(phase=checkout, cart on shop `b0000000-0000-0000-0000-000000000001`) ranked
#188 of 188 idle-unjudged → never selected → manual sweeps returned
`judged=0 / skipped_unchanged=12`. An operator running a fresh test could not get
it judged.

Compounding: the terminal force-include did NOT list `checkout`, so a cart that
reached the Stripe checkout seam (a real, high-signal order attempt) was not
force-included either.

---

## The fix (two surgical changes, both in `selectCandidates`)

### Exact lines changed

1. **Idle query order — oldest-first → newest-first** (idle `.order(...)` block):
   - `- .order("last_message_at", { ascending: true })`
   - `+ .order("last_message_at", { ascending: false })`
   - `.order("id", { ascending: true })` tiebreaker KEPT (determinism).
   - `.limit(MAX_CONVERSATIONS_PER_SWEEP * 3)` KEPT.
   - Final `.slice(0, MAX_CONVERSATIONS_PER_SWEEP)` KEPT.

2. **Terminal-phase force-include — add `checkout`**:
   - `- .in("phase", ["confirmed", "expired"])`
   - `+ .in("phase", ["confirmed", "expired", "checkout"])`

Plus comment/header updates documenting the new effective ordering. No other
logic touched: cap, idle threshold (`IDLE_MINUTES`), transcript-hash dedup, spend
ceiling, cart-bearing partition, and chunking are all unchanged.

### `checkout` is a real phase

`OrderPhase` (chat-sms `index.ts` L76) =
`"greeting" | "building" | "review" | "checkout" | "payment" | "confirmed" | "expired"`.
chat-sms sets `phase: "checkout"` at L635 when a checkout session is created.
Terminal/high-value set kept to `confirmed` (settled), `expired` (settled), and
`checkout` (the order ATTEMPT we most want graded). `payment`/`review`/`building`
are transient mid-flow states and were intentionally NOT added (no over-broadening).

---

## Effective ordering (composes with the existing cart-bearing partition)

The downstream stable partition (cart-bearing first, then cart-less, each in
existing relative order) is UNCHANGED. The idle results now arrive newest-first,
terminal-cart conversations append after (Map insertion order), then the
partition runs. Net effective order, within the same cap:

1. **Cart-bearing (shop-resolvable) conversations FIRST**, then cart-less — *existing behavior*.
2. **WITHIN each group, NEWEST-active first** — *new behavior*.

This is deterministic: stable partition + `id ASC` tiebreaker on the idle sort;
no non-deterministic comparator. Proof confirms NEW == NEW2.

---

## Pre-mortem

**Risk 1 — newest-first starves the OLDEST unjudged conversations.**
Under newest-first, the oldest idle rows now sort last and, when there are >150
idle rows, may not enter a given sweep's window.
*Assessment: acceptable.* (a) The auto-timer runs every 5 min; transcript-hash
dedup means once a conversation is judged it is skipped forever (unless its
transcript changes), so the working set of UNJUDGED conversations shrinks over
time rather than growing. (b) Old, never-judged rows are overwhelmingly stale
test data — low value. (c) The highest-value targets (what an operator/diner
just did) are exactly the newest ones, which the old code could never reach.
*Genuine-starvation case:* a single very-old, important, never-judged
conversation that sits behind a perpetually-refreshed backlog of >150 newer idle
rows. In practice the dedup-shrinking working set makes a permanent >150 unjudged
backlog unlikely at current scale. **Follow-up (NOT built now):** if a real
backlog ever forms, add an occasional age-based backfill pass (e.g., reserve a
few slots per sweep for oldest-unjudged). Flagged, not implemented — keeping this
change minimal.

**Risk 2 — including `checkout` pulls in not-yet-finished carts mid-conversation.**
A `checkout`-phase cart can still be reverted to `building` by the diner.
*Mitigation:* judging a `checkout`-phase conversation is INTENDED — it is the
order attempt we most want graded. It is still gated by transcript-hash dedup, so
it is re-judged only when its transcript actually changes (i.e., once per stable
state, not on every sweep). Cost is bounded by the unchanged per-sweep cap and the
daily spend ceiling. No spend or correctness regression.

---

## Proof (`proof-eval-sweep-recent-first/`)

- `replicate-select.ts` — faithful local replication of the selection
  ordering/inclusion (idle filter+sort+limit → terminal force-include → Map base
  order → cart-bearing stable partition → cap), run BOTH ways over one fixture of
  201 conversations (200 old idle + 1 fresh checkout = be210325).
- `replicate-select.out.txt` — captured output. Results:
  - OLD (oldest-first, `confirmed,expired`): newest **NOT selected** (bug reproduced).
  - NEW (newest-first, `confirmed,expired,checkout`): newest **SELECTED at position 0** (front).
  - Cap honored (50 ≤ 50) both ways.
  - Determinism: NEW == NEW2 → PASS.
  - Checkout force-include when NOT idle: a checkout cart active 1 min ago is
    EXCLUDED under OLD, INCLUDED under NEW → PASS.
  - `ALL CHECKS: PASS ✅`
- `orderpath-md5-before.txt` / `orderpath-md5-after.txt` — identical (order path byte-unchanged).

Run: `deno run proof-eval-sweep-recent-first/replicate-select.ts`

### deno check
- My branch: `deno check supabase/functions/eval-sweep/index.ts` → clean.
- Baseline (origin/main, in-place worktree): also clean. **No NEW errors.**
  (Note: checking the file copied to `/tmp` fails only due to unresolved relative
  `../_shared` imports — a path artifact, not a code error.)

### Hard gates
- Order path (chat-sms, create-checkout, refund-order, stripe-webhook,
  toast-order, imsg-bridge.sh): `git diff origin/main` EMPTY + md5 identical.
- Only `eval-sweep/index.ts` + proof/BUILD-NOTES files changed.
- No secrets in diff.
- NOT merged, NOT pushed, NOT deployed.

---

## Lead deploy step

Redeploy the eval-sweep function:

```
supabase functions deploy eval-sweep
```

No migration, no env change, no order-path redeploy required.
