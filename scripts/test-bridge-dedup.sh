#!/bin/bash
# ============================================================================
# SprintAI Bridge Dedup Fix — Smoke Test Suite (bash 3.2 compatible)
# Sources functions DIRECTLY from imsg-bridge.sh to test the real code.
# ============================================================================

BRIDGE_SCRIPT="/Users/joestrazza/sprintai-ordering/scripts/imsg-bridge.sh"
BRIDGE_DIR="${HOME}/.sprintai-bridge"
TEST_IDS_FILE="${BRIDGE_DIR}/processed-ids.txt.test"

PASS=0
FAIL=0
pass() { echo "  ✅ PASS: $1"; PASS=$(( PASS + 1 )); }
fail() { echo "  ❌ FAIL: $1"; FAIL=$(( FAIL + 1 )); }
log()  { echo "  [LOG] $*"; }

echo "============================================================"
echo "SprintAI Bridge Dedup Fix — Smoke Test Suite"
echo "============================================================"
echo ""

mkdir -p "$BRIDGE_DIR"

# Override PROCESSED_IDS_FILE to use test copy
PROCESSED_IDS_FILE="$TEST_IDS_FILE"
PROCESSED_IDS_MAX=10000
MAX_MSG_AGE_SECONDS=86400

# Source just the relevant functions from the real bridge script
# by extracting them with awk and eval-ing
_source_fn() {
  local fn="$1"
  local body
  body=$(awk "/^${fn}\(\)/{found=1} found{print} found && /^}$/{exit}" "$BRIDGE_SCRIPT")
  eval "$body"
}

_source_fn "load_processed_ids"
_source_fn "_trim_processed_ids_file"
_source_fn "is_processed"
_source_fn "mark_processed"
_source_fn "msg_is_too_old"

# Verify functions were sourced
for fn in load_processed_ids _trim_processed_ids_file is_processed mark_processed msg_is_too_old; do
  type "$fn" &>/dev/null || { echo "ERROR: failed to source function $fn"; exit 1; }
done
echo "  [OK] All 5 functions sourced from real bridge script"
echo ""

# Helper to clear in-memory state between tests
clear_mem() {
  local v
  for v in $(set | grep '^_PROC_' | cut -d= -f1 2>/dev/null); do
    unset "$v"
  done
}

# =========================================================
echo "--- TEST 1: Fresh start — no file ---"
rm -f "$TEST_IDS_FILE"
clear_mem
load_processed_ids
is_processed "1001" && fail "1001 wrongly flagged on fresh start" || pass "Clean state on fresh start"

echo ""
echo "--- TEST 2: mark_processed writes to flat file ---"
rm -f "$TEST_IDS_FILE"
clear_mem
mark_processed "1001"
mark_processed "1002"
mark_processed "1003"
[[ -f "$TEST_IDS_FILE" ]] && pass "Flat file created" || fail "Flat file not created"
COUNT=$(wc -l < "$TEST_IDS_FILE" | tr -d ' ')
[[ "$COUNT" -eq 3 ]] && pass "3 IDs written to file" || fail "Expected 3, got $COUNT"
echo "  File contents: $(cat "$TEST_IDS_FILE" | tr '\n' ' ')"

echo ""
echo "--- TEST 3: Restart simulation — load persisted IDs ---"
clear_mem
load_processed_ids
is_processed "1001" && pass "1001 recognized after restart" || fail "1001 missing after restart"
is_processed "1002" && pass "1002 recognized after restart" || fail "1002 missing after restart"
is_processed "9999" && fail "9999 wrongly flagged" || pass "9999 correctly absent"

echo ""
echo "--- TEST 4: mark_processed is idempotent ---"
BEFORE=$(wc -l < "$TEST_IDS_FILE" | tr -d ' ')
mark_processed "1001"
AFTER=$(wc -l < "$TEST_IDS_FILE" | tr -d ' ')
[[ "$BEFORE" -eq "$AFTER" ]] && pass "No duplicate write for existing ID" || fail "Dup written: before=$BEFORE after=$AFTER"

echo ""
echo "--- TEST 5: _trim_processed_ids_file caps at max ---"
rm -f "$TEST_IDS_FILE"
clear_mem
PROCESSED_IDS_MAX=10
for i in $(seq 1 12); do echo "id_${i}" >> "$TEST_IDS_FILE"; done
_trim_processed_ids_file
AFTER=$(wc -l < "$TEST_IDS_FILE" | tr -d ' ')
[[ "$AFTER" -eq 10 ]] && pass "File trimmed to 10 entries" || fail "Expected 10, got $AFTER"
LAST=$(tail -1 "$TEST_IDS_FILE")
[[ "$LAST" == "id_12" ]] && pass "Most recent IDs kept after trim" || fail "Expected id_12, got $LAST"
PROCESSED_IDS_MAX=10000

echo ""
echo "--- TEST 6: msg_is_too_old — recent (1h ago) NOT skipped ---"
RECENT=$(date -u -v-1H +%Y-%m-%dT%H:%M:%S.000Z)
echo "  Timestamp: $RECENT"
msg_is_too_old "$RECENT" && fail "Recent message wrongly flagged as old" || pass "1h-old message allowed"

echo ""
echo "--- TEST 7: msg_is_too_old — 25h ago IS skipped ---"
OLD=$(date -u -v-25H +%Y-%m-%dT%H:%M:%S.000Z)
echo "  Timestamp: $OLD"
msg_is_too_old "$OLD" && pass "25h-old message correctly flagged too old" || fail "25h-old message NOT flagged"

echo ""
echo "--- TEST 8: Bug replay — id=3421 exact timestamp ---"
BUG_TS="2026-06-18T08:00:07.000Z"
echo "  Timestamp: $BUG_TS"
msg_is_too_old "$BUG_TS" && pass "Bug msg (2026-06-18 08:00 UTC) flagged as too old" || fail "Bug msg NOT flagged"

echo ""
echo "--- TEST 9: Empty date does NOT block ---"
msg_is_too_old "" && fail "Empty date wrongly blocked" || pass "Empty date allows processing"

echo ""
echo "--- TEST 10: Core bug fix — id=3421 blocked after restart ---"
rm -f "$TEST_IDS_FILE"
clear_mem
mark_processed "3421"
echo "  Written to file: $(cat "$TEST_IDS_FILE")"
clear_mem  # simulate restart
load_processed_ids
is_processed "3421" && pass "CORE BUG FIX: id=3421 blocked after restart ✓" || fail "BUG STILL PRESENT: id=3421 not blocked after restart"

echo ""
echo "--- TEST 11: Double-load safety ---"
clear_mem
load_processed_ids
load_processed_ids
is_processed "3421" && pass "3421 still recognized after double-load" || fail "Lost 3421 after double-load"
C=$(wc -l < "$TEST_IDS_FILE" | tr -d ' ')
[[ "$C" -eq 1 ]] && pass "File still has 1 entry (no duplication)" || fail "File has $C entries"

echo ""
echo "--- TEST 12: Proof — file persists across subshell ---"
rm -f "$TEST_IDS_FILE"; clear_mem
mark_processed "5000"
mark_processed "6000"
# Read back in a fresh subshell
RESULT=$(bash -c "
  PROCESSED_IDS_FILE=\"$TEST_IDS_FILE\"
  $(awk '/^is_processed\(\)/{found=1} found{print} found && /^\}$/{exit}' "$BRIDGE_SCRIPT")
  $(awk '/^load_processed_ids\(\)/{found=1} found{print} found && /^\}$/{exit}' "$BRIDGE_SCRIPT")
  log() { :; }
  load_processed_ids >/dev/null 2>&1
  is_processed 5000 && echo YES || echo NO
")
[[ "$RESULT" == "YES" ]] && pass "Subshell reads flat file and sees id=5000" || fail "Subshell did NOT see id=5000 (got: $RESULT)"

# Cleanup
rm -f "$TEST_IDS_FILE"

echo ""
echo "============================================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "============================================================"
[[ "$FAIL" -eq 0 ]] && echo "ALL TESTS PASSED ✅" && exit 0 || { echo "SOME TESTS FAILED ❌"; exit 1; }
