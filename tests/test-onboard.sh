#!/usr/bin/env bash
# test-onboard.sh — Smoke-test the onboard-tenant edge function
# Usage: bash tests/test-onboard.sh
# Requires env vars from ~/.openclaw/.secrets

set -euo pipefail

# ── Load secrets ─────────────────────────────────────────────────────────────
SECRETS_FILE="$HOME/.openclaw/.secrets"
if [[ -f "$SECRETS_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
else
  echo "ERROR: ~/.openclaw/.secrets not found" >&2
  exit 1
fi

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL="${SPRINTAI_CHAT_SUPABASE_URL:?missing SPRINTAI_CHAT_SUPABASE_URL}"
SERVICE_KEY="${SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY:?missing SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY}"
PROJECT_REF="${SPRINTAI_CHAT_SUPABASE_PROJECT_REF:?missing SPRINTAI_CHAT_SUPABASE_PROJECT_REF}"

# Test tenant + website
TENANT_ID="50ec702d-3dd1-4027-b843-f2fae2b7eb9a"
TEST_URL="https://getsprintai.com"

# Edge function URL (deployed)
EDGE_URL="https://${PROJECT_REF}.supabase.co/functions/v1/onboard-tenant"

echo "======================================================"
echo "  SprintAI onboard-tenant smoke test"
echo "======================================================"
echo "  Endpoint : $EDGE_URL"
echo "  Tenant   : $TENANT_ID"
echo "  Website  : $TEST_URL"
echo "  Timestamp: $(date)"
echo "======================================================"
echo ""

# ── Step 1: Pre-test — clear existing knowledge base rows ─────────────────────
echo "▶ Step 1: Clearing existing knowledge_base rows for tenant..."
DELETE_RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X DELETE \
  "${SUPABASE_URL}/rest/v1/knowledge_base?tenant_id=eq.${TENANT_ID}&source=eq.website_scrape" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "Prefer: return=minimal")
DELETE_STATUS=$(echo "$DELETE_RESP" | grep "HTTP_STATUS" | cut -d: -f2)
echo "   Delete status: $DELETE_STATUS"
echo ""

# ── Step 2: Call the onboard-tenant endpoint ──────────────────────────────────
echo "▶ Step 2: Calling onboard-tenant endpoint (this may take 30-60 seconds)..."
echo "   POST $EDGE_URL"
echo ""

START_TIME=$(date +%s)

RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST "$EDGE_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  --max-time 120 \
  -d "{
    \"tenant_id\": \"${TENANT_ID}\",
    \"website_url\": \"${TEST_URL}\",
    \"force\": true
  }")

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | grep -v "HTTP_STATUS")

echo "   HTTP Status : $HTTP_STATUS"
echo "   Elapsed     : ${ELAPSED}s"
echo ""
echo "   Response body:"
echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
echo ""

# ── Step 3: Check success ─────────────────────────────────────────────────────
echo "▶ Step 3: Checking response..."
if echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('success')==True" 2>/dev/null; then
  echo "   ✅ success=true"
else
  echo "   ❌ success not true — check response above"
fi

PAGES=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('pages_scraped','?'))" 2>/dev/null)
CHUNKS=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('chunks_generated','?'))" 2>/dev/null)
STORED=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('embeddings_stored','?'))" 2>/dev/null)

echo "   Pages scraped    : $PAGES"
echo "   Chunks generated : $CHUNKS"
echo "   Embeddings stored: $STORED"
echo ""

# ── Step 4: Query knowledge_base to verify stored chunks ─────────────────────
echo "▶ Step 4: Querying knowledge_base to count stored chunks..."
KB_RESP=$(curl -s \
  "${SUPABASE_URL}/rest/v1/knowledge_base?tenant_id=eq.${TENANT_ID}&source=eq.website_scrape&select=id" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "Prefer: count=exact" \
  -I 2>&1 | grep -i "content-range" || true)

# Count via select all (simpler)
KB_COUNT_RESP=$(curl -s \
  "${SUPABASE_URL}/rest/v1/knowledge_base?tenant_id=eq.${TENANT_ID}&source=eq.website_scrape&select=id" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}")
KB_COUNT=$(echo "$KB_COUNT_RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")

echo "   Chunks in DB     : $KB_COUNT"
echo ""

# ── Step 5: Check onboarding_status in tenants table ─────────────────────────
echo "▶ Step 5: Checking tenant onboarding_status..."
TENANT_RESP=$(curl -s \
  "${SUPABASE_URL}/rest/v1/tenants?id=eq.${TENANT_ID}&select=onboarding_status,onboarding_error" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}")
TENANT_STATUS=$(echo "$TENANT_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0].get('onboarding_status','?'))" 2>/dev/null)
echo "   onboarding_status: $TENANT_STATUS"
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo "======================================================"
echo "  SUMMARY"
echo "======================================================"
if [[ "$HTTP_STATUS" == "200" ]] && [[ "$TENANT_STATUS" == "complete" ]]; then
  echo "  ✅ PASS — onboard-tenant completed successfully"
  echo "     Pages: $PAGES | Chunks: $CHUNKS | DB rows: $KB_COUNT | Time: ${ELAPSED}s"
else
  echo "  ❌ FAIL — HTTP $HTTP_STATUS, status=$TENANT_STATUS"
  echo "     Check edge function logs: supabase functions logs onboard-tenant --project-ref $PROJECT_REF"
fi
echo "======================================================"
echo ""
echo "To view function logs:"
echo "  supabase functions logs onboard-tenant --project-ref $PROJECT_REF"
echo ""
echo "To manually inspect knowledge_base:"
echo "  curl -s '${SUPABASE_URL}/rest/v1/knowledge_base?tenant_id=eq.${TENANT_ID}&select=id,content,metadata&limit=3' \\"
echo "    -H 'apikey: \$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY' \\"
echo "    -H 'Authorization: Bearer \$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY' | python3 -m json.tool"
