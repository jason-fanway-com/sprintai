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

# PO-only deploy lock. The PO creates ~/po-scratch/.po-deploy-token herself,
# by hand, right before each deploy she runs. Nothing else in this repo
# should ever create or touch that file. A fresh token proves this deploy
# was triggered by her, just now -- not by anyone or anything else replaying
# an old approval.
PO_DEPLOY_TOKEN="$HOME/po-scratch/.po-deploy-token"
if [ ! -f "$PO_DEPLOY_TOKEN" ] || [ $(( $(date +%s) - $(stat -f %m "$PO_DEPLOY_TOKEN" 2>/dev/null || stat -c %Y "$PO_DEPLOY_TOKEN" 2>/dev/null || echo 0) )) -ge 600 ]; then
  echo "deploy is PO-only: no fresh ~/po-scratch/.po-deploy-token" >&2
  exit 1
fi

# Refuse while a sim run is in flight. A deploy that lands mid-run splits one
# result across two builds, and run_meta.json attributes all of it to the
# first -- a comparison that looks valid and is not (2026-09-18). The lock is
# written by ~/po-scratch/simcustomer.py and names the pid; a stale lock from
# a dead process does not block.
INFLIGHT="${SIM_INFLIGHT_PATH:-$HOME/po-scratch/simruns/INFLIGHT}"
if [ -f "$INFLIGHT" ]; then
  INFLIGHT_PID=$(sed -n 's/^pid=//p' "$INFLIGHT" | head -1)
  if [ -n "$INFLIGHT_PID" ] && kill -0 "$INFLIGHT_PID" 2>/dev/null; then
    echo "FAIL: a sim run is in flight (pid ${INFLIGHT_PID}, $(sed -n 's/^started=//p' "$INFLIGHT" | head -1)). Deploying now would split its result across two builds. Wait for it to finish, or stop it first." >&2
    exit 2
  fi
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

# The stamp says "this bundle is commit HEAD". Step 4 copies the WORKING TREE,
# so if any file the bundle actually ships is uncommitted, the stamp lies and
# every sim result attributed to it is attributed to code nobody can check
# out. 2026-09-18: a deploy went out while a crew member had
# _shared/compile-menu.ts half-edited in the tree. The file list comes from
# deno's own import graph, so an unrelated dirty file (docs, admin, another
# function) does not block.
BUNDLE_FILES=$(deno info --json "$ENTRYPOINT" 2>/dev/null | python3 -c '
import json, sys, os
root = os.getcwd() + "/"
d = json.load(sys.stdin)
for m in d["modules"]:
    s = m["specifier"]
    if s.startswith("file://" + root):
        print(s[len("file://" + root):])
')
DIRTY_BUNDLE=$(echo "$BUNDLE_FILES" | xargs git status --porcelain -- 2>/dev/null | grep -v '^??' || true)
if [ -n "$DIRTY_BUNDLE" ]; then
  echo "FAIL: uncommitted changes in files that ship in the ${FUNCTION_NAME} bundle. The deploy would carry code that HEAD ${HEAD_SHA_SHORT} does not contain, under a stamp that says it does. Commit or stash them first, or deploy from a clean 'git worktree' of HEAD:" >&2
  echo "$DIRTY_BUNDLE" >&2
  exit 1
fi

echo "== 0/6 schema validation: declared columns must exist in live DB =="
# Declared (table, column) pairs this function reads from. Add a new entry
# whenever you add a migration that introduces a column the function depends on.
# The deploy aborts if any declared column is absent from the live schema —
# the migration was never applied. This is a C2-class defect class: migration
# absent → column absent → feature silently inert (3 occurrences 2026-09-12).
DECLARED_COLUMNS=(
  "order_carts:delivery_offer_made_at"
  "order_carts:delivery_fee_cents"
  "order_carts:pending_disambiguation"
  "order_carts:fee_disclosed_at"
  "order_carts:pickup_name"
  "order_carts:driver_tip_cents"
  "order_carts:test_mode"
  "order_carts:order_type"
  "order_carts:delivery_address"
  "order_carts:dialogue_state"
  "customers:last_order_type"
  "customers:last_delivery_address"
  "customers:name"
  "customers:order_count"
  "shop_settings:fulfilment_modes"
)
MGMT_TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
if [ -z "$MGMT_TOKEN" ]; then
  echo "WARN: SUPABASE_ACCESS_TOKEN not set — skipping schema validation (set it to enable the C2 guard)." >&2
else
  SCHEMA_FAIL=0
  for entry in "${DECLARED_COLUMNS[@]}"; do
    tbl="${entry%%:*}"
    col="${entry##*:}"
    SQL="SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${tbl}' AND column_name='${col}' LIMIT 1"
    RESP=$(curl -s -X POST \
      "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
      -H "Authorization: Bearer ${MGMT_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"query\":\"${SQL}\"}" 2>&1)
    # Management API returns a JSON array of row objects, e.g. [{"?column?":1}]
    # for a present column, [] for an absent one. The value is a bare JSON
    # number, not a quoted string — do not grep for '"1"', it never matches.
    if [ "$RESP" = "[]" ]; then
      echo "FAIL: column '${tbl}.${col}' not found in live schema — migration not applied." >&2
      SCHEMA_FAIL=1
    elif ! echo "$RESP" | grep -q '^\['; then
      echo "FAIL: schema check for '${tbl}.${col}' returned an unexpected response (not a JSON array): ${RESP}" >&2
      SCHEMA_FAIL=1
    fi
  done
  if [ "$SCHEMA_FAIL" -ne 0 ]; then
    echo "FAIL: schema validation failed — one or more required columns are missing. Apply the pending migration(s) before deploying." >&2
    exit 1
  fi
  echo "Schema validation passed: all ${#DECLARED_COLUMNS[@]} declared columns confirmed in live DB."
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

# Burn the PO's token now that the deploy is confirmed live -- it can't be
# reused to authorize a second deploy off the same approval.
rm -f "$PO_DEPLOY_TOKEN"

echo ""
echo "VERDICT: ${FUNCTION_NAME} deployed, confirmed HEAD ${HEAD_SHA_FULL} live (${OLD_VERSION} -> ${NEW_VERSION})"
