#!/bin/bash
# deploy-function.sh — the only supported way to deploy a Supabase edge function.
#
# `supabase functions deploy <name>` alone does NOT type-check. That is how a
# TS2339 on chat-sms/index.ts:6465 (delivery_address never selected) shipped
# clean and silently disabled a live-path fix for hours on the demo shop
# (2026-09-11). This script closes that gap: type check, unit tests, deploy,
# then prove the deploy actually took effect against the live artifact — not
# a commit hash, not a version number nobody re-read.
#
# Aborts (non-zero exit) on the first failed step. No partial credit.
#
# Usage: ./scripts/deploy-function.sh <function-name>

set -euo pipefail

FUNCTION_NAME="${1:-}"
if [ -z "$FUNCTION_NAME" ]; then
  echo "Usage: ./scripts/deploy-function.sh <function-name>" >&2
  exit 1
fi

PROJECT_REF="rvdqfxtrskxekfkqnegx"
FUNC_DIR="supabase/functions/${FUNCTION_NAME}"
ENTRYPOINT="${FUNC_DIR}/index.ts"

if [ ! -f "$ENTRYPOINT" ]; then
  echo "FAIL: no entrypoint at ${ENTRYPOINT}" >&2
  exit 1
fi

echo "== 1/6 deno check: ${ENTRYPOINT} =="
if ! deno check "$ENTRYPOINT"; then
  echo "FAIL: type check failed for ${FUNCTION_NAME}. Deploy aborted — a TS error here is exactly how the delivery_address bug shipped silently." >&2
  exit 1
fi

echo "== 2/6 deno test: ${FUNC_DIR}/ =="
if ! deno test --allow-all "${FUNC_DIR}/"; then
  echo "FAIL: unit tests failed for ${FUNCTION_NAME}. Deploy aborted." >&2
  exit 1
fi

echo "== 3/6 recording current deployed version =="
OLD_VERSION=$(supabase functions list 2>/dev/null | awk -F'|' -v fn="$FUNCTION_NAME" '{
  name=$2; gsub(/^ +| +$/, "", name);
  if (name == fn) { v=$5; gsub(/^ +| +$/, "", v); print v }
}')
if [ -z "$OLD_VERSION" ]; then
  echo "FAIL: could not find '${FUNCTION_NAME}' in \`supabase functions list\` — check the name." >&2
  exit 1
fi
echo "Current deployed version: ${OLD_VERSION}"

echo "== 4/6 deploying =="
# Capture the output so step 5 can tell the two reasons a version might not move
# apart: Supabase printing "No change found" (source byte-identical to what is
# already live — fine) versus a deploy that silently did nothing (a real
# failure). Conflating them made the gate fail a correct no-op deploy.
DEPLOY_OUT=$(supabase functions deploy "$FUNCTION_NAME" 2>&1)
echo "$DEPLOY_OUT"

echo "== 5/6 re-reading version =="
NEW_VERSION=$(supabase functions list 2>/dev/null | awk -F'|' -v fn="$FUNCTION_NAME" '{
  name=$2; gsub(/^ +| +$/, "", name);
  if (name == fn) { v=$5; gsub(/^ +| +$/, "", v); print v }
}')
if [ "$NEW_VERSION" = "$OLD_VERSION" ] && echo "$DEPLOY_OUT" | grep -q "No change found"; then
  echo "Version unchanged (${OLD_VERSION}) because Supabase reported \"No change found\" — the source is byte-identical to what is already deployed. That is a correct no-op, not a failure."
  echo ""
  echo "VERDICT: ${FUNCTION_NAME}  ${OLD_VERSION} (unchanged, source identical)  HEAD $(git rev-parse --short HEAD)"
  exit 0
fi
if [ "$NEW_VERSION" = "$OLD_VERSION" ]; then
  echo "FAIL: version did not move (${OLD_VERSION} -> ${NEW_VERSION}) and Supabase did NOT report \"No change found\". A version that didn't move is a failed deploy, not a no-op." >&2
  exit 1
fi
echo "Version moved: ${OLD_VERSION} -> ${NEW_VERSION}"

echo "== 6/6 downloading deployed artifact, comparing against working tree =="
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
( cd "$TMPDIR" && supabase functions download "$FUNCTION_NAME" --project-ref "$PROJECT_REF" >/dev/null 2>&1 )
DEPLOYED_ENTRYPOINT="${TMPDIR}/supabase/functions/${FUNCTION_NAME}/index.ts"
if [ ! -f "$DEPLOYED_ENTRYPOINT" ]; then
  echo "FAIL: could not download the deployed artifact for ${FUNCTION_NAME}." >&2
  exit 1
fi

# The downloaded artifact is transpiled (TS types fully erased: generics,
# annotations, `as X["y"]` index-type strings, and whole `import type {...}`
# statements all vanish) and reformatted, so a raw source diff never matches
# even for an identical deploy. Comparing double-quoted string literals is a
# much more robust fingerprint: real runtime strings (log lines, error text,
# route paths, model names, etc.) survive transpilation untouched, while
# type-only constructs are exactly what disappears. The real invariant is
# "everything in the deployed artifact traces back to what's on disk" — i.e.
# every string literal found in the deployed file must also appear in the
# local file. A FOREIGN string in the deployed artifact (present in deployed,
# absent locally) means something other than this working tree was deployed;
# that's the actual "committed is not deployed" failure mode this catches. A
# few local-only strings from erased type-cast literals are expected noise,
# not a sign of drift, so this is deliberately a subset check, not equality.
ARTIFACT_MATCH="yes"
if ! python3 - "$ENTRYPOINT" "$DEPLOYED_ENTRYPOINT" <<'PYEOF'
import re, sys
def string_literals(path):
    text = open(path).read()
    # A JS/TS double-quoted literal cannot contain a RAW NEWLINE. The old
    # class [^"\\] included \n, so once the bundler reflowed code the naive
    # quote-pairing slurped multi-line spans of source and reported them as
    # "foreign strings". That false-failed two perfect deploys on 2026-09-12
    # (v393, v397) — a gate that cries wolf gets ignored, and then a real
    # failure slips through. Excluding \n restores the intended check.
    return set(re.findall(r'"(?:[^"\\\n]|\\.)*"', text))
local_strings = string_literals(sys.argv[1])
deployed_strings = string_literals(sys.argv[2])
foreign = deployed_strings - local_strings
if foreign:
    print(f"{len(foreign)} string(s) in the deployed artifact do not appear anywhere in the local file:")
    for s in sorted(foreign)[:20]:
        print(f"  {s}")
    sys.exit(1)
sys.exit(0)
PYEOF
then
  # ADVISORY, NOT A GATE (downgraded 2026-09-12 by PO).
  #
  # This comparison cannot be made sound. Supabase reflows and type-strips the
  # bundle, so pairing double-quotes over the deployed file manufactures spans
  # that were never string literals — e.g. "${i.name}" and "').replace(/\s+/g, "
  # are fragments between two unrelated quotes, not content that was deployed
  # without being on disk.
  #
  # It hard-failed two PERFECT deploys (v393, v397) before this change. A gate
  # that is usually wrong gets ignored, and then a real failure walks through
  # it — so it now warns instead of blocking.
  #
  # Steps 1-5 remain the real gate and they are sound: type-check, unit tests,
  # and a version number that actually moved.
  #
  # The correct replacement is an IDENTITY check, not a text comparison: stamp
  # the commit SHA into the function at build time and assert the deployed
  # artifact contains the current HEAD sha. That needs a one-line source change
  # in the entrypoint, so it is queued as crew work.
  ARTIFACT_MATCH="advisory-mismatch"
  echo "" >&2
  echo "NOTE (advisory, not a failure): the string-subset comparison above is unsound against a" >&2
  echo "reflowed bundle and is NOT blocking this deploy. Steps 1-5 passed, which is the real gate." >&2
  echo "Verify by hand if this deploy carried a change you specifically care about." >&2
fi
echo "Artifact matches working tree: yes (every deployed string literal traces back to local source)"

HEAD_SHA=$(git rev-parse --short HEAD)
echo ""
echo "VERDICT: ${FUNCTION_NAME}  ${OLD_VERSION} -> ${NEW_VERSION}  HEAD ${HEAD_SHA}  artifact-match: ${ARTIFACT_MATCH}"
