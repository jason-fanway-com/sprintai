#!/usr/bin/env bash
# rejudge-errored.sh — Re-run the judge over ALL currently errored conversation_evals.
#
# This invokes the eval-sweep edge function with an explicit list of eval IDs
# to overcome the "already-judged" guard. Strategy: POST to eval-sweep with
# parameter mode=rejudge or equivalent.
#
# The eval-sweep normally skips conversations that already have an eval row.
# This script uses the eval-sweep's OWN Supabase client (service_role) to
# delete the errored eval rows, then triggers the sweep to re-judge those
# conversations.
#
# USAGE:
#   bash rejudge-errored.sh
#
# PREREQUISITES:
#   - Service role key available
#   - eval-sweep edge function deployed

set -euo pipefail

SUPABASE_URL="https://rvdqfxtrskxekfkqnegx.supabase.co"
SERVICE_KEY="${SPRINTAI_SERVICE_KEY:-}"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2ZHFmeHRyc2t4ZWtma3FuZWd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDMyMTU5NjgsImV4cCI6MjA1ODc5MTk2OH0.8odntsGsA6O2d7NPiZfJBgT6JTQJoUC6Nn4YcGTqA50"

if [ -z "$SERVICE_KEY" ]; then
  echo "SPRINTAI_SERVICE_KEY not set. Trying to source secrets..."
  if [ -f ~/.openclaw-sprintai/.secrets ]; then
    source ~/.openclaw-sprintai/.secrets
  fi
  if [ -z "$SPRINTAI_SERVICE_KEY" ]; then
    echo "ERROR: SPRINTAI_SERVICE_KEY not available."
    exit 1
  fi
fi

echo "=== Querying errored evals..."
ERRORED_JSON=$(curl -sf "$SUPABASE_URL/rest/v1/conversation_evals?select=id,conversation_id,verdict&verdict=eq.errored" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY")

ERRORED_COUNT=$(echo "$ERRORED_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
echo "Found $ERRORED_COUNT errored evals."

if [ "$ERRORED_COUNT" -eq 0 ]; then
  echo "No errored evals to re-judge. Done."
  exit 0
fi

# Extract conversation_ids
CONV_IDS=$(echo "$ERRORED_JSON" | python3 -c "
import json,sys
rows = json.load(sys.stdin)
ids = set(r['conversation_id'] for r in rows)
print(' '.join(ids))
")

# Extract eval_ids (for deletion tracking)
EVAL_IDS=$(echo "$ERRORED_JSON" | python3 -c "
import json,sys
rows = json.load(sys.stdin)
ids = [r['id'] for r in rows]
print(' '.join(ids))
")

echo "Unique conversations to re-judge: $(echo $CONV_IDS | wc -w)"

# Step 1: Delete errored eval rows so the sweep will re-pickup those conversations.
echo "=== Deleting $ERRORED_COUNT errored eval rows..."
for EVAL_ID in $EVAL_IDS; do
  curl -sf -X DELETE "$SUPABASE_URL/rest/v1/conversation_evals?id=eq.$EVAL_ID" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" > /dev/null
  echo -n "."
done
echo ""

echo "=== Triggering eval-sweep to re-judge conversations..."
# Multiple sweeps may be needed if more than MAX_CONVERSATIONS_PER_SWEEP (50).
# The sweep handles idempotency via (conversation_id, transcript_hash) unique index.
curl -sf -X POST "$SUPABASE_URL/functions/v1/eval-sweep" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -d '{}' > /dev/null

echo ""
echo "=== Done. Wait ~30s for the sweep to complete, then check:"
echo "  curl -s '$SUPABASE_URL/rest/v1/conversation_evals?select=verdict,count&verdict=eq.errored' \\"
echo "    -H 'apikey: \$KEY' -H 'Authorization: Bearer \$KEY' | python3 -m json.tool"
echo ""
echo "Expected result: errored count should drop from $ERRORED_COUNT to near 0."