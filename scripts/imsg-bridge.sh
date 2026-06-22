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
# COMPLIANCE (TCPA/10DLC, lead directive 2026-06-22): the age window is the
# fail-closed gate against replaying stale inbound messages as fresh auto-
# replies. A message older than this is NEVER a live inbound worth auto-
# answering. Tightened from 24h to 15 min. Overridable via env for tests only.
MAX_MSG_AGE_SECONDS="${MAX_MSG_AGE_SECONDS:-900}"   # 15 minutes
LOCK_FILE="${SPRINTAI_BRIDGE_LOCK_FILE:-${HOME}/.sprintai-bridge/bridge.lock}"
ORDERING_NUMBER="${ORDERING_NUMBER:-+14842018054}"
MODE="${1:-}"

mkdir -p "$SESSION_DIR" "$PROCESSED_DIR" "${HOME}/.sprintai-bridge"
# (No declare -A — using bash-3.2-compatible named-variable set; see load/is/mark below)

# -- Helpers ──────────────────────────────────────────────────────────────────
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# -- Single-instance lock ─────────────────────────────────────────────────────
# COMPLIANCE (lead directive 2026-06-22): two bridges running concurrently was a
# root cause of double/replayed sends. Enforce a single live instance.
#
# macOS bash 3.2 has no flock(1), so we use an atomic mkdir lock plus a PID-
# liveness check. mkdir is atomic on the local filesystem: only one process can
# create the dir. We store our PID inside it. On startup, if the lock exists but
# the owning PID is dead (stale lock from a crash/kill), we reclaim it. If the
# owning PID is alive, we refuse to start. Robust to launchd KeepAlive (a
# relaunch only succeeds once the prior process is gone) and to manual starts.
LOCK_ACQUIRED=false

acquire_singleton_lock() {
  local pidfile="${LOCK_FILE}/pid"
  local tries=0
  while (( tries < 2 )); do
    if mkdir "$LOCK_FILE" 2>/dev/null; then
      echo "$$" > "$pidfile"
      LOCK_ACQUIRED=true
      log "Acquired single-instance lock (PID $$) at $LOCK_FILE"
      return 0
    fi
    # Lock dir exists — check whether the owner is still alive.
    local owner=""
    [[ -f "$pidfile" ]] && owner=$(cat "$pidfile" 2>/dev/null | tr -cd '0-9')
    if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null && [[ "$owner" != "$$" ]]; then
      log "REFUSING TO START: another live bridge holds the lock (PID $owner). Exiting."
      echo "ERROR: another bridge instance is already running (PID $owner)" >&2
      return 1
    fi
    # Stale lock (owner empty or dead) — reclaim it and retry once.
    log "Stale lock detected (owner='${owner:-none}', not alive) — reclaiming."
    rm -rf "$LOCK_FILE"
    (( tries++ ))
  done
  log "REFUSING TO START: could not acquire lock after reclaim attempts. Exiting."
  return 1
}

release_singleton_lock() {
  # Only remove the lock if WE own it (avoid deleting another instance's lock).
  if [[ "$LOCK_ACQUIRED" == "true" ]]; then
    local owner=""
    [[ -f "${LOCK_FILE}/pid" ]] && owner=$(cat "${LOCK_FILE}/pid" 2>/dev/null | tr -cd '0-9')
    if [[ "$owner" == "$$" ]]; then
      rm -rf "$LOCK_FILE"
      log "Released single-instance lock (PID $$)"
    fi
  fi
}

SHUTDOWN_REQUESTED=false

cleanup() {
  SHUTDOWN_REQUESTED=true
  log "Bridge shutting down (PID $$)"
  rm -f "$PID_FILE"
  release_singleton_lock
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

# -- Returning-phone detection (defensive greeting guard) ──────────────────
# COMPLIANCE (lead directive 2026-06-22): a phone has "prior history" if it
# already has a session file on disk. Used by the defensive TTL-rollover guard
# so an aged/replayed message can't mint a brand-new session and fire a fresh
# "Welcome" to someone we've talked to before. The age guard is the primary
# defense; this is belt-and-suspenders.
phone_has_session_history() {
  local sender="$1"
  local safe
  safe=$(echo "$sender" | tr '+' 'p' | tr -cd '[:alnum:]')
  [[ -f "$SESSION_DIR/$safe" ]]
}

# -- Dedup: persistent flat-file processed IDs ───────────────────────────────
# IDs are stored one-per-line in PROCESSED_IDS_FILE and loaded into
# PROCESSED_IDS_SET (associative array) on startup. This survives restarts.

# Map an arbitrary message id to a SAFE bash variable name for the in-memory
# fast-path cache. Message ids can contain hyphens/colons/slashes (real iMessage
# GUIDs do), which are illegal in a bash identifier and would make a naive
# `eval _PROC_<id>=1` fail (treated as a command). We replace every non-alnum
# char with `_`. The on-disk PROCESSED_IDS_FILE always stores the RAW id, so this
# sanitization only affects the cache key, never the source-of-truth lookup.
_proc_varname() {
  local raw="$1"
  printf '_PROC_%s' "$(printf '%s' "$raw" | tr -c '[:alnum:]' '_')"
}

load_processed_ids() {
  if [[ -f "$PROCESSED_IDS_FILE" ]]; then
    local count=0
    while IFS= read -r mid; do
      # Bash 3.2-compatible: store each ID as a named (sanitized) variable
      [[ -n "$mid" ]] && { local _v; _v=$(_proc_varname "$mid"); eval "${_v}=1"; (( count++ )); }
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

# COMPLIANCE (lead directive 2026-06-22): the on-disk PROCESSED_IDS_FILE is the
# SINGLE SOURCE OF TRUTH for dedup. The in-memory _PROC_* vars are ONLY a
# fast-path cache and may NEVER override a positive on-disk hit. This kills the
# replay bug where a stale in-memory snapshot (second logical reader / restarted
# loop) could let an already-processed id re-send.
is_processed() {
  local mid="$1"
  [[ -z "$mid" ]] && return 1
  # 1) Fast-path: in-memory cache. A cache HIT is authoritative-positive.
  local _varname; _varname=$(_proc_varname "$mid")
  [[ "${!_varname}" == "1" ]] && return 0
  # 2) On a cache MISS, the cache is NOT trusted (it may be a stale snapshot).
  #    Consult the durable file as the source of truth on EVERY call.
  if [[ -f "$PROCESSED_IDS_FILE" ]] && grep -qxF "$mid" "$PROCESSED_IDS_FILE" 2>/dev/null; then
    # Warm the cache for next time, then report processed.
    eval "${_varname}=1"
    return 0
  fi
  return 1
}

# mark_processed writes THROUGH to the durable file (atomic append) and does so
# BEFORE the send is attempted by the caller, so a crash mid-send can never
# cause a double-send. Append (O_APPEND, single line) is atomic on local FS; the
# singleton lock makes concurrency moot, but this stays correct on its own.
mark_processed() {
  local mid="$1"
  [[ -z "$mid" ]] && return 0
  # Write-through to disk first (durable source of truth), guarded against dupes.
  if ! { [[ -f "$PROCESSED_IDS_FILE" ]] && grep -qxF "$mid" "$PROCESSED_IDS_FILE" 2>/dev/null; }; then
    printf '%s\n' "$mid" >> "$PROCESSED_IDS_FILE"
  fi
  # Then warm the in-memory fast-path cache (sanitized var name).
  local _v; _v=$(_proc_varname "$mid")
  eval "${_v}=1"
}

# -- Age check: skip messages older than MAX_MSG_AGE_SECONDS ──────────────────
# created_at comes from imsg JSON in ISO8601 form e.g. "2026-06-18T19:38:20.290Z"
# COMPLIANCE (lead directive 2026-06-22): this gate FAILS CLOSED. Return 0
# ("too old → SKIP") is the path the caller uses to NOT auto-reply. A message
# with a MISSING, EMPTY, or UNPARSEABLE created_at is treated as too old and is
# skipped — we never auto-reply to a message we cannot prove is fresh. Only a
# successfully-parsed timestamp within MAX_MSG_AGE_SECONDS is allowed through
# (return 1 = "fresh → process").
msg_is_too_old() {
  local created_at="$1"
  # Missing/empty timestamp → cannot prove freshness → TOO OLD (skip).
  [[ -z "$created_at" ]] && return 0

  # Strip milliseconds and trailing Z, then parse
  local dt_clean
  dt_clean=$(echo "$created_at" | sed 's/\.[0-9]*Z$//' | sed 's/Z$//')
  local msg_epoch
  # TZ=UTC ensures the stripped ISO8601 string is parsed as UTC (the Z suffix indicates UTC).
  # Parse failure → cannot prove freshness → TOO OLD (skip).
  msg_epoch=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "$dt_clean" +%s 2>/dev/null) || return 0
  # Empty/non-numeric epoch (defensive) → TOO OLD (skip).
  [[ "$msg_epoch" =~ ^[0-9]+$ ]] || return 0

  local now_epoch
  now_epoch=$(date +%s)
  # Future-skew bound (TCPA fail-closed gate, per Melvin QA 2026-06-22): an
  # implausibly future-dated created_at (clock tampering, bad parse, replay)
  # must NOT slip through as "fresh". We allow 120s of benign clock skew; any
  # timestamp more than 120s in the FUTURE is treated as too old → SKIP.
  (( msg_epoch - now_epoch > 120 )) && return 0
  # Fresh only if within the window; otherwise too old (skip).
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

# -- STRUCTURAL OUTBOUND WATCHDOG (bridge side) ───────────────────────────────
# Parallel to supabase/functions/_shared/outbound-guard.ts. EVERY customer-
# facing imsg send on the bridge MUST pass through assert_outbound_allowed
# first. It returns 0 (ALLOW) only for a recognized reason WITH valid evidence;
# otherwise it logs a CRITICAL line (alert trail) and returns 1 (DENY). The two
# bridge send paths (send_reply, drain_outbound_queue) are the ONLY callers of
# `imsg send` for customer text, and both are gated below. Default-deny: an
# unknown/blank reason is DENIED.
#
# Reasons:
#   inbound_reply     -- synchronous reply to a fresh inbound. Evidence:
#                        $2=inbound msg id (non-empty), $3=inbound epoch secs
#                        (within MAX_MSG_AGE_SECONDS of now).
#   payment_confirmed -- queued paid-order receipt drained from outbound_queue.
#   order_refunded    -- queued refund notice drained from outbound_queue.
#                        For the two transactional reasons evidence is $2=queue
#                        row id (non-empty); the row only exists because the
#                        functions-side guard already verified paid/refund state
#                        at enqueue time, and the drain query requires sent_at IS
#                        NULL so a row is never sent twice.
assert_outbound_allowed() {
  local reason="$1"
  local ev1="${2:-}"
  local ev2="${3:-}"
  local critical
  critical() {
    # ids + reason + short why only. NO message body, NO secrets.
    log "[OUTBOUND-WATCHDOG][CRITICAL] DENY reason=${reason:-(blank)} ev1=${ev1:-of-} why=\"$1\""
  }

  case "$reason" in
    inbound_reply)
      if [[ -z "$ev1" ]]; then critical "inbound_reply missing inbound message id"; return 1; fi
      if ! [[ "$ev2" =~ ^[0-9]+$ ]]; then critical "inbound_reply missing/invalid inbound timestamp"; return 1; fi
      local now age
      now=$(date +%s)
      age=$(( now - ev2 ))
      if (( age < 0 )); then critical "inbound_reply timestamp in the future"; return 1; fi
      if (( age > MAX_MSG_AGE_SECONDS )); then critical "inbound_reply stale (age ${age}s > ${MAX_MSG_AGE_SECONDS}s)"; return 1; fi
      return 0
      ;;
    payment_confirmed|order_refunded)
      if [[ -z "$ev1" ]]; then critical "$reason missing queue row id"; return 1; fi
      return 0
      ;;
    *)
      critical "unknown or blank reason"
      return 1
      ;;
  esac
}

# -- Send reply ────────────────────────────────────────────────────────────────
# reason/evidence are passed so the watchdog can prove this is a fresh inbound
# reply. $3=inbound msg id, $4=inbound epoch secs.
send_reply() {
  local to="$1"
  local text="$2"
  local inbound_id="${3:-}"
  local inbound_ts="${4:-}"

  # WATCHDOG GATE: fail closed if this is not a fresh inbound reply.
  if ! assert_outbound_allowed "inbound_reply" "$inbound_id" "$inbound_ts"; then
    log "  ✗ OUTBOUND BLOCKED by watchdog (send_reply); no imsg sent."
    return 1
  fi

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
  local created_at="${4:-}"

  # Convert the inbound created_at to epoch seconds for the watchdog freshness
  # evidence. If it cannot be parsed we pass 0, which the guard treats as stale
  # and DENIES (fail-closed) — the same posture as msg_is_too_old upstream.
  local inbound_ts=0
  if [[ -n "$created_at" ]]; then
    local _dt
    _dt=$(echo "$created_at" | sed 's/\.[0-9]*Z$//' | sed 's/Z$//')
    inbound_ts=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "$_dt" +%s 2>/dev/null) || inbound_ts=0
    [[ "$inbound_ts" =~ ^[0-9]+$ ]] || inbound_ts=0
  fi

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

  # COMPLIANCE (lead directive 2026-06-22): mark processed (write-through to
  # disk) BEFORE attempting the send. If we crash mid-send, the id is already
  # durably recorded, so the message can never be re-sent on restart. We accept
  # the rare "marked but not sent" over the unacceptable "sent twice."
  mark_processed "$msg_id"

  if send_reply "$sender" "$reply" "$msg_id" "$inbound_ts"; then
    log "  ✓ Sent"
  else
    log "  ERROR: imsg send failed or blocked by watchdog"
  fi
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

    # WATCHDOG GATE: queued rows are the transactional pushes (paid receipt /
    # refund) that the functions-side guard already verified against real cart
    # state at enqueue time. We still gate here so the bridge cannot send a
    # queued message without a recognized reason + row-id evidence (default-deny
    # if either is absent). reason column is optional; default to the receipt
    # class when absent (both allowed reasons behave identically here).
    local q_reason
    q_reason=$(echo "$row" | jq -r '.reason // "payment_confirmed"' 2>/dev/null) || q_reason="payment_confirmed"
    if ! assert_outbound_allowed "$q_reason" "$id"; then
      log "[OUTBOUND] BLOCKED by watchdog (id=$id reason=$q_reason); not sent."
      curl -s -X PATCH \
        "${SPRINTAI_CHAT_SUPABASE_URL}/rest/v1/outbound_queue?id=eq.${id}" \
        -H "apikey: ${SPRINTAI_CHAT_SUPABASE_ANON_KEY}" \
        -H "Authorization: Bearer ${SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY}" \
        -H "Content-Type: application/json" \
        -d "{\"error\": \"watchdog denied\"}" > /dev/null 2>&1
      continue
    fi

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

        # PRIMARY DEFENSE (fail-closed): skip messages we cannot prove are fresh
        # within MAX_MSG_AGE_SECONDS. A stale/replayed inbound is marked processed
        # and never auto-answered.
        if msg_is_too_old "$msg_created_at"; then
          log "[SKIP] id=$msg_id: not fresh within ${MAX_MSG_AGE_SECONDS}s ($msg_created_at) — marking processed"
          mark_processed "$msg_id"
          continue
        fi

        # DEFENSIVE TTL-ROLLOVER GREETING GUARD (belt-and-suspenders):
        # Even if a message slipped the age gate, never let a non-fresh message
        # mint a brand-new session (and thus a fresh "Welcome") for a phone that
        # already has prior history. With the fail-closed age guard above this is
        # moot in practice, but it closes the greeting path independently.
        if [[ -z "$msg_created_at" ]] && phone_has_session_history "$chat_identifier"; then
          log "[SKIP] id=$msg_id: undateable message for returning phone $chat_identifier — refusing to re-greet, marking processed"
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
          process_message "$chat_identifier" "$msg_text" "$msg_id" "$msg_created_at"
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
#
# COMPLIANCE (lead directive 2026-06-22): acquire the single-instance lock ONCE
# here, BEFORE any processing and BEFORE the crash-restart loop, so the same PID
# keeps the lock across self-restarts. If another live bridge holds it, refuse to
# start (exit non-zero) WITHOUT processing anything. Tests override
# SPRINTAI_BRIDGE_LOCK_FILE to a temp path so they never collide with PID 18724's
# lock. The cleanup trap (release_singleton_lock) runs on SIGINT/SIGTERM.
if ! acquire_singleton_lock; then
  log "Startup aborted: singleton lock not acquired."
  rm -f "$PID_FILE"
  exit 1
fi

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
