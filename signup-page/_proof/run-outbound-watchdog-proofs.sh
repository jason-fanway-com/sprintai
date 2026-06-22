#!/usr/bin/env bash
# One-shot runner for ALL outbound-watchdog proofs.
# Runs the functions-side guard proof (real .ts via Node type-stripping) and the
# bridge shell-guard proof. Exits non-zero if any check fails.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "========================================================"
echo "OUTBOUND WATCHDOG — FULL PROOF RUN"
echo "========================================================"

echo
echo ">>> functions-side guard (REAL outbound-guard.ts via node --experimental-strip-types)"
node --experimental-strip-types "$HERE/outbound-watchdog-proofs.mjs"
rc1=$?

echo
echo ">>> bridge shell guard (REAL assert_outbound_allowed from imsg-bridge.sh)"
bash "$HERE/outbound-watchdog-bridge-proof.sh"
rc2=$?

echo
echo "========================================================"
if [[ $rc1 -eq 0 && $rc2 -eq 0 ]]; then
  echo "✅ ALL OUTBOUND WATCHDOG PROOFS PASSED"
  exit 0
fi
echo "❌ PROOF FAILURE (functions rc=$rc1 bridge rc=$rc2)"
exit 1
