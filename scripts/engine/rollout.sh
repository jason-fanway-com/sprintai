#!/bin/bash
# rollout.sh — deploy the current checkout, prove the stamp, optionally flip shops, run acceptance.
# usage: rollout.sh [--flip "<uuid>,<uuid>"] [--sets "vitos njb zio"] [--no-deploy]
export PATH=/opt/homebrew/bin:$PATH
set -a; . ~/.openclaw-sprintai/.secrets; set +a
K="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY"; U="$SPRINTAI_CHAT_SUPABASE_URL"
cd "$(dirname "$0")/../.."
FLIP=""; SETS="vitos njb zio"; DEPLOY=1; ALSO=""
while [ $# -gt 0 ]; do case "$1" in --flip) FLIP="$2"; shift 2;; --sets) SETS="$2"; shift 2;; --no-deploy) DEPLOY=0; shift;; --also) ALSO="$2"; shift 2;; *) shift;; esac; done
shop_id() { case "$1" in vitos) echo e0000000-0000-0000-0000-000000000001;; njb) echo b0000000-0000-0000-0000-000000000001;; zio) echo 2cba7b51-211c-4437-8910-1af4dcc03498;; *) echo "unknown set $1" >&2; exit 1;; esac; }
if [ "$DEPLOY" = 1 ]; then
  echo "=== $(date +%T) deploy $(git rev-parse --short HEAD) ==="
  touch ~/po-scratch/.po-deploy-token
  ./scripts/deploy-function.sh chat-sms 2>&1 | sed "s/\x1b\[[0-9;]*m//g" | grep -E "VERDICT|FAIL|Stamp confirmed|Version moved"
  D=$(mktemp -d); (cd $D && supabase functions download chat-sms --project-ref rvdqfxtrskxekfkqnegx >/dev/null 2>&1); LIVE=$(grep -m1 -o "DEPLOY_SHA: [0-9a-f]*" $D/supabase/functions/chat-sms/index.ts); rm -rf $D
  echo "live: $LIVE ; head: $(git rev-parse HEAD)"
  if ! echo "$LIVE" | grep -q "$(git rev-parse HEAD)"; then echo "ABORT: live stamp does not match HEAD"; exit 1; fi
  for fn in $ALSO; do
    echo "=== $(date +%T) deploy $fn ==="
    touch ~/po-scratch/.po-deploy-token
    ./scripts/deploy-function.sh "$fn" 2>&1 | sed "s/\x1b\[[0-9;]*m//g" | grep -E "VERDICT|FAIL|Version moved"
  done
fi
if [ -n "$FLIP" ]; then
  echo "=== $(date +%T) flip $FLIP ==="
  curl -s -X PATCH "$U/rest/v1/shops?id=in.($FLIP)" -H "apikey: $K" -H "Authorization: Bearer $K" -H "Content-Type: application/json" -H "Prefer: return=representation" -d '{"clean_engine_enabled":true}' | python3 -c "import json,sys; [print('  ', r['name'], r['clean_engine_enabled']) for r in json.load(sys.stdin)]"
  sleep 15
fi
for name in $SETS; do
  echo "=== $(date +%T) e2e $name ==="
  python3 scripts/engine/e2e.py --shop "$(shop_id "$name")" --runs 5 --scenario "$name" --verbose 2>&1 | grep -E "^\[|passed|!!|    [CB]: "
done
echo "=== $(date +%T) ROLLOUT DONE ==="
