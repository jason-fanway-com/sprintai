#!/bin/bash
# run-worker.sh — launchd entrypoint for the test-run worker.
# launchd does not inherit the shell environment, so source the secrets vault
# (chmod 600) here and export only what worker.ts needs, then exec deno.
set -euo pipefail

# shellcheck disable=SC1091
source "$HOME/.openclaw/.secrets"

export SPRINTAI_CHAT_SUPABASE_URL
export SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY
export ANTHROPIC_API_KEY
export WORKER_POLL_INTERVAL="${WORKER_POLL_INTERVAL:-15}"

cd "$HOME/sprintai-ordering/scripts/test-suite"
exec /opt/homebrew/bin/deno run --allow-net --allow-env --allow-read --allow-write worker.ts
