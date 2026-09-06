#!/usr/bin/env bash
# Fail loudly on a duplicate migration number.
#
# 2026-09-06: two migrations landed the same hour both numbered 108
# (108_option_choices_unpriced.sql from the importer branch,
# 108_tester_attribution.sql from this session) — one would have silently won
# depending on filesystem ordering, and nothing anywhere would have said so.
# Same silent-partial failure class as the menu importer that started this
# whole day: something wins, nothing announces it.
#
# Excludes *.down.sql — a migration and its own rollback companion sharing a
# number is the established, correct pattern here, not a collision.
#
# Run before committing a new migration, and treat a non-zero exit as a hard
# stop — do not renumber around it without reading why the collision happened.
set -euo pipefail
cd "$(dirname "$0")/.."

dupes=$(ls supabase/migrations/*.sql 2>/dev/null \
  | grep -v '\.down\.sql$' \
  | xargs -n1 basename \
  | grep -oE '^[0-9]+' \
  | sort | uniq -d)

if [ -n "$dupes" ]; then
  echo "FAIL: duplicate migration number(s) found:" >&2
  for n in $dupes; do
    echo "  $n:" >&2
    ls supabase/migrations/${n}_*.sql 2>/dev/null | grep -v '\.down\.sql$' | sed 's/^/    /' >&2
  done
  echo "Renumber one of the colliding files before committing." >&2
  exit 1
fi

echo "OK: no duplicate migration numbers."
