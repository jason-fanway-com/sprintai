#!/usr/bin/env bash
set -euo pipefail

# review-chat-transcripts.sh — Query admin_chat_transcripts for debugging admin-chat
# Usage:
#   ./review-chat-transcripts.sh --shop <UUID>        # filter by shop
#   ./review-chat-transcripts.sh --last 50            # last N transcripts (default 20)
#   ./review-chat-transcripts.sh --outcome api_error  # filter by outcome
#   ./review-chat-transcripts.sh --shop <ID> --last 10 --outcome executed

# ─── Load secrets ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SECRETS_FILE="$HOME/.openclaw-sprintai/.secrets"
if [ -f "$SECRETS_FILE" ]; then
  source "$SECRETS_FILE"
fi

SUPABASE_URL="${SPRINTAI_CHAT_SUPABASE_URL:-${SUPABASE_URL:-}}"
SERVICE_ROLE_KEY="${SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY:-${SUPABASE_SERVICE_ROLE_KEY:-}}"

if [ -z "$SUPABASE_URL" ] || [ -z "$SERVICE_ROLE_KEY" ]; then
  echo "ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in $SECRETS_FILE"
  exit 1
fi

# ─── Parse args ────────────────────────────────────────────────────────────────
SHOP_ID=""
LAST="20"
OUTCOME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --shop)   SHOP_ID="$2"; shift 2 ;;
    --last)   LAST="$2"; shift 2 ;;
    --outcome) OUTCOME="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--shop <UUID>] [--last <N>] [--outcome <type>]"
      echo ""
      echo "Outcome types: confirmation_card, clarification, executed, query_status,"
      echo "               out_of_scope, no_tool_call, validation_error, api_error, error"
      exit 0
      ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ─── Build filters ─────────────────────────────────────────────────────────────
FILTERS=""
if [ -n "$SHOP_ID" ]; then
  FILTERS="${FILTERS}&shop_id=eq.${SHOP_ID}"
fi
if [ -n "$OUTCOME" ]; then
  FILTERS="${FILTERS}&outcome=eq.${OUTCOME}"
fi

# ─── Query ─────────────────────────────────────────────────────────────────────
QUERY_URL="${SUPABASE_URL}/rest/v1/admin_chat_transcripts?select=*&order=created_at.desc&limit=${LAST}${FILTERS}"

RESPONSE=$(curl -s -f \
  -H "apikey: ${SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
  "${QUERY_URL}" 2>&1) || {
  echo "ERROR: Query failed"
  echo "$RESPONSE"
  exit 1
}

if [ -z "$RESPONSE" ] || [ "$RESPONSE" = "[]" ]; then
  echo "No transcripts found."
  exit 0
fi

# ─── Pretty-print ──────────────────────────────────────────────────────────────
echo "admin_chat_transcripts (last ${LAST}${SHOP_ID:+", shop=$SHOP_ID"}${OUTCOME:+", outcome=$OUTCOME"})"
echo "═══════════════════════════════════════════════════════════════════════════"
echo ""

echo "$RESPONSE" | python3 -c '
import json, sys, textwrap

rows = json.load(sys.stdin)
for i, r in enumerate(rows):
    # Divider
    if i > 0:
        print("-" * 75)

    ts = r.get("created_at", "?")[:19].replace("T", " ")
    user = (r.get("user_id") or "?")[:8]
    tt = r.get("turn_type", "?")
    outcome = r.get("outcome", "?")
    intent = r.get("parsed_intent") or "—"
    latency = r.get("latency_ms", "?")

    print(f"[{ts}]  user={user}..  turn={tt}  outcome={outcome}  latency={latency}ms")
    print(f"  intent: {intent}")

    raw_msg = r.get("raw_message") or ""
    if raw_msg:
        msg_short = raw_msg[:120] + ("..." if len(raw_msg) > 120 else "")
        print(f"  message: {msg_short}")

    err_msg = r.get("error_message") or ""
    if err_msg:
        err_short = err_msg[:200] + ("..." if len(err_msg) > 200 else "")
        print(f"  error: {err_short}")

    resp = r.get("response_sent") or {}
    if resp:
        resp_str = json.dumps(resp)
        resp_short = resp_str[:150] + ("..." if len(resp_str) > 150 else "")
        print(f"  response: {resp_short}")

print("")
print(f"Total: {len(rows)} transcript(s)")
'