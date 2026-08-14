#!/usr/bin/env bash
# backfill-issues.sh — Invoke the issue-detector to process the current backlog
# of flagged conversation_evals into tracked issues.
#
# PREREQUISITES:
#   1. issue-detector edge function must be deployed (currently NOT deployed).
#      To deploy: `supabase functions deploy issue-detector`
#   2. Migration 047_issue_detector_schedule.sql must be applied for the cron job.
#      Apply: `supabase db push` (auto-applies pending migrations)
#      Or manually via SQL: copy-paste 047 contents to Supabase SQL editor.
#   3. Vault secret 'issue_detector_auth' must exist with the service_role JWT.
#
# WHAT THIS DOES:
#   Posts to issue-detector, which runs detection rules across all eval data
#   (not just recent). The detector dedupes by (detection_rule, tenant_id,
#   conversation_id) so multiple invocations are safe/idempotent.
#
# DM SAFETY:
#   issue-detector does NOT send Telegram DMs. It only writes to the `issues`
#   table and sets notified_at on the source eval. No DM flood.

set -euo pipefail

SUPABASE_URL="https://rvdqfxtrskxekfkqnegx.supabase.co"
SERVICE_KEY="${SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY:-}"

if [ -z "$SERVICE_KEY" ]; then
  if [ -f ~/.openclaw-sprintai/.secrets ]; then
    source ~/.openclaw-sprintai/.secrets
  fi
  if [ -z "$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" ]; then
    echo "ERROR: SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY not set"
    exit 1
  fi
fi

echo "=== Before state ==="
curl -s "$SUPABASE_URL/rest/v1/issues?select=count&status=eq.open" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY"

echo ""
echo "=== Invoking issue-detector ==="
RESULT=$(curl -s -X POST "$SUPABASE_URL/functions/v1/issue-detector" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -d '{"backfill": true}')

echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"

echo ""
echo "=== After state ==="
curl -s "$SUPABASE_URL/rest/v1/issues?select=count&status=eq.open" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY"
echo ""

echo ""
echo "=== Verify: ZERO flagged critical/major with notified_at but no issue ==="
curl -s "$SUPABASE_URL/rest/v1/rpc/get_orphaned_notifications" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
  -X POST 2>&1 | python3 -m json.tool 2>/dev/null || \
echo "(Note: get_orphaned_notifications RPC may not exist yet — use the manual query below)"

echo ""
echo "Manual proof query (run after backfill):"
cat <<'EOF'
SELECT ce.id, ce.max_severity, ce.notified_at
FROM conversation_evals ce
LEFT JOIN issues i ON i.eval_id = ce.id
WHERE ce.verdict = 'flagged'
  AND ce.max_severity IN ('critical', 'major')
  AND ce.notified_at IS NOT NULL
  AND i.id IS NULL;
-- Expected: 0 rows.
EOF