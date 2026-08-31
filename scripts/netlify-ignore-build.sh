#!/usr/bin/env bash
#
# netlify-ignore-build.sh — Netlify `ignore` command for the ROOT site.
#
# Contract: exit 0 => SKIP the build, exit 1 => RUN the build.
#
# WHY: the root site publishes an explicit allowlist assembled by
# scripts/build-public-site.sh. Build notes, specs, _proof/ QA artifacts,
# supabase/ functions and admin-dashboard/ are NEVER copied to the origin,
# so a commit touching only those paths cannot change the published site —
# yet it still buys a full build (root npm install + a cold shop-chat
# Vite install/build). At ~67 commits per cycle that is the single biggest
# avoidable line on the Netlify credit bill.
#
# SAFETY: this script fails OPEN. Any uncertainty — missing refs, a git
# error, an unrecognised path — builds. It only ever skips when every
# changed path is provably not on the origin.
#
set -uo pipefail

# Netlify sets CACHED_COMMIT_REF to the commit of the last successful deploy.
# It is empty on a first build, a manual deploy, or after a cleared cache.
if [[ -z "${CACHED_COMMIT_REF:-}" || -z "${COMMIT_REF:-}" ]]; then
  echo "[ignore] no cached commit ref — building"
  exit 1
fi

CHANGED="$(git diff --name-only "$CACHED_COMMIT_REF" "$COMMIT_REF" 2>/dev/null)" || {
  echo "[ignore] git diff failed — building to be safe"
  exit 1
}

if [[ -z "$CHANGED" ]]; then
  echo "[ignore] no changed files between deploys — skipping"
  exit 0
fi

# Paths that provably never reach the root origin. Keep this in sync with the
# allowlist in scripts/build-public-site.sh: if a path is not copied there,
# it belongs here.
NOT_ON_ORIGIN='^([^/]*\.md|docs/.*|_proof/.*|admin-dashboard/.*|supabase/.*|[^/]*\.htmltext)$'

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if [[ ! "$f" =~ $NOT_ON_ORIGIN ]]; then
    echo "[ignore] '$f' can affect the origin — building"
    exit 1
  fi
done <<< "$CHANGED"

echo "[ignore] only off-origin paths changed — skipping build:"
echo "$CHANGED" | sed 's/^/  - /'
exit 0
