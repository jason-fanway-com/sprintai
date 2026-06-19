#!/usr/bin/env bash
# ============================================================================
# SprintAI iMessage Bridge
#
# Polls Messages.app for new incoming SMS, relays them through the SprintAI
# chat-sms Supabase edge function, and replies via iMessage/SMS.
#
# The physical iPhone receives SMS to +14842018054.
# When a customer texts that number, it appears as a conversation in
# Messages.app from the customer's phone number.
#
# This script:
#   1. Polls all recent chats for new inbound messages
#   2. Sends each new message to the chat-sms edge function (JSON mode)
#   3. Sends the AI reply back via imsg send
#
# Usage:
#   ./imsg-bridge.sh              # run normally
#   ./imsg-bridge.sh --dry-run    # log only, don't send replies
#   ./imsg-bridge.sh --test       # send one test message and exit
#
# Logs: /tmp/sprintai-imsg-bridge.log
# PID:  /tmp/sprintai-imsg-bridge.pid
# ============================================================================

# No set -euo pipefail — per-message error handling prevents one bad message,
# JSON parse, or edge function timeout from killing the whole bridge.

source ~/.openclaw/.secrets

# -- Config ───────────────────────────────────────────────────────────────────
SHOP_ID="b0000000-0000-0000-0000-000000000001"
EDGE_URL="${SPRINTAI_CHAT_SUPABASE_URL}/functions/v1/chat-sms"
EDGE_KEY="${SPRINTAI_CHAT_SUPABASE_ANON_KEY}"
LOG_FILE="/tmp/sprintai-imsg-bridge.log"
PID_FILE="/tmp/sprintai-imsg-bridge.pid"
POLL_INTERVAL=2
SESSION_DIR="${HOME}/.sprintai-bridge/sessions"
PROCESSED_DIR="${HOME}/.sprintai-bridge/processed"
PROCESSED_IDS_FILE="${HOME}/.sprintai-bridge/processed-ids.txt"
PROCESSED_IDS_MAX=10000
MAX_MSG_AGE_SECONDS=86400
ORDERING_NUMBER="${ORDERING_NUMBER:-+14842018054}"
MODE="${1:-}"

mkdir -p "$SESSION_DIR" "$PROCESSED_DIR" "${HOME}/.sprintai-bridge"
# (No declare -A — using bash-3.2-compatible named-variable set; see load/is/mark below)

# -- Helpers ──────────────────────────────────────────────────────────────────
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

SHUTDOWN_REQUESTED=false

cleanup() {
  SHUTDOWN_REQUESTED=true
  log "Bridge shutting down (PID $$)"
  rm -f "$PID_FILE"
}
trap cleanup SIGINT SIGTERM

# Check deps
for cmd in imsg jq curl; do
  command -v "$cmd" &>/dev/null || { echo "ERROR: $cmd not found" >&2; exit 1; }
done

# -- Session management ────────────────────────────────────────────────────────
# Maps customer phone → persistent session_id (24h TTL)
get_session_id() {
  local sender="$1"
  local safe
  safe=$(echo "$sender" | tr '+' 'p' | tr -cd '[:alnum:]')
  local f="$SESSION_DIR/$safe"

  if [[ -f "$f" ]]; then
    local age=$(( $(date +%s) - $(stat -f%m "$f") ))
    if (( age > 86400 )); then
      echo "imsg-${safe}-$(date +%s)" | tee "$f"
    else
      cat "$f"
    fi
  else
    echo "imsg-${safe}-$(date +%s)" | tee "$f"
  fi
}

# -- Dedup: persistent flat-file processed IDs ───────────────────────────────
# IDs are stored one-per-line in PROCESSED_IDS_FILE and loaded into
# PROCESSED_IDS_SET (associative array) on startup. This survives restarts.

load_processed_ids() {
  if [[ -f "$PROCESSED_IDS_FILE" ]]; then
    local count=0
    while IFS= read -r mid; do
      # Bash 3.2-compatible: store each ID as a named variable _PROC_<id>=1
      [[ -n "$mid" ]] && { eval "_PROC_${mid}=1"; (( count++ )); }
    done < "$PROCESSED_IDS_FILE"
    log "Loaded $count processed IDs from $PROCESSED_IDS_FILE"
  else
    log "No persistent processed-IDs file found — starting fresh"
  fi
}

_trim_processed_ids_file() {
  local count
  count=$(wc -l < "$PROCESSED_IDS_FILE" 2>/dev/null | tr -d ' ') || return 0
  if (( count > PROCESSED_IDS_MAX )); then
    local tmp
    tmp=$(mktemp) || return 0
    tail -n "$PROCESSED_IDS_MAX" "$PROCESSED_IDS_FILE" > "$tmp" && mv "$tmp" "$PROCESSED_IDS_FILE"
    log "Trimmed processed-IDs file from $count to $PROCESSED_IDS_MAX entries"
  fi
}

is_processed() {
  # Bash 3.2-compatible indirect variable lookup
  local _varname="_PROC_${1}"
  [[ "${!_varname}" == "1" ]]
}

mark_processed() {
  local mid="$1"
  if ! is_processed "$mid"; then
    eval "_PROC_${mid}=1"
    echo "$mid" >> "$PROCESSED_IDS_FILE"
  fi
}

# -- Age check: skip messages older than MAX_MSG_AGE_SECONDS ──────────────────
# created_at comes from imsg JSON in ISO8601 form e.g. "2026-06-18T19:38:20.290Z"
msg_is_too_old() {
  local created_at="$1"
  [[ -z "$created_at" ]] && return 1  # no date → don't skip

  # Strip milliseconds and trailing Z, then parse
  local dt_clean
  dt_clean=$(echo "$created_at" | sed 's/\.[0-9]*Z$//' | sed 's/Z$//')
  local msg_epoch
  # TZ=UTC ensures the stripped ISO8601 string is parsed as UTC (the Z suffix indicates UTC)
  msg_epoch=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "$dt_clean" +%s 2>/dev/null) || return 1

  local now_epoch
  now_epoch=$(date +%s)
  (( now_epoch - msg_epoch > MAX_MSG_AGE_SECONDS ))
}

# -- Call edge function ────────────────────────────────────────────────────────
call_sprint() {
  local message="$1"
  local session_id="$2"

  curl -s -X POST "$EDGE_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $EDGE_KEY" \
    --max-time 60 \
    -d "$(jq -n \
      --arg shop_id "$SHOP_ID" \
      --arg message "$message" \
      --arg session_id "$session_id" \
      '{shop_id: $shop_id, message: $message, session_id: $session_id}')" 2>/dev/null
}

# -- Send reply ────────────────────────────────────────────────────────────────
send_reply() {
  local to="$1"
  local text="$2"

  if [[ "$MODE" == "--dry-run" ]]; then
    log "[DRY RUN] Would send to $to: $text"
    return 0
  fi

  # Send via SMS (physical iPhone handles the transport)
  imsg send --to "$to" --text "$text" --service imessage 2>&1 | tee -a "$LOG_FILE"
}

# -- Process one message ───────────────────────────────────────────────────────
# Errors are caught and logged; the message is always marked processed to
# avoid infinite retry loops on poison messages.
process_message() {
  local sender="$1"
  local text="$2"
  local msg_id="$3"

  # Skip if already processed
  if is_processed "$msg_id"; then
    return 0
  fi

  log "━━━ INCOMING ━━━"
  log "  From: $sender"
  log "  Text: $text"

  local session_id
  if ! session_id=$(get_session_id "$sender"); then
    log "  ERROR: Failed to get session ID"
    mark_processed "$msg_id"
    return 0
  fi
  log "  Session: $session_id"

  # Call edge function — failure is non-fatal
  local response
  response=$(call_sprint "$text" "$session_id") || true

  if [[ -z "$response" ]]; then
    log "  ERROR: No response from edge function"
    mark_processed "$msg_id"
    return 0
  fi

  local reply phase
  reply=$(echo "$response" | jq -r '.reply // empty' 2>/dev/null) || true
  phase=$(echo "$response" | jq -r '.phase // "unknown"' 2>/dev/null) || true

  if [[ -z "$reply" ]]; then
    log "  ERROR: No reply in response"
    log "  Raw: $response"
    mark_processed "$msg_id"
    return 0
  fi

  log "  Phase: $phase"
  log "  Reply: $reply"

  if send_reply "$sender" "$reply"; then
    log "  ✓ Sent"
  else
    log "  ERROR: imsg send failed"
  fi

  mark_processed "$msg_id"
}

# -- Test mode ─────────────────────────────────────────────────────────────────
if [[ "$MODE" == "--test" ]]; then
  log "TEST MODE: Sending test message to edge function"
  response=$(call_sprint "Hi, what bagels do you have?" "test-session-$(date +%s)")
  echo "$response" | jq .
  exit 0
fi

# -- Seed existing messages on first run ───────────────────────────────────────
# Mark all existing messages as processed so we only catch genuinely new ones.
# Uses ${PROCESSED_IDS_FILE}.seeded as a durable marker (not in the prunable dir).
seed_existing() {
  [[ -f "${PROCESSED_IDS_FILE}.seeded" ]] && return 0

  log "First run: seeding existing messages as processed..."
  local seed_count=0
  while IFS= read -r chat_line; do
    local chat_id chat_identifier
    chat_id=$(echo "$chat_line" | jq -r '.id' 2>/dev/null) || continue
    chat_identifier=$(echo "$chat_line" | jq -r '.identifier // empty' 2>/dev/null) || continue
    [[ "$chat_identifier" != +* ]] && continue
    while IFS= read -r msg_line; do
      local msg_id
      msg_id=$(echo "$msg_line" | jq -r '.id // empty' 2>/dev/null) || continue
      if [[ -n "$msg_id" ]]; then
        mark_processed "$msg_id"
        (( seed_count++ ))
      fi
    done < <(imsg history --chat-id "$chat_id" --limit 10 --json 2>/dev/null)
  done < <(imsg chats --limit 30 --json 2>/dev/null)
  touch "${PROCESSED_IDS_FILE}.seeded"
  log "Seeded $seed_count existing messages into flat file"
}

# -- Outbound queue drain ─────────────────────────────────────────────────────
drain_outbound_queue() {
  local rows
  local now_iso
  now_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  rows=$(curl -s \
    "${SPRINTAI_CHAT_SUPABASE_URL}/rest/v1/outbound_queue?sent_at=is.null&send_after=lte.${now_iso}&order=created_at.asc&limit=20" \
    -H "apikey: ${SPRINTAI_CHAT_SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Accept: application/json" 2>/dev/null) || return 0

  local count
  count=$(echo "$rows" | jq 'length' 2>/dev/null) || return 0
  [[ "$count" -eq 0 ]] && return 0

  log "[OUTBOUND] Draining $count queued message(s)"

  echo "$rows" | jq -c '.[]' | while IFS= read -r row; do
    local id to_phone message
    id=$(echo "$row" | jq -r '.id') || continue
    to_phone=$(echo "$row" | jq -r '.to_phone') || continue
    message=$(echo "$row" | jq -r '.message') || continue

    log "[OUTBOUND] Sending to $to_phone: ${message:0:60}"

    if imsg send --to "$to_phone" --text "$message" --service imessage >> "$LOG_FILE" 2>&1; then
      # Mark sent
      curl -s -X PATCH \
        "${SPRINTAI_CHAT_SUPABASE_URL}/rest/v1/outbound_queue?id=eq.${id}" \
        -H "apikey: ${SPRINTAI_CHAT_SUPABASE_ANON_KEY}" \
        -H "Authorization: Bearer ${SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY}" \
        -H "Content-Type: application/json" \
        -d "{\"sent_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > /dev/null 2>&1
      log "[OUTBOUND] Sent OK to $to_phone (id=$id)"
    else
      # Mark error
      curl -s -X PATCH \
        "${SPRINTAI_CHAT_SUPABASE_URL}/rest/v1/outbound_queue?id=eq.${id}" \
        -H "apikey: ${SPRINTAI_CHAT_SUPABASE_ANON_KEY}" \
        -H "Authorization: Bearer ${SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY}" \
        -H "Content-Type: application/json" \
        -d "{\"error\": \"imsg send failed\"}" > /dev/null 2>&1
      log "[OUTBOUND] FAILED to send to $to_phone (id=$id)"
    fi
  done
}

# -- Main poll loop ────────────────────────────────────────────────────────────
run_bridge() {
  load_processed_ids
  _trim_processed_ids_file
  seed_existing

  while [[ "$SHUTDOWN_REQUESTED" != "true" ]]; do
    drain_outbound_queue
    # Get all recent chats
    while IFS= read -r chat_line; do
      local chat_id chat_identifier
      chat_id=$(echo "$chat_line" | jq -r '.id' 2>/dev/null) || continue
      chat_identifier=$(echo "$chat_line" | jq -r '.identifier // empty' 2>/dev/null) || continue

      # Skip non-phone-number chats (Apple IDs like jason@fanway.com)
      [[ "$chat_identifier" != +* ]] && continue

      log "[SCAN] chat=$chat_identifier"

      # Get latest 3 messages from this chat
      while IFS= read -r msg_line; do
        local is_from_me msg_text msg_id destination_caller_id msg_created_at
        is_from_me=$(echo "$msg_line" | jq -r '.is_from_me // false' 2>/dev/null) || continue
        msg_text=$(echo "$msg_line" | jq -r '.text // empty' 2>/dev/null) || continue
        msg_id=$(echo "$msg_line" | jq -r '.id // empty' 2>/dev/null) || continue
        destination_caller_id=$(echo "$msg_line" | jq -r '.destination_caller_id // empty' 2>/dev/null) || continue
        msg_created_at=$(echo "$msg_line" | jq -r '.created_at // empty' 2>/dev/null) || true

        # Debug: log every message evaluated
        local is_proc_flag="false"
        is_processed "$msg_id" && is_proc_flag="true"
        log "[MSG] id=$msg_id from_me=$is_from_me dst=$destination_caller_id processed=$is_proc_flag created_at=$msg_created_at text='${msg_text:0:30}'"

        # Skip outbound, empty, or already processed
        [[ "$is_from_me" == "true" ]] && { log "[SKIP] id=$msg_id: is_from_me"; continue; }
        [[ -z "$msg_text" ]] && { log "[SKIP] id=$msg_id: empty text"; continue; }
        [[ -z "$msg_id" ]] && continue
        is_processed "$msg_id" && { log "[SKIP] id=$msg_id: already processed (persistent)"; continue; }

        # Skip messages older than 24h (belt-and-suspenders against stale re-processing)
        if msg_is_too_old "$msg_created_at"; then
          log "[SKIP] id=$msg_id: message older than ${MAX_MSG_AGE_SECONDS}s ($msg_created_at) — marking processed"
          mark_processed "$msg_id"
          continue
        fi

        # Only process messages addressed to the ordering number
        if [[ "$destination_caller_id" != "$ORDERING_NUMBER" ]]; then
          log "[SKIP] id=$msg_id: dst=$destination_caller_id != $ORDERING_NUMBER"
          continue
        fi

        # Wrap so unexpected errors in process_message don't abort the loop;
        # always mark processed to prevent infinite retries on poison messages.
        {
          process_message "$chat_identifier" "$msg_text" "$msg_id"
        } || {
          log "  ERROR: process_message threw for msg=$msg_id — marking processed"
          mark_processed "$msg_id"
        }

      done < <(imsg history --chat-id "$chat_id" --limit 3 --json 2>/dev/null)

    done < <(imsg chats --limit 30 --json 2>/dev/null)

    sleep "$POLL_INTERVAL"
  done
}

# -- Startup ───────────────────────────────────────────────────────────────────
echo $$ > "$PID_FILE"
log "================================================="
log "SprintAI iMessage Bridge started (PID $$)"
log "Shop: Not Just Bagels ($SHOP_ID)"
log "Mode: ${MODE:-live}"
log "Poll interval: ${POLL_INTERVAL}s"
log "================================================="

# -- Restart-on-crash wrapper ──────────────────────────────────────────────────
# If run_bridge exits unexpectedly, log and restart after 5s.
# Cap at MAX_CRASHES within CRASH_WINDOW seconds to prevent a tight crash loop;
# after that, exit so launchd (KeepAlive: true) can handle the restart cleanly.
CRASH_TIMES=()
MAX_CRASHES=3
CRASH_WINDOW=60

while [[ "$SHUTDOWN_REQUESTED" != "true" ]]; do
  run_bridge || true

  # Clean shutdown via SIGTERM/SIGINT
  [[ "$SHUTDOWN_REQUESTED" == "true" ]] && break

  # Unexpected exit — record the crash time
  now=$(date +%s)
  recent_crashes=()
  for t in "${CRASH_TIMES[@]}"; do
    (( now - t < CRASH_WINDOW )) && recent_crashes+=("$t")
  done
  recent_crashes+=("$now")
  CRASH_TIMES=("${recent_crashes[@]}")

  log "CRASH: Bridge exited unexpectedly (${#CRASH_TIMES[@]} crash(es) in last ${CRASH_WINDOW}s)"

  if (( ${#CRASH_TIMES[@]} >= MAX_CRASHES )); then
    log "FATAL: ${MAX_CRASHES} crashes in ${CRASH_WINDOW}s — exiting, launchd will restart"
    rm -f "$PID_FILE"
    exit 1
  fi

  log "Restarting bridge in 5s..."
  sleep 5
done

log "Bridge stopped cleanly"
exit 0
