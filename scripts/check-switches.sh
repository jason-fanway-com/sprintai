#!/bin/bash
# check-switches.sh — print every flag the ordering path reads, per shop.
#
# A feature can be built, deployed, and switched off, invisibly, for days
# (compiled_ordering_engine_enabled sat false on Not Just Bagels with zero
# signal anywhere that it was off). Run this before claiming anything is
# "live" for a shop.
#
# Requires SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY in the environment
# (source ~/.openclaw-sprintai/.secrets first).

set -euo pipefail

if [ -z "${SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "FAIL: SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY not set. source ~/.openclaw-sprintai/.secrets first." >&2
  exit 1
fi

SUPABASE_URL="https://rvdqfxtrskxekfkqnegx.supabase.co"

# The three real, live shops. This is deliberately not "every shop" — the
# project has dozens of throwaway QA/debug/E2E shops accumulated over time,
# and a switches report that buries Vito's/Zio's/NJB in that noise defeats
# the point of a quick pre-flight check.
REAL_SHOPS='e0000000-0000-0000-0000-000000000001,2cba7b51-211c-4437-8910-1af4dcc03498,b0000000-0000-0000-0000-000000000001'

echo "== compiled_ordering_engine_enabled, the three real shops (live DB read) =="
curl -s "${SUPABASE_URL}/rest/v1/shops?id=in.(${REAL_SHOPS})&select=id,name,compiled_ordering_engine_enabled&order=name" \
  -H "apikey: ${SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY}" \
  | python3 -c "
import json, sys
rows = json.load(sys.stdin)
for r in rows:
    flag = r['compiled_ordering_engine_enabled']
    print(f\"  {r['name']:<20} {r['id']}  compiled_ordering_engine_enabled = {flag}\")
"

echo ""
echo "== CHAT_MODEL: local source default vs live deployed artifact default =="
LOCAL_DEFAULT=$(grep -o 'Deno.env.get("CHAT_MODEL") ?? "[^"]*"' supabase/functions/chat-sms/index.ts | grep -o '"[^"]*"$' | tr -d '"')
echo "  local index.ts fallback:      ${LOCAL_DEFAULT:-<not found>}"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
( cd "$TMPDIR" && supabase functions download chat-sms --project-ref rvdqfxtrskxekfkqnegx >/dev/null 2>&1 )
DEPLOYED_ENTRYPOINT="${TMPDIR}/supabase/functions/chat-sms/index.ts"
if [ -f "$DEPLOYED_ENTRYPOINT" ]; then
  DEPLOYED_DEFAULT=$(grep -o 'Deno.env.get("CHAT_MODEL") ?? "[^"]*"' "$DEPLOYED_ENTRYPOINT" | grep -o '"[^"]*"$' | tr -d '"')
  echo "  live deployed artifact fallback: ${DEPLOYED_DEFAULT:-<not found>}"
  if [ "$LOCAL_DEFAULT" != "$DEPLOYED_DEFAULT" ]; then
    echo "  MISMATCH: working tree and live artifact disagree on the fallback default — someone deployed from a different tree than HEAD."
  fi
else
  echo "  could not download the live artifact to check"
fi

CHAT_MODEL_SECRET_STATUS=$(supabase secrets list 2>/dev/null | grep -c "CHAT_MODEL" || true)
if [ "$CHAT_MODEL_SECRET_STATUS" -gt 0 ]; then
  echo "  CHAT_MODEL secret: SET (Supabase only exposes a digest, not the value — cross-check against the deploy log/commit history for what it was set to, or check the dashboard directly. This script cannot read the live runtime value without a live call.)"
else
  echo "  CHAT_MODEL secret: NOT SET — every shop's chat-sms is running the fallback default above."
fi

echo ""
echo "Done. Re-run this before claiming any flag-gated feature is live for a shop."
