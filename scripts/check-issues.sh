#!/usr/bin/env bash
set -euo pipefail

# check-issues.sh — Heartbeat: query open Sev-1 issues and write trigger files.
#
# Intended for cron or launchd. Reads Supabase credentials from the
# environment or the secrets store. DO NOT embed secrets in this file.
#
# Usage:
#   SUPABASE_URL="https://rvdqfxtrskxekfkqnegx.supabase.co" \
#   SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
#   ./scripts/check-issues.sh
#
# Output: writes JSON trigger files to spec-inbox/.triggers/ when open
# Sev-1 issues are found.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/.."
TRIGGER_DIR="${PROJECT_ROOT}/spec-inbox/.triggers"
LOCK_FILE="${TRIGGER_DIR}/.check-issues.lock"
LAST_RUN_FILE="${TRIGGER_DIR}/.check-issues.last-run"

# ── Help ─────────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "check-issues.sh — Query open Sev-1 issues and create trigger files."
  echo ""
  echo "Env vars required:"
  echo "  SUPABASE_URL              Supabase project URL"
  echo "  SUPABASE_SERVICE_ROLE_KEY Service role key (bypasses RLS)"
  echo ""
  echo "Optional:"
  echo "  CHECK_ISSUES_DRY_RUN=1   Skip writing trigger files; log only"
  exit 0
fi

# ── Env check ────────────────────────────────────────────────────────────────
: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is required}"

DRY_RUN="${CHECK_ISSUES_DRY_RUN:-0}"
API_BASE="${SUPABASE_URL}/rest/v1"

# ── Lock (avoid overlapping runs) ────────────────────────────────────────────
mkdir -p "${TRIGGER_DIR}"
exec 200>"${LOCK_FILE}"
if ! flock -n 200; then
  echo "[check-issues] $(date +%T) already running — skipping" 1>&2
  exit 0
fi

echo "[check-issues] $(date +%T) checking for open Sev-1 issues..."

# ── Query open Sev-1 issues ──────────────────────────────────────────────────
# Fetch issues that are open, Sev-1, detected in the last 24 hours.
resp=""
http_code=$(
  curl -s -o resp.tmp -w '%{http_code}' \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Accept: application/json" \
    "${API_BASE}/issues?status=eq.open&severity=eq.sev_1&select=id,tenant_id,shop_id,title,description,detection_rule,detected_at,metadata&order=detected_at.desc&limit=50"
)

resp="$(cat resp.tmp 2>/dev/null || echo '[]')"
rm -f resp.tmp

if [[ "$http_code" -ne 200 ]]; then
  echo "[check-issues] $(date +%T) HTTP ${http_code} — Supabase query failed" 1>&2
  echo "[check-issues] raw response: ${resp:0:500}" 1>&2
  exit 1
fi

# Validate JSON
if ! echo "$resp" | python3 -m json.tool > /dev/null 2>&1; then
  echo "[check-issues] $(date +%T) invalid JSON response" 1>&2
  exit 1
fi

count=$(echo "$resp" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))')

echo "[check-issues] $(date +%T) ${count} open Sev-1 issues found"

if [[ "$count" -eq 0 ]]; then
  date +%s > "${LAST_RUN_FILE}"
  exit 0
fi

# ── Write trigger files ──────────────────────────────────────────────────────
TIMESTAMP=$(date +%Y%m%dT%H%M%S)

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[check-issues] $(date +%T) DRY RUN — would create ${count} trigger files:"
  echo "$resp" | python3 -c '
import sys, json
issues = json.load(sys.stdin)
for i in issues:
  print(f"  sev1-{i[\"id\"][:8]}: {i[\"title\"]}")
'
  date +%s > "${LAST_RUN_FILE}"
  exit 0
fi

# For each Sev-1 issue, write a trigger JSON file.
echo "$resp" | python3 -c "
import sys, json, os
issues = json.load(sys.stdin)
out_dir = '${TRIGGER_DIR}'
ts = '${TIMESTAMP}'

for issue in issues:
    iid = issue['id']
    trigger = {
        'trigger': 'sev1_issue',
        'issue_id': iid,
        'tenant_id': issue.get('tenant_id'),
        'shop_id': issue.get('shop_id'),
        'title': issue.get('title'),
        'description': issue.get('description'),
        'detection_rule': issue.get('detection_rule'),
        'detected_at': issue.get('detected_at'),
        'metadata': issue.get('metadata', {}),
        'check_timestamp': ts
    }
    filename = f'{out_dir}/sev1-{iid}.json'
    with open(filename, 'w') as f:
        json.dump(trigger, f, indent=2)
    print(f'  wrote {filename}')
"

date +%s > "${LAST_RUN_FILE}"
echo "[check-issues] $(date +%T) done"
