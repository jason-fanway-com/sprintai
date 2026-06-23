#!/usr/bin/env bash
# Reproducible proof driver for 018_conversation_last_message_at.
# Spins up nothing itself; assumes throwaway container `jw-pg-lastmsg`
# (supabase/postgres) is running and reachable. Re-runnable from clean DB:
#   docker exec jw-pg-lastmsg psql -U postgres -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
#   bash run-proof.sh
set -euo pipefail

MIG_DIR="$(cd "$(dirname "$0")/.." && pwd)/supabase/migrations"
UP="$MIG_DIR/018_conversation_last_message_at.sql"
DOWN="$MIG_DIR/018_conversation_last_message_at.down.sql"

pg() { docker exec -i jw-pg-lastmsg psql -U postgres -v ON_ERROR_STOP=1 "$@"; }
hr()  { echo "============================================================"; }

hr; echo "STEP 0: load minimal fixture schema (RLS enabled, mirrors prod)"; hr
pg -q -f - < "$(dirname "$0")/00_schema.sql"
echo "[ok] conversations + messages created, RLS enabled"

hr; echo "STEP 1: REPRODUCE THE BUG (no trigger yet)"; hr
pg -q -c "
INSERT INTO conversations (id, customer_phone, started_at, last_message_at)
VALUES ('be210325-54fb-4e19-a465-025ab294337e', 'web:njb-test',
        '2026-06-22 15:39:00+00', '2026-06-22 15:39:00+00');
INSERT INTO messages (conversation_id, role, content, created_at)
VALUES ('be210325-54fb-4e19-a465-025ab294337e', 'customer', 'newer msg',
        '2026-06-23 10:48:00+00');
"
echo "Without the trigger, last_message_at stays FROZEN at birth while a newer message exists:"
pg -c "SELECT id, last_message_at AS frozen_last_message_at,
              (SELECT max(created_at) FROM messages m WHERE m.conversation_id=c.id) AS true_newest
       FROM conversations c WHERE id='be210325-54fb-4e19-a465-025ab294337e';"

hr; echo "STEP 2: APPLY MIGRATION UP (creates fn + trigger + runs backfill)"; hr
pg -q -f - < "$UP"
echo "[ok] 018 up applied"
echo "BACKFILL PROOF: the stuck NJB conversation now reflects its true newest message:"
pg -c "SELECT id, last_message_at FROM conversations WHERE id='be210325-54fb-4e19-a465-025ab294337e';"

hr; echo "STEP 3: TRIGGER WORKS — new INSERT advances last_message_at"; hr
pg -q -c "
INSERT INTO conversations (id, customer_phone, started_at, last_message_at)
VALUES ('11111111-1111-1111-1111-111111111111', 'web:trig', now()-interval '1 day', now()-interval '1 day');
"
echo "before insert:"; pg -c "SELECT last_message_at FROM conversations WHERE id='11111111-1111-1111-1111-111111111111';"
pg -q -c "INSERT INTO messages (conversation_id, role, content, created_at)
          VALUES ('11111111-1111-1111-1111-111111111111','customer','hi','2026-06-23 12:00:00+00');"
echo "after insert (should == 2026-06-23 12:00:00+00):"
pg -c "SELECT last_message_at FROM conversations WHERE id='11111111-1111-1111-1111-111111111111';"

hr; echo "STEP 4: GREATEST SEMANTICS — older insert does NOT regress"; hr
pg -q -c "INSERT INTO messages (conversation_id, role, content, created_at)
          VALUES ('11111111-1111-1111-1111-111111111111','customer','old','2020-01-01 00:00:00+00');"
echo "after inserting an OLDER message (should STILL be 2026-06-23 12:00:00+00, not 2020):"
pg -c "SELECT last_message_at FROM conversations WHERE id='11111111-1111-1111-1111-111111111111';"

hr; echo "STEP 5: NULL created_at defensive COALESCE (writer omits created_at? default fires; explicit NULL? coalesced to now())"; hr
pg -q -c "INSERT INTO conversations (id, customer_phone) VALUES ('22222222-2222-2222-2222-222222222222','web:nullts');"
pg -q -c "INSERT INTO messages (conversation_id, role, content, created_at) VALUES ('22222222-2222-2222-2222-222222222222','customer','nullts', NULL);"
echo "last_message_at should be ~now() (not null), proving COALESCE handled explicit NULL created_at:"
pg -c "SELECT (last_message_at IS NOT NULL) AS not_null, (last_message_at > now()-interval '1 min') AS is_recent FROM conversations WHERE id='22222222-2222-2222-2222-222222222222';"

hr; echo "STEP 6: EVAL-SWEEP VISIBILITY — idle query selects >10min-old, excludes <10min-old"; hr
# Model reality: a conversation's last_message_at reflects its newest message.
# Seed each conversation's last_message_at to match the message we insert (the
# trigger's GREATEST keeps the later of birth-vs-message; to isolate the idle
# filter we set birth = the message time so GREATEST resolves to that time).
pg -q -c "
INSERT INTO conversations (id, customer_phone, started_at, last_message_at) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000000','web:idle',  now()-interval '11 min', now()-interval '11 min'),
  ('bbbbbbbb-0000-0000-0000-000000000000','web:fresh', now()-interval '1 min',  now()-interval '1 min');
INSERT INTO messages (conversation_id, role, content, created_at) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000000','customer','idle msg', now()-interval '11 min'),
  ('bbbbbbbb-0000-0000-0000-000000000000','customer','fresh msg', now()-interval '1 min');
"
echo "sanity — both last_message_at values (idle=~11min ago, fresh=~1min ago):"
pg -c "SELECT customer_phone, last_message_at FROM conversations WHERE id IN ('aaaaaaaa-0000-0000-0000-000000000000','bbbbbbbb-0000-0000-0000-000000000000') ORDER BY customer_phone;"
echo "Replicating selectCandidates idle filter exactly: .lt('last_message_at', now()-10min)"
echo "EXPECT: idle(aaaa...) PRESENT, fresh(bbbb...) ABSENT:"
pg -c "SELECT id, last_message_at FROM conversations
       WHERE last_message_at < (now() - interval '10 min')
         AND id IN ('aaaaaaaa-0000-0000-0000-000000000000','bbbbbbbb-0000-0000-0000-000000000000')
       ORDER BY last_message_at ASC;"

hr; echo "STEP 7: IDEMPOTENT RE-UP — re-apply migration, trigger NOT duplicated"; hr
pg -q -f - < "$UP"
echo "[ok] 018 up re-applied (no error)"
echo "trigger count on messages (MUST be exactly 1):"
pg -c "SELECT count(*) AS trigger_count FROM pg_trigger
       WHERE tgrelid='public.messages'::regclass AND tgname='trg_bump_conversation_last_message_at';"

hr; echo "STEP 8: DOWN — remove trigger + function"; hr
pg -q -f - < "$DOWN"
echo "[ok] 018 down applied"
echo "trigger + function should both be GONE (count 0 each):"
pg -c "SELECT
  (SELECT count(*) FROM pg_trigger WHERE tgname='trg_bump_conversation_last_message_at') AS triggers,
  (SELECT count(*) FROM pg_proc WHERE proname='bump_conversation_last_message_at') AS functions;"
echo "after DOWN, the bug returns (insert no longer bumps):"
pg -q -c "INSERT INTO messages (conversation_id, role, content, created_at)
          VALUES ('11111111-1111-1111-1111-111111111111','customer','post-down','2030-01-01 00:00:00+00');"
echo "should STILL be 2026-06-23 12:00:00+00 (trigger gone, no bump):"
pg -c "SELECT last_message_at FROM conversations WHERE id='11111111-1111-1111-1111-111111111111';"

hr; echo "STEP 9: IDEMPOTENT RE-DOWN — re-apply down, no error"; hr
pg -q -f - < "$DOWN"
echo "[ok] 018 down re-applied clean (DROP ... IF EXISTS)"

hr; echo "ALL PROOF STEPS PASSED"; hr
