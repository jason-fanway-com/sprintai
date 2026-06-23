-- SprintAI — Keep conversations.last_message_at CORRECT on every message write.
--
-- WHY THIS EXISTS (the bug):
--   conversations.last_message_at is set ONCE, at conversation creation
--   (001_initial_schema.sql: DEFAULT NOW()), and then NEVER updated. chat-sms
--   (supabase/functions/chat-sms/index.ts) writes messages via saveMessage()
--   but its only conversations writes are select/insert (lines ~1137, ~1448,
--   ~1452, ~1464) — there is no UPDATE of last_message_at anywhere, and no DB
--   trigger did it either. So an actively-messaged conversation keeps the
--   timestamp it was born with and looks "idle since creation."
--
--   The conversation judge (supabase/functions/eval-sweep/index.ts,
--   selectCandidates) filters idle conversations with
--       .lt("last_message_at", idleCutoff)
--   and ORDERS by last_message_at. A frozen last_message_at therefore makes the
--   judge mis-see recency: a real NJB conversation
--   (be210325-54fb-4e19-a465-025ab294337e) had last_message_at frozen at
--   2026-06-22 15:39 while its newest message was 2026-06-23 10:48 (~19h newer,
--   14 messages) and was never judged.
--
-- THE FIX — a DATABASE TRIGGER, not app code (single source of truth):
--   last_message_at must be right no matter WHICH path writes a message: the
--   chat-sms SMS path, the web path, the web:imsg- bridge path, and any future
--   writer. The robust, path-independent place to keep it correct is the
--   database itself. An AFTER INSERT trigger on `messages` bumps the parent
--   conversation. This deliberately AVOIDS editing the sacred order-path file
--   (chat-sms) — that file is left byte-for-byte unchanged so the order flow is
--   provably untouched. (See BUILD-NOTES-last-message-at.md for the explicit
--   "trigger-only, do not also patch chat-sms" decision and rationale.)
--
-- SEMANTICS — GREATEST (monotonic, never regresses):
--   The trigger sets last_message_at = GREATEST(existing, NEW.created_at). We do
--   NOT blindly assign NEW.created_at, because messages can be inserted
--   out-of-order (e.g. the imsg bridge replaying an older session onto an
--   existing conversation row). With GREATEST, an out-of-order/older insert can
--   never drag a conversation's recency BACKWARDS — it only ever advances. This
--   is the correct meaning of "last message at": the time of the newest message
--   the conversation has ever seen. NEW.created_at defaults to now() at the row
--   level (messages.created_at DEFAULT NOW()), but we COALESCE to now() defensively
--   in case a writer ever inserts an explicit NULL.
--
-- ADDITIVE / IDEMPOTENT / REVERSIBLE.
--   * Creates ONE function + ONE trigger; touches no column definitions.
--   * CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS make re-running clean:
--     re-applying does NOT stack a second trigger (proven in proof-last-message-at/).
--   * One-time BACKFILL (below) repairs already-stuck rows. The backfill is the
--     only non-reversible part, and that is expected and documented (the .down
--     cannot un-correct a corrected timestamp, nor should it).
--   * Reverse the trigger+function with 018_conversation_last_message_at.down.sql.
--
-- SECURITY:
--   RLS is enabled on both conversations and messages (001_initial_schema.sql).
--   Edge functions write with the service role (which bypasses RLS), so in the
--   live path the UPDATE would already be permitted. We nonetheless mark the
--   function SECURITY DEFINER with a pinned, empty search_path so the bump is
--   guaranteed to succeed under ANY writer/role and is immune to search_path
--   hijacking. The function does exactly ONE thing — advance last_message_at on
--   the parent conversation — and touches no other table, no customer content,
--   and crosses no tenant boundary (it updates only the conversation the message
--   already belongs to via NEW.conversation_id).
--
-- NO SECRETS in this file.

-- ── 1. Trigger function ───────────────────────────────────────────────────────
-- AFTER INSERT ON messages: advance the parent conversation's last_message_at to
-- the newest message time it has ever seen (monotonic via GREATEST).
CREATE OR REPLACE FUNCTION public.bump_conversation_last_message_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  UPDATE public.conversations AS c
     SET last_message_at = GREATEST(
           COALESCE(c.last_message_at, NEW.created_at, now()),
           COALESCE(NEW.created_at, now())
         )
   WHERE c.id = NEW.conversation_id;
  RETURN NULL;  -- AFTER trigger: return value is ignored.
END;
$fn$;

-- ── 2. Trigger ────────────────────────────────────────────────────────────────
-- Idempotent: drop any prior same-named trigger first, then (re)create. Re-running
-- the migration therefore never produces a duplicate trigger.
DROP TRIGGER IF EXISTS trg_bump_conversation_last_message_at ON public.messages;

CREATE TRIGGER trg_bump_conversation_last_message_at
AFTER INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION public.bump_conversation_last_message_at();

-- ── 3. One-time BACKFILL (NOT reversible — see header) ─────────────────────────
-- Repair conversations whose last_message_at is stale relative to their newest
-- message. After this, already-stuck rows (incl. be210325-54fb-4e19-a465-
-- 025ab294337e) immediately reflect their true newest message and become
-- judge-visible. Only advances (never regresses): the predicate requires the
-- stored value be NULL or strictly older than the true max(created_at).
UPDATE public.conversations AS c
   SET last_message_at = sub.mx
  FROM (
    SELECT conversation_id, MAX(created_at) AS mx
      FROM public.messages
     GROUP BY conversation_id
  ) AS sub
 WHERE sub.conversation_id = c.id
   AND (c.last_message_at IS NULL OR c.last_message_at < sub.mx);
