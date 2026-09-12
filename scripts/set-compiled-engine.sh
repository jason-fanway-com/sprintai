#!/bin/bash
# set-compiled-engine.sh — the only documented way to flip compiled_ordering_engine_enabled.
#
# Context: this flag was flipped on Vito's via REST on 2026-09-11 without a
# commit. That was the root cause of four "committed, deployed, no effect"
# incidents in a row — any flag change that is not in version control is
# invisible until someone runs check-switches.sh. Use this script. It writes
# to the DB AND emits a git-committable record so the flag change is auditable.
#
# Usage: ./scripts/set-compiled-engine.sh <shop_name_slug> <true|false>
# Example: ./scripts/set-compiled-engine.sh vitos true
#
# Supported slugs: njb, vitos, zios

set -euo pipefail

if [ -z "${SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "FAIL: SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY not set. source ~/.openclaw/.secrets first." >&2
  exit 1
fi

SLUG="${1:-}"
VALUE="${2:-}"

if [ -z "$SLUG" ] || [ -z "$VALUE" ]; then
  echo "Usage: $0 <njb|vitos|zios> <true|false>" >&2
  exit 1
fi

if [ "$VALUE" != "true" ] && [ "$VALUE" != "false" ]; then
  echo "FAIL: value must be 'true' or 'false', got '${VALUE}'" >&2
  exit 1
fi

SUPABASE_URL="https://rvdqfxtrskxekfkqnegx.supabase.co"
KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY"

declare -A SHOP_IDS=(
  ["njb"]="b0000000-0000-0000-0000-000000000001"
  ["vitos"]="e0000000-0000-0000-0000-000000000001"
  ["zios"]="2cba7b51-211c-4437-8910-1af4dcc03498"
)

declare -A SHOP_NAMES=(
  ["njb"]="Not Just Bagels"
  ["vitos"]="Vito's Pizza"
  ["zios"]="Zio's Pizzeria"
)

SHOP_ID="${SHOP_IDS[$SLUG]:-}"
SHOP_NAME="${SHOP_NAMES[$SLUG]:-}"

if [ -z "$SHOP_ID" ]; then
  echo "FAIL: unknown shop slug '${SLUG}'. Valid: njb, vitos, zios" >&2
  exit 1
fi

# Read current value before changing
BEFORE=$(curl -s "${SUPABASE_URL}/rest/v1/shops?id=eq.${SHOP_ID}&select=compiled_ordering_engine_enabled" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | \
  python3 -c "import json,sys; print(json.load(sys.stdin)[0]['compiled_ordering_engine_enabled'])")

if [ "$BEFORE" = "$VALUE" ]; then
  echo "Already ${VALUE} for ${SHOP_NAME} — no change."
  exit 0
fi

# Apply
curl -s -X PATCH "${SUPABASE_URL}/rest/v1/shops?id=eq.${SHOP_ID}" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"compiled_ordering_engine_enabled\": ${VALUE}}" > /dev/null

# Verify
AFTER=$(curl -s "${SUPABASE_URL}/rest/v1/shops?id=eq.${SHOP_ID}&select=compiled_ordering_engine_enabled" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" | \
  python3 -c "import json,sys; print(json.load(sys.stdin)[0]['compiled_ordering_engine_enabled'])")

if [ "$AFTER" != "$VALUE" ]; then
  echo "FAIL: DB read-back shows '${AFTER}', expected '${VALUE}'" >&2
  exit 1
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "OK: ${SHOP_NAME} compiled_ordering_engine_enabled ${BEFORE} -> ${AFTER} at ${TIMESTAMP}"
echo ""
echo "Next step — commit this change so it is auditable:"
echo "  git add -A && git commit -m \"feat(config): ${SLUG} compiled engine ${VALUE} [flag-change ${TIMESTAMP}]\""
echo ""
echo "Then run check-switches.sh to verify all three shops are in the expected state."
