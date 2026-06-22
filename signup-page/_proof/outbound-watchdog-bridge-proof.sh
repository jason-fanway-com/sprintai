#!/usr/bin/env bash
# SprintAI — BRIDGE OUTBOUND WATCHDOG PROOF
# ========================================
# Proves the bridge-side `assert_outbound_allowed` shell guard (default-deny)
# using the EXACT function body extracted live from scripts/imsg-bridge.sh.
# We source only that function + its MAX_MSG_AGE_SECONDS/log deps so we test the
# REAL guard logic, not a copy. No imsg send, no network, no secrets.
#
# RUN: bash signup-page/_proof/outbound-watchdog-bridge-proof.sh
set -uo pipefail

BRIDGE="$(cd "$(dirname "$0")/../../scripts" && pwd)/imsg-bridge.sh"
[[ -f "$BRIDGE" ]] || { echo "bridge not found: $BRIDGE"; exit 1; }

# ── Harness deps the guard references (log + window) ──────────────────────────
CRITICAL_LOG=""
log() { CRITICAL_LOG+="$*"$'\n'; }   # capture instead of writing a file
MAX_MSG_AGE_SECONDS=900

# ── Extract the REAL assert_outbound_allowed function body from the bridge ─────
# Pull from the function header line to its closing `}` at column 0.
GUARD_SRC="$(awk '/^assert_outbound_allowed\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$BRIDGE")"
if [[ -z "$GUARD_SRC" ]]; then echo "could not extract guard"; exit 1; fi
eval "$GUARD_SRC"

pass=0; fail=0
NOW=$(date +%s)

# expect: $1=label  $2=expected(0=ALLOW,1=DENY)  rest=args to guard
expect() {
  local label="$1" want="$2"; shift 2
  CRITICAL_LOG=""
  assert_outbound_allowed "$@" >/dev/null 2>&1
  local got=$?
  if [[ "$got" -eq "$want" ]]; then
    pass=$((pass+1)); echo "  ✓ $label"
  else
    fail=$((fail+1)); echo "  ✗ FAIL: $label (want rc=$want got rc=$got)"
  fi
}

echo "[BRIDGE] assert_outbound_allowed — shell default-deny proof"

# inbound_reply: fresh id + epoch → ALLOW
expect "inbound_reply fresh id+epoch → ALLOW" 0 "inbound_reply" "msg-123" "$NOW"
# inbound_reply: missing id → DENY
expect "inbound_reply missing id → DENY" 1 "inbound_reply" "" "$NOW"
# inbound_reply: non-numeric ts → DENY
expect "inbound_reply bad ts → DENY" 1 "inbound_reply" "msg-123" "not-a-number"
# inbound_reply: stale (>900s) → DENY
expect "inbound_reply stale → DENY" 1 "inbound_reply" "msg-123" "$((NOW - 1000))"
# inbound_reply: future ts → DENY
expect "inbound_reply future → DENY" 1 "inbound_reply" "msg-123" "$((NOW + 600))"

# payment_confirmed / order_refunded: queue row id present → ALLOW
expect "payment_confirmed + queue row id → ALLOW" 0 "payment_confirmed" "row-abc"
expect "order_refunded + queue row id → ALLOW" 0 "order_refunded" "row-def"
# transactional missing row id → DENY
expect "payment_confirmed missing row id → DENY" 1 "payment_confirmed" ""
expect "order_refunded missing row id → DENY" 1 "order_refunded" ""

# default-deny: unknown / blank reason → DENY
expect "unknown reason → DENY" 1 "marketing_blast" "row-x"
expect "blank reason → DENY" 1 "" "row-x"

# ── Prove DENY logs a CRITICAL line and ALLOW does not ────────────────────────
CRITICAL_LOG=""
assert_outbound_allowed "blast" "x" >/dev/null 2>&1
if grep -q "\[OUTBOUND-WATCHDOG\]\[CRITICAL\] DENY" <<<"$CRITICAL_LOG"; then
  pass=$((pass+1)); echo "  ✓ DENY emits CRITICAL log line"
  echo "    --- captured: $(grep CRITICAL <<<"$CRITICAL_LOG" | head -1)"
else
  fail=$((fail+1)); echo "  ✗ FAIL: DENY did not emit CRITICAL line"
fi

CRITICAL_LOG=""
assert_outbound_allowed "inbound_reply" "msg-1" "$NOW" >/dev/null 2>&1
if grep -q "CRITICAL" <<<"$CRITICAL_LOG"; then
  fail=$((fail+1)); echo "  ✗ FAIL: ALLOW wrongly emitted CRITICAL"
else
  pass=$((pass+1)); echo "  ✓ ALLOW emits NO CRITICAL line"
fi

echo "════════════════════════════════════════════════"
echo "BRIDGE RESULT: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]] && { echo "ALL BRIDGE GUARD PROOFS PASSED ✅"; exit 0; } || exit 1
