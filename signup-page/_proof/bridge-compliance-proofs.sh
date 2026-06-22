#!/usr/bin/env bash
# ============================================================================
# Proof harness for the iMessage-bridge compliance fixes (Mechanism A).
# Branch: fix/kill-unsolicited-outbound
#
# Exercises the bridge functions in ISOLATION using TEMP lock + TEMP processed-ids
# + TEMP session dir via env overrides. It NEVER:
#   - touches ~/.sprintai-bridge
#   - touches the live bridge (PID 18724)
#   - sends any SMS/iMessage (no imsg send is ever invoked here)
#
# Proves:
#   (a) singleton lock: live foreign lock => refuse (exit non-zero);
#       stale lock (dead PID) => reclaimed.
#   (b) dedup: write-through to disk; is_processed returns TRUE even when the
#       in-memory _PROC_* cache is cleared (on-disk authority; stale-snapshot race).
#   (c) age-guard fail-closed: empty/garbage/16min => skip; 5min => allowed.
#   (d) Erin replay: already-processed, >15min-old inbound re-seen => NO send.
# ============================================================================
# NOTE: intentionally NO `set -u`. The production bridge runs WITHOUT
# `set -euo pipefail` (by design, per its own header comment), and its functions
# rely on bash treating unset vars as empty (e.g. ${!_varname} when an id has
# never been cached). We mirror that exact runtime here so the proof exercises
# the functions as they actually run in production.
set -o pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bridge-proof.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
ok()   { echo "  PASS: $*"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $*"; FAIL=$((FAIL+1)); }

echo "=== Bridge compliance proofs ==="
echo "Workdir: $WORK"
echo "Live bridge PID 18724 status: $(ps -p 18724 -o pid= 2>/dev/null | tr -d ' ' || echo gone) (untouched)"
echo

# --- Harmless placeholders for secrets the lib config references --------------
# The unit functions under test never use these; they exist only so the config
# block's variable expansions don't trip our harness's `set -u`. NOT real keys.
export SPRINTAI_CHAT_SUPABASE_URL="http://proof.invalid"
export SPRINTAI_CHAT_SUPABASE_ANON_KEY="proof-anon"
export SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY="proof-svc"

# --- Set TEMP env overrides BEFORE extracting/sourcing the lib -----------------
export SPRINTAI_BRIDGE_LOCK_FILE="$WORK/bridge.lock"
export PROCESSED_IDS_FILE_OVERRIDE="$WORK/processed-ids.txt"   # see note below
export HOME_OVERRIDE="$WORK/home"
mkdir -p "$WORK/home/.sprintai-bridge/sessions"

# The bridge reads PROCESSED_IDS_FILE/SESSION_DIR from $HOME, not from env. To keep
# the live ~/.sprintai-bridge untouched we point HOME at a temp dir for the lib's
# config block, then source. We restore HOME immediately after.
REAL_HOME="$HOME"
export HOME="$WORK/home"

LIB="$WORK/bridge-lib.sh"
HOME="$REAL_HOME" bash "$HERE/_extract-bridge-lib.sh" "$LIB" >/dev/null
# shellcheck disable=SC1090
source "$LIB"
export HOME="$REAL_HOME"   # restore real HOME for everything else

echo "Config in effect (temp):"
echo "  LOCK_FILE          = $LOCK_FILE"
echo "  PROCESSED_IDS_FILE = $PROCESSED_IDS_FILE"
echo "  SESSION_DIR        = $SESSION_DIR"
echo "  MAX_MSG_AGE_SECONDS= $MAX_MSG_AGE_SECONDS"
[[ "$LOCK_FILE" == "$WORK"* ]] || { echo "ABORT: lock not in temp dir"; exit 2; }
[[ "$PROCESSED_IDS_FILE" == "$WORK"* ]] || { echo "ABORT: processed file not in temp dir"; exit 2; }
echo

# ============================================================================
echo "--- (a) singleton lock ---"
# a1: a live FOREIGN lock => second acquire REFUSES (return non-zero).
#     Use this very shell ($$) as the live owner — guaranteed alive, not us-as-bridge.
# Spawn a REAL background process to own the lock — a genuinely-alive FOREIGN
# PID (not this shell's $$, which the lock code treats as self).
sleep 120 &
LIVE_PID=$!
mkdir -p "$LOCK_FILE"
echo "$LIVE_PID" > "$LOCK_FILE/pid"
LOCK_ACQUIRED=false
if acquire_singleton_lock; then
  bad "(a1) acquire SUCCEEDED despite live foreign lock (PID $LIVE_PID)"
else
  ok  "(a1) acquire REFUSED while live foreign lock held (PID $LIVE_PID) -> non-zero"
fi
# Ensure it did NOT steal the lock dir
[[ -d "$LOCK_FILE" && "$(cat "$LOCK_FILE/pid")" == "$LIVE_PID" ]] \
  && ok "(a1) foreign lock left intact" || bad "(a1) foreign lock was disturbed"
kill "$LIVE_PID" 2>/dev/null; wait "$LIVE_PID" 2>/dev/null || true

# a2: a STALE lock (dead PID) => reclaimed (return 0).
rm -rf "$LOCK_FILE"; mkdir -p "$LOCK_FILE"
# Find a PID that is definitely dead.
DEAD_PID=999990
while kill -0 "$DEAD_PID" 2>/dev/null; do DEAD_PID=$((DEAD_PID+1)); done
echo "$DEAD_PID" > "$LOCK_FILE/pid"
LOCK_ACQUIRED=false
if acquire_singleton_lock; then
  owner="$(cat "$LOCK_FILE/pid" 2>/dev/null)"
  [[ "$owner" == "$$" ]] \
    && ok "(a2) stale lock (dead PID $DEAD_PID) reclaimed; now owned by $$" \
    || bad "(a2) reclaimed but pid file shows '$owner' not $$"
else
  bad "(a2) failed to reclaim stale lock (dead PID $DEAD_PID)"
fi
# Cleanup our own lock so it doesn't linger
release_singleton_lock 2>/dev/null || rm -rf "$LOCK_FILE"
echo

# ============================================================================
echo "--- (b) dedup: on-disk authority beats stale in-memory cache ---"
: > "$PROCESSED_IDS_FILE"
ID="erin-msg-0001"
# Precondition: not processed.
is_processed "$ID" && bad "(b) precondition: id already processed?!" || ok "(b) precondition: id not processed"
# Mark it (write-through to disk).
mark_processed "$ID"
grep -qxF "$ID" "$PROCESSED_IDS_FILE" \
  && ok "(b) mark_processed wrote-through to disk" \
  || bad "(b) mark_processed did NOT write to disk"
# Now SIMULATE THE STALE-SNAPSHOT RACE: clear the in-memory cache var entirely,
# as if a second logical reader / restarted loop never saw it in memory.
varname="$(_proc_varname "$ID")"
unset "$varname" 2>/dev/null || true
[[ -z "${!varname:-}" ]] && ok "(b) in-memory cache var cleared (simulated stale snapshot)" \
                          || bad "(b) could not clear in-memory cache var"
# is_processed MUST still return true via on-disk source of truth.
if is_processed "$ID"; then
  ok "(b) is_processed=TRUE from on-disk authority despite empty in-memory cache (NO re-process)"
else
  bad "(b) is_processed=FALSE with empty cache -> REPLAY BUG NOT FIXED"
fi
echo

# ============================================================================
echo "--- (c) age-guard fail-closed ---"
# helper: too_old returns 0 (skip) / 1 (allowed)
check_age() { # $1=label $2=created_at $3=expect(skip|allow)
  local label="$1" ca="$2" expect="$3"
  if msg_is_too_old "$ca"; then verdict="skip"; else verdict="allow"; fi
  if [[ "$verdict" == "$expect" ]]; then ok "(c) $label: created_at='$ca' -> $verdict"; \
  else bad "(c) $label: created_at='$ca' -> $verdict (expected $expect)"; fi
}
now_minus() { TZ=UTC date -u -v-"$1" +%Y-%m-%dT%H:%M:%S.000Z; }
# Future-skew helpers (Melvin QA 2026-06-22): an implausibly future-dated
# created_at must fail closed (skip); a small clock skew must still be allowed.
now_plus()  { TZ=UTC date -u -v+"$1" +%Y-%m-%dT%H:%M:%S.000Z; }
check_age "empty"        ""                       skip
check_age "garbage"      "not-a-timestamp"        skip
check_age "16min-old"    "$(now_minus 16M)"       skip
check_age "5min-old"     "$(now_minus 5M)"        allow
# Future-skew bound: >120s into the future fails closed; <=120s is tolerated.
check_age "5min-future"  "$(now_plus 5M)"         skip
check_age "90s-future"   "$(now_plus 90S)"        allow
echo

# ============================================================================
echo "--- (d) Erin-replay scenario (dedup + age guard combined) ---"
# Recreate the real failure: an inbound that is BOTH already-processed AND
# >15min old, re-seen by the loop. The loop logic is: skip if is_processed OR
# msg_is_too_old. Prove BOTH independently say 'skip' => NO send path reached.
: > "$PROCESSED_IDS_FILE"
ERIN_ID="erin-replay-9999"
ERIN_TS="$(now_minus 42M)"   # 42 minutes old (well past 15min window)
mark_processed "$ERIN_ID"
# Simulate stale snapshot again (worst case): cache cleared.
unset "$(_proc_varname "$ERIN_ID")" 2>/dev/null || true

would_send="YES"
# Mirror the loop's guard order exactly:
if is_processed "$ERIN_ID"; then
  would_send="NO (already processed - on-disk)"
elif msg_is_too_old "$ERIN_TS"; then
  would_send="NO (too old)"
fi
if [[ "$would_send" == NO* ]]; then
  ok "(d) Erin replay (>15min, already-processed, stale cache) => $would_send"
else
  bad "(d) Erin replay would SEND -> $would_send  *** COMPLIANCE FAILURE ***"
fi
# Also prove age-guard ALONE blocks it even if dedup were wiped:
: > "$PROCESSED_IDS_FILE"
if msg_is_too_old "$ERIN_TS"; then
  ok "(d) age-guard ALONE blocks the 42min-old replay (defense-in-depth)"
else
  bad "(d) age-guard ALONE failed to block 42min-old replay"
fi
echo

# ============================================================================
echo "=== RESULTS: $PASS passed, $FAIL failed ==="
echo "Live bridge PID 18724 status after tests: $(ps -p 18724 -o pid= 2>/dev/null | tr -d ' ' || echo gone) (untouched)"
echo "Real ~/.sprintai-bridge NOT touched by this harness (used $WORK)."
[[ "$FAIL" -eq 0 ]] && { echo "ALL PROOFS PASSED"; exit 0; } || { echo "SOME PROOFS FAILED"; exit 1; }
