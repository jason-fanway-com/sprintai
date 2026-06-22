#!/usr/bin/env bash
# Extracts the config + function definitions from scripts/imsg-bridge.sh into a
# sourceable library WITHOUT running the startup/poll-loop or the --test block,
# and WITHOUT sourcing real secrets or requiring the imsg binary. Proof tests
# source the emitted lib and exercise the bridge functions in isolation.
#
# Safety: this NEVER touches ~/.sprintai-bridge or the live bridge (PID 18724).
# All proof tests set SPRINTAI_BRIDGE_LOCK_FILE / PROCESSED_IDS_FILE / SESSION_DIR
# to temp paths via env overrides BEFORE sourcing the lib.
set -euo pipefail

BRIDGE_SRC="$(cd "$(dirname "$0")/../../scripts" && pwd)/imsg-bridge.sh"
OUT="${1:?usage: _extract-bridge-lib.sh <out-path>}"

# Take lines 1..340 (config + all functions, up to just before '# -- Test mode'),
# then neutralize the two top-level side effects we don't want in a lib context:
#   - 'source ~/.openclaw/.secrets'  (we don't want real secrets in the harness)
#   - the 'for cmd in imsg jq curl' dep-check (imsg may not be needed for unit fns)
# We also make the config overridable by exporting our temp paths BEFORE sourcing,
# which works because the script reads env defaults (${VAR:-default}).
# Cut at the sentinel (the '# -- Test mode' banner) instead of a hardcoded line
# number, so the lib always ends on a clean boundary even if functions above grow.
sed -n '1,/^# -- Test mode/p' "$BRIDGE_SRC" | sed '$d' \
  | sed 's|^source ~/.openclaw/.secrets|: # [proof] secrets source disabled|' \
  | awk '
      /^for cmd in imsg jq curl; do/ { skip=1 }
      skip==1 && /^done/ { skip=0; print ": # [proof] dep-check disabled"; next }
      skip==1 { next }
      { print }
    ' > "$OUT"

echo "Extracted bridge lib -> $OUT ($(wc -l < "$OUT" | tr -d ' ') lines)"
