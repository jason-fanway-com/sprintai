# BUILD-NOTES — fix/conversation-last-message-at

**Branch:** `fix/conversation-last-message-at` (off `origin/main` @ `5fef8b8`)
**Author:** John Walsh (builder)
**Status:** committed locally. NOT merged / NOT pushed / NOT deployed. Migration applied LOCALLY ONLY (throwaway docker pg). Lead applies 018 remotely.

---

## The bug

`conversations.last_message_at` is set ONCE at conversation creation
(`001_initial_schema.sql`: `last_message_at TIMESTAMPTZ DEFAULT NOW()`) and is
**never updated afterward**.

- `chat-sms` (`supabase/functions/chat-sms/index.ts`) writes messages via
  `saveMessage()` (defined ~L1050; called at L1203, 1520, 1521, 1529, 1530,
  1544, 1545, 1558, 1559, 1572, 1573, 1618, 1619, 1642, 1735). Its only
  `conversations` writes are `select`/`insert` (L1137 select; L1448/1452 select;
  L1464 insert). **No `UPDATE` of `last_message_at` anywhere.**
- No DB trigger did it either (`pg_trigger` on messages/conversations was empty).

The judge (`supabase/functions/eval-sweep/index.ts`, `selectCandidates`, L320)
filters idle conversations with `.lt("last_message_at", idleCutoff)` (L329) and
**orders** by it (L330). A frozen `last_message_at` makes the judge mis-see
recency: an actively-messaged conversation looks "idle since creation," and a
conversation whose newest message is recent can wrongly appear old (or vice
versa).

**Confirmed real case:** NJB conversation
`be210325-54fb-4e19-a465-025ab294337e` had `last_message_at` frozen at
`2026-06-22 15:39` while its newest message was `2026-06-23 10:48` (~19h newer,
14 messages) and was never judged.

---

## The fix — DB trigger + one-time backfill (migration 018)

**Files:**
- `supabase/migrations/018_conversation_last_message_at.sql` (up)
- `supabase/migrations/018_conversation_last_message_at.down.sql` (down)

**What it does:**
1. **Function** `public.bump_conversation_last_message_at()` — `plpgsql`,
   `SECURITY DEFINER`, `SET search_path = ''`. On each inserted message it runs:
   `UPDATE conversations SET last_message_at = GREATEST(COALESCE(existing, NEW.created_at, now()), COALESCE(NEW.created_at, now())) WHERE id = NEW.conversation_id;`
2. **Trigger** `trg_bump_conversation_last_message_at` — `AFTER INSERT ON messages FOR EACH ROW`. Guarded with `DROP TRIGGER IF EXISTS` first → idempotent.
3. **Backfill** (one-time, in the same migration):
   ```sql
   UPDATE public.conversations c
      SET last_message_at = sub.mx
     FROM (SELECT conversation_id, MAX(created_at) AS mx FROM public.messages GROUP BY conversation_id) sub
    WHERE sub.conversation_id = c.id
      AND (c.last_message_at IS NULL OR c.last_message_at < sub.mx);
   ```
   This immediately repairs all stuck rows (incl. `be210325…`) so they become judge-visible.

**Down:** drops the trigger + function (both `IF EXISTS`, idempotent). The
**backfill is intentionally NOT reversed** — once a stale timestamp is corrected
to its true newest-message time there is no faithful "wrong old value" to
restore, and restoring staleness would be undesirable. Documented in both files.

### Trigger SEMANTICS chosen: GREATEST (monotonic, never regresses) — and why

I chose `last_message_at = GREATEST(existing, NEW.created_at)` rather than a
blind `= NEW.created_at`.

**Why:** messages can be inserted **out of order**. The web/iMessage bridge path
can replay an older session's messages onto an existing conversation row (see the
reuse finding below). With a blind assignment, an out-of-order/older insert would
drag `last_message_at` BACKWARDS and re-hide a genuinely recent conversation from
the judge — reintroducing a variant of the same bug. `GREATEST` makes the field
strictly monotonic: it only ever advances to the newest message the conversation
has ever seen, which is the correct meaning of "last message at." `COALESCE(...,
now())` guards the (unexpected) case of an explicit `NULL` `created_at`.

### Decision: TRIGGER ALONE — do NOT also patch chat-sms

I rely **solely on the trigger** and did **not** add a redundant `UPDATE` in
chat-sms. Reasons:
1. **Single source of truth.** One mechanism, one place to reason about. A
   redundant app-side update could disagree with the trigger (e.g., different
   semantics) and is dead weight once the trigger exists.
2. **Covers ALL writers, present and future.** SMS path, web path, the
   `web:imsg-` bridge path, and anything added later all insert into `messages`;
   the trigger bumps recency for every one of them with zero per-writer code.
3. **Keeps the sacred order-path file provably untouched.** `chat-sms` is the
   order path. Not editing it means the order flow is byte-for-byte unchanged
   (proven below) — no risk of regressing ordering to fix a judge-visibility bug.

---

## Reuse-window finding (INVESTIGATE + FLAG — not fixed here)

**Where:** `chat-sms/index.ts` L1442–1458 ("Find or create conversation").

```ts
const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
if (channel === "web") {
  // matches by session_id only — NO time window applied
  .from("conversations").select("id").eq("session_id", sessionId).eq("channel","web").single();
} else { // sms
  .eq(...customer_phone...).eq("status","active").gte("started_at", windowStart)... // 24h window
}
```

**Finding — two distinct issues:**

1. **The web reuse path has NO time window at all.** `windowStart` (24h) is
   computed but applied ONLY to the SMS branch. The web branch reuses a
   conversation row whenever the same `session_id` reappears, **forever**. So a
   long-lived/replayed web (or `web:imsg-` bridge) session keeps welding new
   messages onto one original conversation row indefinitely. This is exactly how
   the NJB test welded 14 messages spanning **two different days** onto a single
   day-old conversation row.

2. **Welding multi-day sessions onto one row distorts the judge's unit of work.**
   The judge treats a "conversation" as one row + its transcript. When days of
   activity collapse into one row:
   - `started_at` no longer bounds the conversation's real duration.
   - Before this fix, `last_message_at` was frozen → invisible to the judge.
   - After this fix it's correct, but the transcript the judge reads may be an
     amalgam of separable sessions (e.g., two unrelated order attempts on
     different days judged as one), which can muddy a per-conversation verdict.

**Recommendation (for the LEAD to decide — do NOT change reuse here, it touches
the order path):**
- Apply a bounded freshness window to the **web** reuse the same way SMS already
  bounds its lookup (e.g., only reuse a web conversation whose
  `last_message_at`/`started_at` is within N hours; otherwise start a fresh
  conversation row). This naturally segments multi-day activity into distinct
  conversations and gives the judge a clean unit.
- Consider keying the judge's "conversation" on a session/day boundary rather
  than the raw row if business reasons require keeping one row per `session_id`.
- Either change affects how `chat-sms` resolves conversations on the order path,
  so it must go through its own spec + pre-mortem + Melvin, separate from this
  fix. **Flagged, not touched.**

This fix (correct `last_message_at`) is orthogonal and safe regardless of how the
reuse question is decided: it makes recency accurate for whatever rows exist.

---

## PROOF (`proof-last-message-at/`)

Run against a throwaway `supabase/postgres:15.8.1.060` docker container
(`jw-pg-lastmsg`, PostgreSQL 15.8), RLS enabled on both tables to mirror prod.

- `00_schema.sql` — minimal fixture (conversations + messages, exact relevant
  columns from `001_initial_schema.sql`, RLS enabled).
- `run-proof.sh` — reproducible driver (re-runnable from a clean schema).
- `proof-output.log` — captured output of a full green run.
- `order-path-unchanged.txt` — order-path byte-identity evidence.

**Steps proven (all green — see `proof-output.log`):**
1. **Bug reproduced** — pre-trigger, a conversation born 15:39 with a 10:48-next-day message keeps `last_message_at` frozen at 15:39.
2. **Migration UP + BACKFILL** — after `018` up, the stuck NJB row advances to its true newest message `2026-06-23 10:48`.
3. **Trigger works** — a fresh INSERT advances `last_message_at` to the message's `created_at`.
4. **GREATEST semantics** — a subsequently inserted OLDER message does NOT regress `last_message_at` (stays at the newest).
5. **NULL `created_at` defensive** — explicit `NULL` created_at → `last_message_at` is non-null and ~`now()` (COALESCE worked).
6. **eval-sweep visibility** — replicating `selectCandidates`' exact idle filter (`last_message_at < now()-10min`): an 11-min-idle conversation IS selected; a 1-min-fresh one is NOT. (Note: the conversation's `last_message_at` must be seeded to the message time — GREATEST keeps the later of birth-vs-message; this models reality where a row's recency equals its newest message.)
7. **Idempotent RE-UP** — re-applying `018` up succeeds and the trigger count on `messages` stays exactly **1** (not duplicated).
8. **DOWN** — trigger + function both removed (counts 0/0); a post-down insert no longer bumps (bug returns, proving the trigger was the mechanism).
9. **Idempotent RE-DOWN** — re-applying down is clean (`DROP ... IF EXISTS`).

**Order path BYTE-UNCHANGED** (`order-path-unchanged.txt`): `git diff origin/main`
is EMPTY and md5 IDENTICAL vs `origin/main` for:
`chat-sms/index.ts`, `create-checkout/index.ts`, `refund-order/index.ts`,
`stripe-webhook/index.ts`, `toast-order/index.ts`, `scripts/imsg-bridge.sh`.

**Secret-safety:** secret-pattern grep over the two new migration files and the
proof dir → **0 real secrets**. (The string `throwaway` in `run-proof.sh` is a
disposable LOCAL docker password for the ephemeral proof container, not a
project secret; the container is deleted after proof.)

---

## LEAD: exact remote-apply step

Apply `018` to the remote DB the same way prior migrations are applied. The
migration is additive/idempotent and self-contained (function + trigger +
backfill); no out-of-band secret is required (unlike 017).

```bash
# from repo root, against the linked Supabase project:
supabase db push
# — or, if applying the single file directly via psql against the prod connection string:
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/018_conversation_last_message_at.sql
```

Re-running is safe (idempotent trigger; backfill only advances stale rows).
Rollback (trigger/function only; backfill is permanent and intended):
```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/018_conversation_last_message_at.down.sql
```

After apply, the judge's idle query immediately sees true recency, and the stuck
NJB conversation (`be210325-54fb-4e19-a465-025ab294337e`) becomes judge-visible.

---

## How to reproduce the proof locally

```bash
docker run -d --name jw-pg-lastmsg -e POSTGRES_PASSWORD=throwaway -p 55438:5432 supabase/postgres:15.8.1.060
# wait for ready
docker exec jw-pg-lastmsg psql -U postgres -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
bash proof-last-message-at/run-proof.sh
docker rm -f jw-pg-lastmsg   # cleanup
```
