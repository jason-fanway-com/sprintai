#!/bin/bash
# publish-build-status.sh — Command Center build-status publisher.
#
# Spec: docs/specs/2026-09-05-command-center-live.md (Jason, 2026-09-05).
#
# Derives, in order: docs/specs/2026-09-03-READINESS.md (parsed, never
# hardcoded), `git log` since local midnight America/New_York, and deployed
# edge-function versions (Supabase Management API) — and writes them to
# build_status_items / _commits / _functions / _meta via service-role RPC.
# The dashboard reads those tables; it never reads the repo or runs git.
#
# Shell-first: the expensive path (parse + git log + Management API call)
# only runs when HEAD or the READINESS.md mtime changed since the last
# SUCCESSFUL run. A quiet, healthy tick costs one tiny heartbeat request.
# Never invokes a model.
#
# Run by: launchd ai.openclaw.sprintai.buildstatus (every 5 min) and the
# repo's git post-commit hook. Registered in
# ~/.openclaw-sprintai/SCHEDULED-REGISTER.md.

set -uo pipefail

REPO="$HOME/sprintai-ordering"
READINESS="$REPO/docs/specs/2026-09-03-READINESS.md"
STATE_DIR="$HOME/.openclaw-sprintai/state"
STATE_FILE="$STATE_DIR/build-status-publish.json"
LOCK_DIR="$STATE_DIR/build-status-publish.lock"
LOG="$HOME/.openclaw-sprintai/logs/build-status-publish.log"

mkdir -p "$STATE_DIR" "$(dirname "$LOG")"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

# Avoid overlapping runs (5-min tick can race the post-commit hook).
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(ts) SKIP — already running (lock held)" >> "$LOG"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

if [ -f "$HOME/.openclaw-sprintai/.secrets" ]; then
  source "$HOME/.openclaw-sprintai/.secrets"
elif [ -f "$HOME/.openclaw/.secrets" ]; then
  source "$HOME/.openclaw/.secrets"
else
  echo "$(ts) FATAL — no secrets file found" >> "$LOG"
  exit 1
fi
export SPRINTAI_CHAT_SUPABASE_URL SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY \
  SPRINTAI_CHAT_SUPABASE_PROJECT_REF SUPABASE_ACCESS_TOKEN

if [ ! -f "$READINESS" ]; then
  echo "$(ts) FATAL — readiness board not found at $READINESS" >> "$LOG"
  exit 1
fi

HEAD_SHA=$(git -C "$REPO" rev-parse HEAD 2>/dev/null)
if [ -z "$HEAD_SHA" ]; then
  echo "$(ts) FATAL — git rev-parse HEAD failed" >> "$LOG"
  exit 1
fi

MTIME_EPOCH=$(stat -f %m "$READINESS" 2>/dev/null)
if [ -z "$MTIME_EPOCH" ]; then
  echo "$(ts) FATAL — stat on READINESS.md failed" >> "$LOG"
  exit 1
fi
READINESS_MTIME_ISO=$(python3 -c "
import datetime, sys
print(datetime.datetime.utcfromtimestamp(int(sys.argv[1])).isoformat() + 'Z')
" "$MTIME_EPOCH")

# "Shipped today" is only correct if the commit list gets recomputed across a
# midnight rollover even when nothing else changed — otherwise a quiet
# morning would keep showing yesterday's commits forever.
TODAY_ET=$(TZ=America/New_York date +%Y-%m-%d)

LAST_HEAD=""
LAST_MTIME=""
LAST_OK="false"
LAST_DATE=""
if [ -f "$STATE_FILE" ]; then
  read -r LAST_HEAD LAST_MTIME LAST_OK LAST_DATE < <(python3 -c "
import json
try:
    d = json.load(open('$STATE_FILE'))
except Exception:
    d = {}
print(d.get('head_sha', ''), d.get('readiness_mtime', ''), str(bool(d.get('ok', False))).lower(), d.get('date_et', ''))
")
fi

# Shell-first no-op: only skip the expensive path if the LAST run succeeded,
# the ET calendar date hasn't rolled over, AND nothing else has changed. A
# prior failure always gets retried in full — never mask a broken publisher
# by heartbeating over it.
if [ -n "$LAST_HEAD" ] && [ "$HEAD_SHA" = "$LAST_HEAD" ] && \
   [ "$READINESS_MTIME_ISO" = "$LAST_MTIME" ] && [ "$LAST_OK" = "true" ] && \
   [ "$TODAY_ET" = "$LAST_DATE" ]; then
  python3 "$REPO/scripts/publish-build-status.py" --heartbeat "$HEAD_SHA" "$READINESS_MTIME_ISO" >> "$LOG" 2>&1
  STATUS=$?
else
  python3 "$REPO/scripts/publish-build-status.py" "$HEAD_SHA" "$READINESS_MTIME_ISO" >> "$LOG" 2>&1
  STATUS=$?
fi

if [ $STATUS -eq 0 ]; then OK_STR="true"; else OK_STR="false"; fi
python3 -c "
import json, sys
head_sha, mtime, ok, date_et, path = sys.argv[1:6]
json.dump({'head_sha': head_sha, 'readiness_mtime': mtime, 'ok': ok == 'true', 'date_et': date_et}, open(path, 'w'))
" "$HEAD_SHA" "$READINESS_MTIME_ISO" "$OK_STR" "$TODAY_ET" "$STATE_FILE"

exit $STATUS
