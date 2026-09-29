#!/bin/bash
# apply-migration.sh — run one migration file against the live database through the Supabase Management API
# (the RUNBOOK's method while the migration tracker is drifted), then confirm the named columns exist.
# usage: SUPABASE_ACCESS_TOKEN=... scripts/delivery/apply-migration.sh supabase/migrations/148_deliveries.sql table:col [table:col ...]
# The token is read from the environment and never printed.
set -euo pipefail
REF="rvdqfxtrskxekfkqnegx"
FILE="$1"; shift
[ -n "${SUPABASE_ACCESS_TOKEN:-}" ] || { echo "SUPABASE_ACCESS_TOKEN is not set" >&2; exit 1; }
q() { python3 -c 'import json,sys; print(json.dumps({"query": sys.stdin.read()}))' | curl -sS -X POST "https://api.supabase.com/v1/projects/${REF}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" -H "Content-Type: application/json" --data-binary @-; }
echo "== applying ${FILE}"
OUT=$(q < "$FILE"); echo "$OUT" | head -c 400; echo
echo "$OUT" | grep -qi '"message"' && { echo "FAIL: the database returned an error" >&2; exit 1; }
FAIL=0
for pair in "$@"; do
  t="${pair%%:*}"; c="${pair##*:}"
  R=$(echo "SELECT 1 AS ok FROM information_schema.columns WHERE table_schema='public' AND table_name='${t}' AND column_name='${c}'" | q)
  if echo "$R" | grep -q '"ok":1'; then echo "ok   ${t}.${c}"; else echo "MISSING ${t}.${c}: ${R}"; FAIL=1; fi
done
exit $FAIL
