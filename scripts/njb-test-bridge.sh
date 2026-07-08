#!/usr/bin/env bash
# NJB Test Bridge — watches only jason@fanway.com chat for rapid testing
set -euo pipefail

LOG_FILE="/tmp/njb-test-bridge.log"
PID_FILE="/tmp/njb-test-bridge.pid"
PROCESSED_FILE="${HOME}/.sprintai-bridge/test-processed-ids.txt"
WATCH_CHAT_IDENTIFIER="jason@fanway.com"
BOT_PHONE="+14842018054"
ENDPOINT="https://rvdqfxtrskxekfkqnegx.supabase.co/functions/v1/chat-sms"

mkdir -p "$(dirname "$PROCESSED_FILE")"
touch "$PROCESSED_FILE"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

echo $$ > "$PID_FILE"
log "NJB Test Bridge started — watching $WATCH_CHAT_IDENTIFIER"

# Kill any existing bridge first
pkill -f "imsg-bridge.sh" 2>/dev/null || true
pkill -f "njb-test-bridge" 2>/dev/null || true
sleep 1

# Get chat id
CHAT_ID=$(imsg chats --limit 500 --json 2>/dev/null | python3 -c "
import json,sys
for line in sys.stdin:
    c = json.loads(line)
    if c.get('identifier') == '$WATCH_CHAT_IDENTIFIER':
        print(c['id'])
        break
" 2>/dev/null)

if [[ -z "$CHAT_ID" ]]; then
  log "ERROR: chat $WATCH_CHAT_IDENTIFIER not found"
  exit 1
fi
log "Found chat id=$CHAT_ID"

# Seed existing messages as processed
if [[ ! -f "${PROCESSED_FILE}.seeded" ]]; then
  log "Seeding existing messages..."
  imsg history --chat-id "$CHAT_ID" --limit 50 --json 2>/dev/null | python3 -c "
import json,sys
for line in sys.stdin:
    try:
        msg = json.loads(line)
        print(msg.get('id',''))
    except: pass
" 2>/dev/null | while read msg_id; do
    [[ -n "$msg_id" ]] && echo "$msg_id" >> "$PROCESSED_FILE"
  done
  touch "${PROCESSED_FILE}.seeded"
  log "Seeded $(wc -l < "$PROCESSED_FILE") messages"
fi

while true; do
  imsg history --chat-id "$CHAT_ID" --limit 3 --json 2>/dev/null | while read -r msg_line; do
    is_from_me=$(echo "$msg_line" | jq -r '.is_from_me // true' 2>/dev/null) || continue
    msg_id=$(echo "$msg_line" | jq -r '.id // empty' 2>/dev/null) || continue
    msg_text=$(echo "$msg_line" | jq -r '.text // ""' 2>/dev/null) || continue

    # Skip outgoing messages
    [[ "$is_from_me" == "true" ]] && continue

    # Skip if already processed
    grep -qxF "$msg_id" "$PROCESSED_FILE" 2>/dev/null && continue

    log "[NEW] id=$msg_id text=\"$msg_text\""

    # Mark processed
    echo "$msg_id" >> "$PROCESSED_FILE"

    # Send to chat-sms
    RESPONSE=$(curl -s -X POST "$ENDPOINT" \
      -H "Content-Type: application/json" \
      -d "{\"from\": \"$WATCH_CHAT_IDENTIFIER\", \"text\": \"$msg_text\", \"id\": \"$msg_id\"}" 2>&1)

    log "[SENT] endpoint response: $(echo "$RESPONSE" | head -c 200)"

    # If chat-sms responded with text, send it back via iMessage
    REPLY_TEXT=$(echo "$RESPONSE" | jq -r '.response // .text // .message // empty' 2>/dev/null)
    if [[ -n "$REPLY_TEXT" && "$REPLY_TEXT" != "null" ]]; then
      imsg send --to "$WATCH_CHAT_IDENTIFIER" --text "$REPLY_TEXT" --service imessage 2>&1 | tee -a "$LOG_FILE"
      log "[REPLY] sent: $(echo "$REPLY_TEXT" | head -c 100)"
    fi
  done

  sleep 2
done