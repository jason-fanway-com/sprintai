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

# stamp_entrypoint FILE SHA — prepend a `// DEPLOY_SHA: <sha>` comment line to
# FILE. Deterministic in SHA alone, so re-running against the same commit
# with no other source changes reproduces byte-identical output — that's
# what lets Supabase's own "No change found" detection keep working.
stamp_entrypoint() {
  local file="$1" sha="$2" tmp
  tmp=$(mktemp)
  { printf '// DEPLOY_SHA: %s\n' "$sha"; cat "$file"; } > "$tmp"
  mv "$tmp" "$file"
}

# verify_stamp FILE SHA — true if FILE contains the exact stamp for SHA.
verify_stamp() {
  local file="$1" sha="$2"
  grep -q "DEPLOY_SHA: ${sha}" "$file"
}

FUNCTION_NAME="${1:-}"
if [ -z "$FUNCTION_NAME" ]; then
  echo "Usage: ./scripts/deploy-function.sh <function-name>" >&2
  exit 1
fi

PROJECT_REF="rvdqfxtrskxekfkqnegx"
FUNC_DIR="supabase/functions/${FUNCTION_NAME}"
ENTRYPOINT="${FUNC_DIR}/index.ts"
HEAD_SHA_FULL=$(git rev-parse HEAD)
HEAD_SHA_SHORT=$(git rev-parse --short HEAD)

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
# Deploy FROM a stamped copy, never the working tree directly, so the deployed
# artifact carries proof of exactly which commit produced it (step 6 checks
# this). `supabase functions deploy` needs the full project structure
# (config.toml + the function's directory + anything it imports, e.g.
# `_shared`), not a single file, so the whole `supabase/` tree is copied and
# only the target entrypoint's copy is stamped.
BUILD_DIR=$(mktemp -d)
DOWNLOAD_DIR=$(mktemp -d)
trap 'rm -rf "$BUILD_DIR" "$DOWNLOAD_DIR"' EXIT
cp -R supabase "${BUILD_DIR}/supabase"
STAMPED_ENTRYPOINT="${BUILD_DIR}/supabase/functions/${FUNCTION_NAME}/index.ts"
stamp_entrypoint "$STAMPED_ENTRYPOINT" "$HEAD_SHA_FULL"

# Capture the output so step 5 can tell the two reasons a version might not move
# apart: Supabase printing "No change found" (source byte-identical to what is
# already live — fine) versus a deploy that silently did nothing (a real
# failure). Conflating them made the gate fail a correct no-op deploy.
DEPLOY_OUT=$(supabase functions deploy "$FUNCTION_NAME" --project-ref "$PROJECT_REF" --workdir "$BUILD_DIR" 2>&1)
echo "$DEPLOY_OUT"

echo "== 5/6 re-reading version =="
NEW_VERSION=$(supabase functions list 2>/dev/null | awk -F'|' -v fn="$FUNCTION_NAME" '{
  name=$2; gsub(/^ +| +$/, "", name);
  if (name == fn) { v=$5; gsub(/^ +| +$/, "", v); print v }
}')
if [ "$NEW_VERSION" = "$OLD_VERSION" ] && echo "$DEPLOY_OUT" | grep -q "No change found"; then
  echo "Version unchanged (${OLD_VERSION}) because Supabase reported \"No change found\" — the source is byte-identical to what is already deployed. That is a correct no-op, not a failure."
  echo ""
  echo "VERDICT: ${FUNCTION_NAME}  ${OLD_VERSION} (unchanged, source identical)  HEAD ${HEAD_SHA_SHORT}"
  exit 0
fi
if [ "$NEW_VERSION" = "$OLD_VERSION" ]; then
  echo "FAIL: version did not move (${OLD_VERSION} -> ${NEW_VERSION}) and Supabase did NOT report \"No change found\". A version that didn't move is a failed deploy, not a no-op." >&2
  exit 1
fi
echo "Version moved: ${OLD_VERSION} -> ${NEW_VERSION}"

echo "== 6/6 downloading deployed artifact, confirming commit-SHA stamp =="
# Replaces the old string-literal-fingerprint comparison (downgraded to
# advisory in 3155aca0 after it false-failed two perfect deploys, v393 and
# v397 — Supabase's transpile/reflow makes quote-pairing over the bundle
# fundamentally unsound). The real invariant isn't "these strings match" —
# it's identity: does the live artifact contain the exact stamp step 4
# planted for this exact commit? That's a grep, not a heuristic, so there's
# no false-fail mode.
( cd "$DOWNLOAD_DIR" && supabase functions download "$FUNCTION_NAME" --project-ref "$PROJECT_REF" >/dev/null 2>&1 )
DEPLOYED_ENTRYPOINT="${DOWNLOAD_DIR}/supabase/functions/${FUNCTION_NAME}/index.ts"
if [ ! -f "$DEPLOYED_ENTRYPOINT" ]; then
  echo "FAIL: could not download the deployed artifact for ${FUNCTION_NAME}." >&2
  exit 1
fi

if ! verify_stamp "$DEPLOYED_ENTRYPOINT" "$HEAD_SHA_FULL"; then
  echo "FAIL: deployed artifact does not contain 'DEPLOY_SHA: ${HEAD_SHA_FULL}'. The version number moved but the live code is not proven to be this commit." >&2
  exit 1
fi
echo "Stamp confirmed: deployed artifact contains DEPLOY_SHA: ${HEAD_SHA_FULL}"

echo ""
echo "VERDICT: ${FUNCTION_NAME} deployed, confirmed HEAD ${HEAD_SHA_FULL} live (${OLD_VERSION} -> ${NEW_VERSION})"
