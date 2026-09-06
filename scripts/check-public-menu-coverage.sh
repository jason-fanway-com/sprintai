#!/usr/bin/env bash
# check-public-menu-coverage.sh — sweep every unpaused shop's public menu page.
#
# 2026-09-06: public-menu was written and tested only against vitos-pizza (the
# one shop using the legacy open_hours array shape) and shipped a 500 for
# every other real shop, which used the current flat-object shape. Nothing
# caught it because nobody had ever curled more than one shop. This script is
# the backstop: hit /m/<slug> for every unpaused shop with a slug and fail
# loudly on anything that isn't a 200.
#
# Not wired into CI/cron yet — run on demand until the lead decides where it
# plugs in.
set -uo pipefail
cd "$(dirname "$0")/.."

if [ -f "$HOME/.openclaw-sprintai/.secrets" ]; then
  source "$HOME/.openclaw-sprintai/.secrets"
elif [ -f "$HOME/.openclaw/.secrets" ]; then
  source "$HOME/.openclaw/.secrets"
else
  echo "FATAL — no secrets file found" >&2
  exit 1
fi

PROJECT_REF="${1:-rvdqfxtrskxekfkqnegx}"
BASE_URL="${PUBLIC_MENU_BASE_URL:-https://getsprintai.com}"

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "FATAL — SUPABASE_ACCESS_TOKEN not set" >&2
  exit 1
fi

QUERY='select slug from shops where is_paused = false and slug is not null order by slug;'
RESPONSE=$(curl -s -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1]}))' "$QUERY")")

SLUGS=$(echo "$RESPONSE" | python3 -c "
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception as e:
    print('PARSE_ERROR', file=sys.stderr)
    sys.exit(1)
if isinstance(rows, dict):
    print('API_ERROR: ' + json.dumps(rows), file=sys.stderr)
    sys.exit(1)
for r in rows:
    print(r['slug'])
")
if [ $? -ne 0 ]; then
  echo "FATAL — could not fetch shop slugs. Response: $RESPONSE" >&2
  exit 1
fi

TOTAL=0
OK=0
FAILED_SLUGS=()

while IFS= read -r slug; do
  [ -z "$slug" ] && continue
  TOTAL=$((TOTAL + 1))
  BODY_FILE=$(mktemp)
  CODE=$(curl -s -o "$BODY_FILE" -w '%{http_code}' "${BASE_URL}/m/${slug}")
  if [ "$CODE" = "200" ]; then
    OK=$((OK + 1))
  else
    FAILED_SLUGS+=("$slug")
    echo "FAIL: $slug -> HTTP $CODE" >&2
    echo "  body: $(head -c 500 "$BODY_FILE")" >&2
  fi
  rm -f "$BODY_FILE"
done <<< "$SLUGS"

echo "$OK/$TOTAL shops OK"

if [ ${#FAILED_SLUGS[@]} -gt 0 ]; then
  exit 1
fi
exit 0
