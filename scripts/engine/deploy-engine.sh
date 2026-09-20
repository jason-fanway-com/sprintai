#!/bin/bash
# deploy-engine.sh — PO-run. Deploys engine-eval then chat-sms from the current
# checkout using the repo's gated deploy script (type check, tests, stamp proof).
export PATH=/opt/homebrew/bin:$PATH
set -a; . ~/.openclaw-sprintai/.secrets; set +a
cd "$(dirname "$0")/../.."
LOG=~/po-scratch/deploy-engine.log
{
  echo "=== $(date) HEAD $(git rev-parse --short HEAD) deploy engine-eval ==="
  touch ~/po-scratch/.po-deploy-token
  ./scripts/deploy-function.sh engine-eval 2>&1 | tail -25
  echo "=== $(date) deploy chat-sms ==="
  touch ~/po-scratch/.po-deploy-token
  ./scripts/deploy-function.sh chat-sms 2>&1 | tail -40
  echo "=== $(date) done ==="
} | tee "$LOG"
