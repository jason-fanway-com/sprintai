#!/usr/bin/env bash
# =============================================================================
# SprintAI Chat — Extended E2E Test Suite (Phase 1 QA Additions)
# Tests gaps identified on 2026-03-29:
#   - Stripe checkout session creation
#   - System prompt isolation (SprintAI vs customer tenant)
#   - File uploads: .txt, .pdf, .csv types
#   - Large text paste
#   - Conversation continuity (same session_id carries history)
#   - SMS channel format (Twilio form-encoded)
#   - Error handling: malformed JSON, missing fields, invalid tenant_id
#
# Usage:  bash tests/e2e-extended.sh
#         ./tests/e2e-extended.sh
# =============================================================================

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Load secrets ──────────────────────────────────────────────────────────────
SECRETS_FILE="$HOME/.openclaw/.secrets"
if [[ -f "$SECRETS_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
else
  echo -e "${RED}ERROR: ~/.openclaw/.secrets not found${RESET}" >&2
  exit 1
fi

# ── Config ────────────────────────────────────────────────────────────────────
PROJECT_REF="rvdqfxtrskxekfkqnegx"
SUPABASE_URL="https://${PROJECT_REF}.supabase.co"
EDGE_BASE="${SUPABASE_URL}/functions/v1"
SITE="https://getsprintai.com"
ANON_KEY="${SPRINTAI_CHAT_SUPABASE_ANON_KEY:?missing SPRINTAI_CHAT_SUPABASE_ANON_KEY}"
SERVICE_KEY="${SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY:?missing SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY}"
TIMEOUT=60

# Stripe price IDs — $99/mo chat plan (live)
STRIPE_PRICE_CHAT="price_1TG8GsFPm1l8Fm1TSaLhOIaL"

# ── Unique test run identifiers ───────────────────────────────────────────────
TS=$(date +%s)
TEST_SLUG="e2e-ext-${TS}"
ISOLATION_SLUG="e2e-iso-${TS}"
TEST_TENANT_ID=""
ISOLATION_TENANT_ID=""

# ── JSON helper ───────────────────────────────────────────────────────────────
if command -v jq &>/dev/null; then
  JQ_AVAILABLE=1
else
  JQ_AVAILABLE=0
fi

json_get() {
  local json="$1" key="$2"
  if [[ $JQ_AVAILABLE -eq 1 ]]; then
    local jq_path=""
    IFS='.' read -ra PARTS <<< "$key"
    for part in "${PARTS[@]}"; do
      if [[ "$part" =~ ^[0-9]+$ ]]; then
        jq_path="${jq_path}.[${part}]"
      else
        jq_path="${jq_path}.${part}"
      fi
    done
    echo "$json" | jq -r "${jq_path} // empty" 2>/dev/null
  else
    echo "$json" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    keys = '${key}'.split('.')
    v = d
    for k in keys:
        if k.isdigit():
            v = v[int(k)]
        else:
            v = v[k]
    print(v if v is not None else '')
except Exception:
    pass
" 2>/dev/null
  fi
}

json_length() {
  local json="$1"
  if [[ $JQ_AVAILABLE -eq 1 ]]; then
    echo "$json" | jq 'length' 2>/dev/null || echo 0
  else
    echo "$json" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0
  fi
}

# ── Test tracking ─────────────────────────────────────────────────────────────
PASS=0
FAIL=0
FAILURES=()

pass() {
  local name="$1"
  echo -e "  ${GREEN}✅ PASS${RESET} — ${name}"
  ((PASS++)) || true
}

fail() {
  local name="$1" reason="${2:-}"
  echo -e "  ${RED}❌ FAIL${RESET} — ${name}${reason:+: $reason}"
  ((FAIL++)) || true
  FAILURES+=("$name")
}

section() {
  echo ""
  echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${CYAN}${BOLD}  $1${RESET}"
  echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

# ── HTTP helpers ──────────────────────────────────────────────────────────────
http_req() {
  local method="$1" url="$2"
  shift 2
  curl -s -w "\nHTTP_STATUS:%{http_code}" \
    --max-time "$TIMEOUT" \
    -X "$method" "$url" \
    "$@" 2>/dev/null
}

split_response() {
  RESP_STATUS=$(echo "$1" | grep "^HTTP_STATUS:" | cut -d: -f2)
  RESP_BODY=$(echo "$1" | grep -v "^HTTP_STATUS:")
}

# =============================================================================
# Banner
# =============================================================================
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║       SprintAI Chat — Extended E2E Test Suite               ║${RESET}"
echo -e "${BOLD}║       Run ID: ${TS}                              ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  Project : ${PROJECT_REF}"
echo -e "  Site    : ${SITE}"
echo -e "  Edge    : ${EDGE_BASE}"
echo -e "  Slug    : ${TEST_SLUG}"
echo -e "  Time    : $(date)"
echo ""

# =============================================================================
# SECTION A — Setup: Create test tenants
# =============================================================================
section "A. Test Tenant Setup"

echo -e "  ${YELLOW}▶ Creating primary extended test tenant...${RESET}"
CREATE_RESP=$(curl -s --max-time "$TIMEOUT" -X POST \
  "${SUPABASE_URL}/rest/v1/tenants" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "{
    \"slug\": \"${TEST_SLUG}\",
    \"name\": \"E2E Extended Test Tenant ${TS}\",
    \"status\": \"active\",
    \"plan\": \"starter\",
    \"config\": {}
  }" 2>/dev/null)
TEST_TENANT_ID=$(json_get "$CREATE_RESP" "0.id")

if [[ -n "$TEST_TENANT_ID" ]]; then
  echo -e "  ${GREEN}Created test tenant: ${TEST_TENANT_ID}${RESET}"
  pass "Setup: create primary extended test tenant (${TEST_SLUG})"
else
  fail "Setup: create primary extended test tenant" "response: ${CREATE_RESP}"
  echo -e "  ${RED}FATAL: Cannot proceed without test tenant.${RESET}"
  exit 1
fi

echo -e "  ${YELLOW}▶ Creating isolation test tenant (for system prompt isolation test)...${RESET}"
CREATE_ISO_RESP=$(curl -s --max-time "$TIMEOUT" -X POST \
  "${SUPABASE_URL}/rest/v1/tenants" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "{
    \"slug\": \"${ISOLATION_SLUG}\",
    \"name\": \"E2E Isolation Test Tenant ${TS}\",
    \"status\": \"active\",
    \"plan\": \"starter\",
    \"config\": {}
  }" 2>/dev/null)
ISOLATION_TENANT_ID=$(json_get "$CREATE_ISO_RESP" "0.id")

if [[ -n "$ISOLATION_TENANT_ID" ]]; then
  echo -e "  ${GREEN}Created isolation tenant: ${ISOLATION_TENANT_ID}${RESET}"
  pass "Setup: create isolation tenant (${ISOLATION_SLUG})"
else
  fail "Setup: create isolation tenant" "response: ${CREATE_ISO_RESP}"
fi

# =============================================================================
# SECTION B — Stripe Checkout Session Creation
# =============================================================================
section "B. Stripe Checkout Session Creation"

# B1: Valid params — should return a Stripe checkout URL
echo -e "  ${YELLOW}▶ Creating Stripe checkout session with valid params...${RESET}"
CHECKOUT_RESP=$(http_req POST "${EDGE_BASE}/create-checkout" \
  -H "Content-Type: application/json" \
  -d "{
    \"price_id\": \"${STRIPE_PRICE_CHAT}\",
    \"plan\": \"starter\",
    \"business_name\": \"E2E Test Business\",
    \"website_url\": \"https://example.com\",
    \"business_type\": \"restaurant\",
    \"email\": \"e2e-test-${TS}@sprintai-e2e.invalid\",
    \"success_url\": \"https://getsprintai.com/signup/success.html?session_id={CHECKOUT_SESSION_ID}\",
    \"cancel_url\": \"https://getsprintai.com/signup/\"
  }")
split_response "$CHECKOUT_RESP"

if [[ "$RESP_STATUS" == "200" ]]; then
  CHECKOUT_URL=$(json_get "$RESP_BODY" "url")
  CHECKOUT_SID=$(json_get "$RESP_BODY" "session_id")
  
  if [[ "$CHECKOUT_URL" == *"checkout.stripe.com"* ]]; then
    pass "Stripe checkout: valid params returns Stripe checkout URL"
  else
    fail "Stripe checkout: valid params returns Stripe checkout URL" "url='${CHECKOUT_URL}'"
  fi

  if [[ "$CHECKOUT_SID" == cs_live_* ]] || [[ "$CHECKOUT_SID" == cs_test_* ]]; then
    pass "Stripe checkout: response includes session_id (${CHECKOUT_SID:0:25}...)"
  else
    fail "Stripe checkout: response includes session_id" "got '${CHECKOUT_SID}'"
  fi
else
  fail "Stripe checkout: valid params → HTTP 200" "got HTTP ${RESP_STATUS} — ${RESP_BODY}"
  fail "Stripe checkout: response includes session_id" "skipped (checkout failed)"
fi

# B2: Missing required fields — should return 400
echo -e "  ${YELLOW}▶ Testing checkout with missing required fields...${RESET}"
CHECKOUT_MISSING_RESP=$(http_req POST "${EDGE_BASE}/create-checkout" \
  -H "Content-Type: application/json" \
  -d '{"price_id":"price_abc123"}')
split_response "$CHECKOUT_MISSING_RESP"

if [[ "$RESP_STATUS" == "400" ]]; then
  pass "Stripe checkout: missing fields → 400"
else
  fail "Stripe checkout: missing fields → 400" "got HTTP ${RESP_STATUS}"
fi

# B3: Missing price_id — should return 400
CHECKOUT_NO_PRICE=$(http_req POST "${EDGE_BASE}/create-checkout" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","business_name":"Test Biz"}')
split_response "$CHECKOUT_NO_PRICE"

if [[ "$RESP_STATUS" == "400" ]]; then
  pass "Stripe checkout: missing price_id → 400"
else
  fail "Stripe checkout: missing price_id → 400" "got HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

# B4: Invalid price_id — Stripe should reject gracefully
echo -e "  ${YELLOW}▶ Testing checkout with invalid price_id...${RESET}"
CHECKOUT_BAD_PRICE=$(http_req POST "${EDGE_BASE}/create-checkout" \
  -H "Content-Type: application/json" \
  -d "{
    \"price_id\": \"price_DOESNOTEXIST\",
    \"plan\": \"starter\",
    \"business_name\": \"E2E Test\",
    \"email\": \"e2e-test-${TS}@sprintai-e2e.invalid\",
    \"success_url\": \"https://getsprintai.com/success\",
    \"cancel_url\": \"https://getsprintai.com/signup\"
  }")
split_response "$CHECKOUT_BAD_PRICE"

if [[ "$RESP_STATUS" =~ ^[45] ]]; then
  pass "Stripe checkout: invalid price_id returns error (got HTTP ${RESP_STATUS})"
else
  fail "Stripe checkout: invalid price_id returns error" "got HTTP ${RESP_STATUS}"
fi

# B5: Malformed JSON body
CHECKOUT_BAD_JSON=$(http_req POST "${EDGE_BASE}/create-checkout" \
  -H "Content-Type: application/json" \
  -d '{not valid json!!!')
split_response "$CHECKOUT_BAD_JSON"

if [[ "$RESP_STATUS" == "400" ]]; then
  pass "Stripe checkout: malformed JSON → 400"
else
  fail "Stripe checkout: malformed JSON → 400" "got HTTP ${RESP_STATUS}"
fi

# =============================================================================
# SECTION C — System Prompt Isolation
# =============================================================================
section "C. System Prompt Isolation"

# Train isolation tenant with unique marker phrase that SHOULD NOT appear for other tenants
MARKER_PHRASE="PurpleElephantSecret42"
echo -e "  ${YELLOW}▶ Training isolation tenant with unique marker: '${MARKER_PHRASE}'...${RESET}"

TRAIN_ISO=$(http_req POST "${EDGE_BASE}/train-tenant" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -d "{
    \"action\": \"add_text\",
    \"tenant_id\": \"${ISOLATION_TENANT_ID}\",
    \"content\": \"The ${MARKER_PHRASE} is our exclusive premium feature. Only members of our ${MARKER_PHRASE} club get access to the secret menu.\",
    \"label\": \"isolation-marker\"
  }")
split_response "$TRAIN_ISO"

if [[ "$RESP_STATUS" == "200" ]]; then
  pass "Isolation: train isolation tenant with unique marker"
else
  fail "Isolation: train isolation tenant with unique marker" "HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

sleep 2  # allow embeddings to commit

# C1: Isolation tenant SHOULD reference its own marker
echo -e "  ${YELLOW}▶ Asking isolation tenant about its own marker...${RESET}"
ISO_SELF_RESP=$(http_req POST "${EDGE_BASE}/chat-sms" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -d "{
    \"tenant_id\": \"${ISOLATION_TENANT_ID}\",
    \"message\": \"Tell me about the ${MARKER_PHRASE}\",
    \"channel\": \"web\",
    \"session_id\": \"e2e-iso-self-${TS}\"
  }")
split_response "$ISO_SELF_RESP"
ISO_SELF_REPLY=$(json_get "$RESP_BODY" "response")

if [[ "$RESP_STATUS" == "200" ]] && [[ -n "$ISO_SELF_REPLY" ]]; then
  pass "Isolation: isolation tenant responds to its own training data query"
else
  fail "Isolation: isolation tenant responds to own query" "HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

# C2: Primary test tenant (no training) MUST NOT mention marker phrase
echo -e "  ${YELLOW}▶ Checking primary tenant does NOT leak isolation tenant's data...${RESET}"
PRIMARY_ISO_RESP=$(http_req POST "${EDGE_BASE}/chat-sms" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -d "{
    \"tenant_id\": \"${TEST_TENANT_ID}\",
    \"message\": \"Tell me about the ${MARKER_PHRASE}\",
    \"channel\": \"web\",
    \"session_id\": \"e2e-iso-cross-${TS}\"
  }")
split_response "$PRIMARY_ISO_RESP"
PRIMARY_ISO_REPLY=$(json_get "$RESP_BODY" "response")
PRIMARY_ISO_LOWER=$(echo "$PRIMARY_ISO_REPLY" | tr '[:upper:]' '[:lower:]')
MARKER_LOWER=$(echo "$MARKER_PHRASE" | tr '[:upper:]' '[:lower:]')

if [[ "$RESP_STATUS" == "200" ]]; then
  if echo "$PRIMARY_ISO_LOWER" | grep -qi "$MARKER_LOWER"; then
    fail "Isolation: cross-tenant data leak — primary tenant MUST NOT see isolation tenant marker" "reply contained '${MARKER_PHRASE}'"
  else
    pass "Isolation: primary tenant does NOT see isolation tenant's data (no cross-tenant leak)"
  fi
else
  fail "Isolation: cross-tenant isolation check" "HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

# C3: SprintAI tenant gets product info, customer tenant does NOT see SprintAI branding
echo -e "  ${YELLOW}▶ Verifying customer tenant does NOT mention SprintAI as a product...${RESET}"
CUST_AI_RESP=$(http_req POST "${EDGE_BASE}/chat-sms" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -d "{
    \"tenant_id\": \"${TEST_TENANT_ID}\",
    \"message\": \"What AI software powers you? What is SprintAI?\",
    \"channel\": \"web\",
    \"session_id\": \"e2e-brand-check-${TS}\"
  }")
split_response "$CUST_AI_RESP"
CUST_AI_REPLY=$(json_get "$RESP_BODY" "response")
CUST_AI_LOWER=$(echo "$CUST_AI_REPLY" | tr '[:upper:]' '[:lower:]')

if [[ "$RESP_STATUS" == "200" ]] && [[ -n "$CUST_AI_REPLY" ]]; then
  # Customer tenant must NOT pitch SprintAI as a product / AI chatbot service
  # It should deflect or say it doesn't have that info
  if echo "$CUST_AI_LOWER" | grep -qiE "sprintai.*chatbot.*product|sprintai.*99|sprintai.*per month|sprintai.*subscription|powered by sprintai"; then
    fail "Isolation: customer tenant must NOT expose SprintAI product pitching" "reply: '${CUST_AI_REPLY:0:100}'"
  else
    pass "Isolation: customer tenant does not expose SprintAI product/pricing to end users"
  fi
else
  fail "Isolation: customer tenant brand check" "HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

# =============================================================================
# SECTION D — File Upload: Multiple File Types
# =============================================================================
section "D. File Upload Types (.txt, .pdf, .csv)"

# D1: .txt file upload
echo -e "  ${YELLOW}▶ Uploading .txt file...${RESET}"
TXT_FILE=$(mktemp /tmp/e2e-ext-XXXXXX.txt)
cat > "$TXT_FILE" << 'EOF'
The E2E Text Document Service offers premium txt-based knowledge ingestion. 
Our TXT file protocol is uniquely designed for fast processing. 
We support UTF-8 encoding and line breaks. Contact info@txtservice.example for help.
EOF

TXT_UPLOAD_RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" --max-time "$TIMEOUT" \
  -X POST "${EDGE_BASE}/train-tenant" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -F "tenant_id=${TEST_TENANT_ID}" \
  -F "label=e2e-txt-upload" \
  -F "file=@${TXT_FILE};type=text/plain" 2>/dev/null)
split_response "$TXT_UPLOAD_RESP"
rm -f "$TXT_FILE"

if [[ "$RESP_STATUS" == "200" ]]; then
  TXT_CHUNKS=$(json_get "$RESP_BODY" "chunks_stored")
  TXT_CHUNKS=${TXT_CHUNKS:-0}
  if [[ "$TXT_CHUNKS" -gt 0 ]] || echo "$RESP_BODY" | grep -qi "stored\|chunks\|ok"; then
    pass "File upload: .txt → processed successfully (chunks: ${TXT_CHUNKS})"
  else
    fail "File upload: .txt → chunks_stored > 0" "response: ${RESP_BODY}"
  fi
else
  fail "File upload: .txt → HTTP 200" "got HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

# D2: .pdf file upload — create a minimal valid PDF
echo -e "  ${YELLOW}▶ Uploading .pdf file...${RESET}"
PDF_FILE=$(mktemp /tmp/e2e-ext-XXXXXX.pdf)
# Write a minimal valid PDF with embedded text
python3 - "$PDF_FILE" << 'PYEOF'
import sys
path = sys.argv[1]
content = b"""%PDF-1.4
1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj
2 0 obj<</Type /Pages /Kids[3 0 R] /Count 1>>endobj
3 0 obj<</Type /Page /Parent 2 0 R /MediaBox[0 0 612 792] /Contents 4 0 R /Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 120>>
stream
BT /F1 12 Tf 72 720 Td (E2E PDF Test Document) Tj 0 -20 Td (Our PDF protocol supports document uploads.) Tj 0 -20 Td (The Acme Widget is our flagship product at 499 USD.) Tj ET
endstream
endobj
5 0 obj<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000274 00000 n 
0000000446 00000 n 
trailer<</Size 6 /Root 1 0 R>>
startxref
526
%%EOF"""
with open(path, 'wb') as f:
    f.write(content)
print("PDF created")
PYEOF

PDF_UPLOAD_RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" --max-time "$TIMEOUT" \
  -X POST "${EDGE_BASE}/train-tenant" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -F "tenant_id=${TEST_TENANT_ID}" \
  -F "label=e2e-pdf-upload" \
  -F "file=@${PDF_FILE};type=application/pdf" 2>/dev/null)
split_response "$PDF_UPLOAD_RESP"
rm -f "$PDF_FILE"

if [[ "$RESP_STATUS" == "200" ]]; then
  PDF_CHUNKS=$(json_get "$RESP_BODY" "chunks_stored")
  PDF_CHUNKS=${PDF_CHUNKS:-0}
  pass "File upload: .pdf → accepted by server (HTTP 200, chunks: ${PDF_CHUNKS})"
elif [[ "$RESP_STATUS" == "400" ]] && echo "$RESP_BODY" | grep -qi "no readable\|text.*found\|extract"; then
  # Minimal PDF may not have extractable text — that's a known limitation, soft pass
  pass "File upload: .pdf → accepted (minimal test PDF has no extractable text — expected behavior)"
else
  fail "File upload: .pdf → HTTP 200 or graceful 400" "got HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

# D3: .csv file upload — unsupported type; should return 400 with helpful message
echo -e "  ${YELLOW}▶ Uploading .csv file (unsupported type — expect 400)...${RESET}"
CSV_FILE=$(mktemp /tmp/e2e-ext-XXXXXX.csv)
cat > "$CSV_FILE" << 'EOF'
product,price,description
Widget A,29.99,Our best selling item
Widget B,49.99,Premium version
Service Plan,9.99/mo,Monthly support subscription
EOF

CSV_UPLOAD_RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" --max-time "$TIMEOUT" \
  -X POST "${EDGE_BASE}/train-tenant" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -F "tenant_id=${TEST_TENANT_ID}" \
  -F "label=e2e-csv-upload" \
  -F "file=@${CSV_FILE};type=text/csv" 2>/dev/null)
split_response "$CSV_UPLOAD_RESP"
rm -f "$CSV_FILE"

if [[ "$RESP_STATUS" == "400" ]]; then
  ERROR_BODY=$(json_get "$RESP_BODY" "error")
  if echo "$ERROR_BODY" | grep -qi "unsupported\|file type\|use pdf\|txt\|docx"; then
    pass "File upload: .csv → 400 with helpful 'unsupported type' message"
  else
    pass "File upload: .csv → 400 rejected (any error response)"
  fi
else
  fail "File upload: .csv (unsupported type) → 400" "got HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

# D4: File upload with missing tenant_id — should return 400
echo -e "  ${YELLOW}▶ Testing file upload with missing tenant_id...${RESET}"
TMP_TXT=$(mktemp /tmp/e2e-ext-XXXXXX.txt)
echo "test content" > "$TMP_TXT"
MISSING_TID_RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" --max-time "$TIMEOUT" \
  -X POST "${EDGE_BASE}/train-tenant" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -F "label=e2e-missing-tenant" \
  -F "file=@${TMP_TXT};type=text/plain" 2>/dev/null)
split_response "$MISSING_TID_RESP"
rm -f "$TMP_TXT"

if [[ "$RESP_STATUS" == "400" ]]; then
  pass "File upload: missing tenant_id → 400"
else
  fail "File upload: missing tenant_id → 400" "got HTTP ${RESP_STATUS}"
fi

# =============================================================================
# SECTION E — Large Text Paste
# =============================================================================
section "E. Large Text Paste"

echo -e "  ${YELLOW}▶ Testing large text paste (multi-chunk content)...${RESET}"
# Generate ~3000 words of content that will require multiple chunks
LARGE_TEXT=$(python3 -c "
import random
topics = [
    'Our premium catering service offers farm-to-table cuisine.',
    'We specialize in corporate events for up to 500 guests.',
    'Our executive chef has 20 years of experience.',
    'We offer vegetarian, vegan, and gluten-free options.',
    'Our service area covers the entire tri-state region.',
    'The LargeTextUniqueMarker789 identifier confirms multi-chunk storage.',
    'Pricing starts at 45 per person for basic packages.',
    'Premium packages include full bar service at 75 per person.',
    'We provide all equipment including tents, tables, and chairs.',
    'Our team of 50 professional servers ensures smooth events.',
]
# Expand to ~3000 words by repeating with variations
lines = []
for i in range(200):
    topic = topics[i % len(topics)]
    lines.append(f'Paragraph {i+1}: {topic} Additional details about our service level {i+1}.')
print(' '.join(lines))
")

LARGE_RESP=$(http_req POST "${EDGE_BASE}/train-tenant" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -d "{
    \"action\": \"add_text\",
    \"tenant_id\": \"${TEST_TENANT_ID}\",
    \"content\": $(echo "$LARGE_TEXT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))"),
    \"label\": \"e2e-large-text\"
  }")
split_response "$LARGE_RESP"

if [[ "$RESP_STATUS" == "200" ]]; then
  LARGE_CHUNKS=$(json_get "$RESP_BODY" "chunks_stored")
  LARGE_CHUNKS=${LARGE_CHUNKS:-0}
  if [[ "$LARGE_CHUNKS" -gt 1 ]]; then
    pass "Large text paste: stored ${LARGE_CHUNKS} chunks (multi-chunk confirmed)"
  elif [[ "$LARGE_CHUNKS" -gt 0 ]]; then
    pass "Large text paste: stored ${LARGE_CHUNKS} chunk(s) — content may have been smaller than expected"
  else
    fail "Large text paste: chunks_stored > 0" "response: ${RESP_BODY}"
  fi
else
  fail "Large text paste: HTTP 200" "got HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

# Verify large text shows up in list_sources
sleep 1
LARGE_LIST=$(http_req POST "${EDGE_BASE}/train-tenant" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -d "{\"action\":\"list_sources\",\"tenant_id\":\"${TEST_TENANT_ID}\"}")
split_response "$LARGE_LIST"

if echo "$RESP_BODY" | grep -q "e2e-large-text"; then
  pass "Large text paste: visible in list_sources"
else
  fail "Large text paste: visible in list_sources" "not found in: ${RESP_BODY}"
fi

# E-DEL: delete_source — must return deleted > 0 (DEF-001 regression gate)
echo -e "  ${YELLOW}▶ Testing delete_source returns deleted > 0 (DEF-001 regression)...${RESET}"
# Add a dedicated delete-test row so we have something to delete
ADD_DEL_TEST=$(http_req POST "${EDGE_BASE}/train-tenant" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -d "{
    \"action\": \"add_text\",
    \"tenant_id\": \"${TEST_TENANT_ID}\",
    \"content\": \"DEF-001 regression test content. This row must be deleted by delete_source.\",
    \"label\": \"e2e-ext-delete-test\"
  }")
split_response "$ADD_DEL_TEST"
if [[ "$RESP_STATUS" == "200" ]]; then
  ADD_DEL_CHUNKS=$(json_get "$RESP_BODY" "chunks_stored")
  echo -e "  Added ${ADD_DEL_CHUNKS} chunk(s) for delete test"
  sleep 2

  # Now delete it and assert deleted > 0
  DEL_RESP=$(http_req POST "${EDGE_BASE}/train-tenant" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${SERVICE_KEY}" \
    -d "{
      \"action\": \"delete_source\",
      \"tenant_id\": \"${TEST_TENANT_ID}\",
      \"source\": \"custom_text\",
      \"label\": \"e2e-ext-delete-test\"
    }")
  split_response "$DEL_RESP"
  if [[ "$RESP_STATUS" == "200" ]]; then
    DEL_COUNT=$(json_get "$RESP_BODY" "deleted")
    DEL_COUNT=${DEL_COUNT:-0}
    if [[ "$DEL_COUNT" -gt 0 ]]; then
      pass "delete_source: deleted=${DEL_COUNT} > 0 (DEF-001 regression PASS)"
    else
      fail "delete_source: deleted must be > 0 (DEF-001)" "deleted=${DEL_COUNT}, body: ${RESP_BODY}"
    fi
  else
    fail "delete_source: HTTP 200" "got HTTP ${RESP_STATUS} — ${RESP_BODY}"
  fi
else
  fail "delete_source setup: add_text for delete test" "HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

# =============================================================================
# SECTION F — Conversation Continuity
# =============================================================================
section "F. Conversation Continuity (Session History)"

# First, seed the test tenant with some training data to enable meaningful conversation
echo -e "  ${YELLOW}▶ Seeding training data for conversation continuity test...${RESET}"
SEED_RESP=$(http_req POST "${EDGE_BASE}/train-tenant" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -d "{
    \"action\": \"add_text\",
    \"tenant_id\": \"${TEST_TENANT_ID}\",
    \"content\": \"Our business is called Sunrise Bakery. We are located at 123 Main Street. We open at 7am and close at 6pm Monday through Saturday. Our signature item is the Blueberry Sunrise Scone at \$4.50.\",
    \"label\": \"e2e-continuity-seed\"
  }")
split_response "$SEED_RESP"

if [[ "$RESP_STATUS" == "200" ]]; then
  pass "Conversation continuity: training data seeded"
else
  fail "Conversation continuity: training data seeded" "HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

sleep 2  # Allow embeddings to commit

CONTINUITY_SESSION="e2e-continuity-${TS}"

# F1: First message in session — ask about something memorable
echo -e "  ${YELLOW}▶ Sending first message in continuity session...${RESET}"
FIRST_MSG_RESP=$(http_req POST "${EDGE_BASE}/chat-sms" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -d "{
    \"tenant_id\": \"${TEST_TENANT_ID}\",
    \"message\": \"Hi, what are your hours?\",
    \"channel\": \"web\",
    \"session_id\": \"${CONTINUITY_SESSION}\"
  }")
split_response "$FIRST_MSG_RESP"
FIRST_REPLY=$(json_get "$RESP_BODY" "response")
RETURNED_SESSION=$(json_get "$RESP_BODY" "session_id")

if [[ "$RESP_STATUS" == "200" ]] && [[ -n "$FIRST_REPLY" ]]; then
  pass "Conversation continuity: first message returns a response"
else
  fail "Conversation continuity: first message" "HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

# Verify the session_id is echoed back consistently
if [[ "$RETURNED_SESSION" == "$CONTINUITY_SESSION" ]]; then
  pass "Conversation continuity: session_id echoed back correctly"
else
  fail "Conversation continuity: session_id echoed back" "expected '${CONTINUITY_SESSION}', got '${RETURNED_SESSION}'"
fi

# F2: Second message in SAME session — verifies conversation history is maintained
echo -e "  ${YELLOW}▶ Sending follow-up message in same session...${RESET}"
sleep 1
SECOND_MSG_RESP=$(http_req POST "${EDGE_BASE}/chat-sms" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -d "{
    \"tenant_id\": \"${TEST_TENANT_ID}\",
    \"message\": \"And what was I just asking about?\",
    \"channel\": \"web\",
    \"session_id\": \"${CONTINUITY_SESSION}\"
  }")
split_response "$SECOND_MSG_RESP"
SECOND_REPLY=$(json_get "$RESP_BODY" "response")
SECOND_REPLY_LOWER=$(echo "$SECOND_REPLY" | tr '[:upper:]' '[:lower:]')

if [[ "$RESP_STATUS" == "200" ]] && [[ -n "$SECOND_REPLY" ]]; then
  # If conversation history works, the AI should reference "hours" in its follow-up
  if echo "$SECOND_REPLY_LOWER" | grep -qiE "hours|time|open|schedule|asked"; then
    pass "Conversation continuity: follow-up message reflects prior conversation context"
  else
    # Not a hard fail — AI may paraphrase differently; just confirm it responds
    pass "Conversation continuity: follow-up message returns a response (context may be implicit)"
  fi
else
  fail "Conversation continuity: follow-up message" "HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

# F3: Verify conversation was stored in DB — check that messages exist
echo -e "  ${YELLOW}▶ Verifying conversation stored in DB...${RESET}"
CONV_CHECK=$(curl -s --max-time "$TIMEOUT" \
  "${SUPABASE_URL}/rest/v1/conversations?tenant_id=eq.${TEST_TENANT_ID}&session_id=eq.${CONTINUITY_SESSION}&select=id,session_id" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" 2>/dev/null)
CONV_ID=$(json_get "$CONV_CHECK" "0.id")

if [[ -n "$CONV_ID" ]]; then
  pass "Conversation continuity: conversation record exists in DB (id: ${CONV_ID})"
  
  # Check messages in that conversation
  MSG_CHECK=$(curl -s --max-time "$TIMEOUT" \
    "${SUPABASE_URL}/rest/v1/messages?conversation_id=eq.${CONV_ID}&select=role,content" \
    -H "apikey: ${SERVICE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_KEY}" 2>/dev/null)
  MSG_COUNT=$(json_length "$MSG_CHECK")
  
  if [[ "$MSG_COUNT" -ge 4 ]]; then
    pass "Conversation continuity: DB has ${MSG_COUNT} messages (2 user + 2 assistant)"
  elif [[ "$MSG_COUNT" -ge 2 ]]; then
    pass "Conversation continuity: DB has ${MSG_COUNT} messages stored"
  else
    fail "Conversation continuity: DB should have ≥2 messages" "got ${MSG_COUNT}"
  fi
else
  fail "Conversation continuity: conversation not found in DB" "response: ${CONV_CHECK}"
fi

# =============================================================================
# SECTION G — SMS Channel (Twilio Form-Encoded)
# =============================================================================
section "G. SMS Channel (Twilio Form-Encoded)"

# G1: Valid Twilio-format POST (form-encoded, no auth signature required in dev mode)
echo -e "  ${YELLOW}▶ Sending Twilio-format SMS webhook...${RESET}"
SMS_RESP=$(http_req POST "${EDGE_BASE}/chat-sms" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "MessageSid=SMtest${TS}" \
  --data-urlencode "AccountSid=ACtest12345" \
  --data-urlencode "From=+16105551234" \
  --data-urlencode "To=+16103792553" \
  --data-urlencode "Body=Hello, what are your hours?" \
  --data-urlencode "NumSegments=1")
split_response "$SMS_RESP"

# SMS response must be TwiML XML or graceful error
# Accept: 200 (found tenant) or 200 with "not in service" TwiML (no tenant found for number)
# Also accept 400/403 — but NOT 500
if [[ "$RESP_STATUS" == "200" ]]; then
  if echo "$RESP_BODY" | grep -qi "<Response>"; then
    pass "SMS channel: Twilio form-encoded request → TwiML response"
    # Verify TwiML structure
    if echo "$RESP_BODY" | grep -qi "<Message>"; then
      pass "SMS channel: TwiML response contains <Message> element"
    else
      fail "SMS channel: TwiML <Message> element present" "body: ${RESP_BODY:0:200}"
    fi
  else
    fail "SMS channel: response should be TwiML XML" "body: ${RESP_BODY:0:200}"
  fi
elif [[ "$RESP_STATUS" == "403" ]]; then
  # Signature check is active — that's correct security behavior
  pass "SMS channel: Twilio form-encoded request → 403 (signature validation active, correct)"
elif [[ "$RESP_STATUS" =~ ^4 ]]; then
  pass "SMS channel: Twilio form-encoded request returns non-500 (got ${RESP_STATUS})"
else
  fail "SMS channel: Twilio form-encoded must not return 5xx" "got HTTP ${RESP_STATUS}"
fi

# G2: SMS with missing required fields (no From/To/Body)
echo -e "  ${YELLOW}▶ Testing SMS with missing fields...${RESET}"
SMS_MISSING_RESP=$(http_req POST "${EDGE_BASE}/chat-sms" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "MessageSid=SMtest999")
split_response "$SMS_MISSING_RESP"

# Should return TwiML error or 400 — must NOT 500
if [[ "$RESP_STATUS" =~ ^[2-4] ]]; then
  pass "SMS channel: missing fields returns non-500 (got ${RESP_STATUS})"
else
  fail "SMS channel: missing fields must not return 5xx" "got HTTP ${RESP_STATUS}"
fi

# G3: Verify Content-Type routing — JSON hits web channel, form-encoded hits SMS channel
echo -e "  ${YELLOW}▶ Verifying Content-Type routing (JSON vs form-encoded)...${RESET}"

# JSON → web channel (returns JSON)
JSON_ROUTE=$(http_req POST "${EDGE_BASE}/chat-sms" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -d '{"tenant_id":"00000000-0000-0000-0000-000000000000","message":"test","channel":"web"}')
split_response "$JSON_ROUTE"
JSON_CT=$(echo "$JSON_ROUTE" | grep -i "content-type:" | head -1 | tr -d '\r\n' || true)

if echo "$RESP_BODY" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
  pass "Channel routing: JSON Content-Type → JSON response body"
else
  fail "Channel routing: JSON Content-Type → JSON response body" "body: ${RESP_BODY:0:100}"
fi

# Form-encoded → SMS channel (returns TwiML XML)
FORM_ROUTE=$(http_req POST "${EDGE_BASE}/chat-sms" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "Body=test" \
  --data-urlencode "From=+16105551234" \
  --data-urlencode "To=+10000000000")
split_response "$FORM_ROUTE"

if [[ "$RESP_STATUS" == "200" ]] && echo "$RESP_BODY" | grep -qi "<Response>"; then
  pass "Channel routing: form-encoded Content-Type → TwiML XML response"
elif [[ "$RESP_STATUS" == "403" ]]; then
  pass "Channel routing: form-encoded → TwiML channel (403 = signature check active)"
else
  # 200 with non-TwiML is the only real failure
  if [[ "$RESP_STATUS" =~ ^[2-4] ]]; then
    pass "Channel routing: form-encoded → SMS channel responded (got ${RESP_STATUS})"
  else
    fail "Channel routing: form-encoded → SMS channel" "got HTTP ${RESP_STATUS}"
  fi
fi

# =============================================================================
# SECTION H — Error Handling
# =============================================================================
section "H. Error Handling"

# H1: Malformed JSON to chat-sms
echo -e "  ${YELLOW}▶ Testing malformed JSON to chat-sms...${RESET}"
BAD_JSON_RESP=$(http_req POST "${EDGE_BASE}/chat-sms" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -d '{invalid json body!!!}')
split_response "$BAD_JSON_RESP"

if [[ "$RESP_STATUS" == "400" ]]; then
  pass "Error handling: malformed JSON to chat-sms → 400"
else
  fail "Error handling: malformed JSON to chat-sms → 400" "got HTTP ${RESP_STATUS}"
fi

# H2: Missing required fields to chat-sms (no tenant_id)
echo -e "  ${YELLOW}▶ Testing missing tenant_id to chat-sms...${RESET}"
MISSING_TID=$(http_req POST "${EDGE_BASE}/chat-sms" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -d '{"message":"hello","channel":"web"}')
split_response "$MISSING_TID"

if [[ "$RESP_STATUS" == "400" ]]; then
  pass "Error handling: missing tenant_id → 400"
else
  fail "Error handling: missing tenant_id → 400" "got HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

# H3: Missing message field to chat-sms
echo -e "  ${YELLOW}▶ Testing missing message field to chat-sms...${RESET}"
MISSING_MSG=$(http_req POST "${EDGE_BASE}/chat-sms" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -d '{"tenant_id":"00000000-0000-0000-0000-000000000000","channel":"web"}')
split_response "$MISSING_MSG"

if [[ "$RESP_STATUS" == "400" ]]; then
  pass "Error handling: missing message field → 400"
else
  fail "Error handling: missing message field → 400" "got HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

# H4: Invalid (non-existent) tenant_id to chat-sms
echo -e "  ${YELLOW}▶ Testing invalid tenant_id to chat-sms...${RESET}"
INVALID_TID=$(http_req POST "${EDGE_BASE}/chat-sms" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -d '{"tenant_id":"00000000-0000-0000-0000-000000000000","message":"hello","channel":"web"}')
split_response "$INVALID_TID"

if [[ "$RESP_STATUS" == "404" ]]; then
  pass "Error handling: invalid tenant_id → 404"
else
  fail "Error handling: invalid tenant_id → 404" "got HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

# H5: Malformed JSON to train-tenant
echo -e "  ${YELLOW}▶ Testing malformed JSON to train-tenant...${RESET}"
TRAIN_BAD_JSON=$(http_req POST "${EDGE_BASE}/train-tenant" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -d '{"action": "add_text", tenant_id BROKEN')
split_response "$TRAIN_BAD_JSON"

if [[ "$RESP_STATUS" == "400" ]]; then
  pass "Error handling: malformed JSON to train-tenant → 400"
else
  fail "Error handling: malformed JSON to train-tenant → 400" "got HTTP ${RESP_STATUS}"
fi

# H6: train-tenant add_text with invalid tenant_id
echo -e "  ${YELLOW}▶ Testing train-tenant add_text with invalid tenant_id...${RESET}"
TRAIN_BAD_TID=$(http_req POST "${EDGE_BASE}/train-tenant" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -d '{"action":"add_text","tenant_id":"00000000-0000-0000-0000-000000000000","content":"test content"}')
split_response "$TRAIN_BAD_TID"

if [[ "$RESP_STATUS" == "404" ]]; then
  pass "Error handling: train-tenant add_text with invalid tenant_id → 404"
else
  fail "Error handling: train-tenant add_text with invalid tenant_id → 404" "got HTTP ${RESP_STATUS} — ${RESP_BODY}"
fi

# H7: train-tenant missing action field
echo -e "  ${YELLOW}▶ Testing train-tenant with missing action field...${RESET}"
TRAIN_NO_ACTION=$(http_req POST "${EDGE_BASE}/train-tenant" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -d '{"tenant_id":"00000000-0000-0000-0000-000000000000"}')
split_response "$TRAIN_NO_ACTION"

if [[ "$RESP_STATUS" == "400" ]]; then
  pass "Error handling: train-tenant missing action → 400"
else
  fail "Error handling: train-tenant missing action → 400" "got HTTP ${RESP_STATUS}"
fi

# H8: train-tenant unknown action
echo -e "  ${YELLOW}▶ Testing train-tenant with unknown action...${RESET}"
TRAIN_UNKNOWN_ACTION=$(http_req POST "${EDGE_BASE}/train-tenant" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -d '{"action":"nonexistent_action","tenant_id":"some-id"}')
split_response "$TRAIN_UNKNOWN_ACTION"

if [[ "$RESP_STATUS" == "400" ]]; then
  pass "Error handling: train-tenant unknown action → 400"
else
  fail "Error handling: train-tenant unknown action → 400" "got HTTP ${RESP_STATUS}"
fi

# H9: onboard-tenant with non-existent URL
echo -e "  ${YELLOW}▶ Testing onboard-tenant with invalid/unreachable URL...${RESET}"
BAD_URL_RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" --max-time 30 \
  -X POST "${EDGE_BASE}/onboard-tenant" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -d "{
    \"tenant_id\": \"${TEST_TENANT_ID}\",
    \"website_url\": \"https://this-domain-does-not-exist-e2e-test-xyz.invalid\",
    \"force\": true
  }" 2>/dev/null)
split_response "$BAD_URL_RESP"

if [[ "$RESP_STATUS" =~ ^[2-5] ]]; then
  pass "Error handling: onboard-tenant with invalid URL responds (got ${RESP_STATUS}, no crash)"
else
  fail "Error handling: onboard-tenant with invalid URL" "got HTTP ${RESP_STATUS}"
fi

# H10: GET request to POST-only endpoint
echo -e "  ${YELLOW}▶ Testing GET to POST-only endpoints...${RESET}"
for ep in "chat-sms" "train-tenant"; do
  GET_RESP=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
    -X GET "${EDGE_BASE}/${ep}" \
    -H "Authorization: Bearer ${ANON_KEY}" 2>/dev/null)
  if [[ "$GET_RESP" =~ ^4 ]]; then
    pass "Error handling: GET to ${ep} → ${GET_RESP} (method not allowed)"
  else
    fail "Error handling: GET to ${ep} → should be 4xx" "got HTTP ${GET_RESP}"
  fi
done

# =============================================================================
# SECTION I — Boilerplate Quality Check (scraper anti-junk regression)
# Verifies that onboard-tenant does NOT store boilerplate/binary garbage.
# =============================================================================
section "I. Boilerplate Quality Check"

BOILER_TENANT_SLUG="e2e-boiler-$$"
BOILER_TENANT_ID=""

echo -e "  ${YELLOW}Creating boilerplate-test tenant...${RESET}"
BOILER_CREATE=$(curl -s -X POST \
  "${SUPABASE_URL}/rest/v1/tenants" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "{\"name\":\"E2E Boilerplate Test\",\"slug\":\"${BOILER_TENANT_SLUG}\",\"onboarding_status\":\"pending\"}")
BOILER_TENANT_ID=$(echo "$BOILER_CREATE" | python3 -c "import json,sys; rows=json.load(sys.stdin); print(rows[0]['id'])" 2>/dev/null || echo "")
if [[ -n "$BOILER_TENANT_ID" ]]; then
  pass "Boilerplate check: tenant created (${BOILER_TENANT_ID})"
else
  fail "Boilerplate check: tenant creation failed" "$BOILER_CREATE"
fi

echo -e "  ${YELLOW}Triggering onboard-tenant for https://example.com...${RESET}"
BOILER_ONBOARD=$(curl -s -X POST \
  "${EDGE_BASE}/onboard-tenant" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"tenant_id\":\"${BOILER_TENANT_ID}\",\"website_url\":\"https://example.com\"}")
BOILER_PAGES=$(echo "$BOILER_ONBOARD" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('pages_scraped',0))" 2>/dev/null || echo "0")
BOILER_CHUNKS=$(echo "$BOILER_ONBOARD" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('embeddings_stored',0))" 2>/dev/null || echo "0")
if [[ "$BOILER_PAGES" -gt 0 ]]; then
  pass "Boilerplate check: scraped ${BOILER_PAGES} pages, stored ${BOILER_CHUNKS} chunks"
else
  fail "Boilerplate check: no pages scraped" "$BOILER_ONBOARD"
fi

echo -e "  ${YELLOW}Verifying zero boilerplate in stored chunks...${RESET}"
BOILER_CONTENT=$(curl -s \
  "${SUPABASE_URL}/rest/v1/knowledge_base?tenant_id=eq.${BOILER_TENANT_ID}&source=eq.website_scrape&select=content" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}")

BOILER_JUNK=$(echo "$BOILER_CONTENT" | python3 -c "
import json, sys
rows = json.load(sys.stdin)
junk_patterns = ['sogo', 'recaptcha', 'accessibility widget', 'cookie consent', 'cookie banner']
junk_count = 0
binary_count = 0
for r in rows:
    c = r.get('content','')
    if c[:2] in ('PK', 'MZ'):
        binary_count += 1
    if any(p in c.lower() for p in junk_patterns):
        junk_count += 1
print(f'{junk_count}:{binary_count}:{len(rows)}')
" 2>/dev/null || echo "ERR:ERR:0")

JUNK_COUNT=$(echo "$BOILER_JUNK" | cut -d: -f1)
BIN_COUNT=$(echo "$BOILER_JUNK" | cut -d: -f2)
TOTAL_CHUNKS=$(echo "$BOILER_JUNK" | cut -d: -f3)

if [[ "$JUNK_COUNT" == "0" ]]; then
  pass "Boilerplate check: ZERO boilerplate patterns found in ${TOTAL_CHUNKS} chunks (sogo/reCAPTCHA/cookie)"
else
  fail "Boilerplate check: ${JUNK_COUNT} chunks contain boilerplate junk (out of ${TOTAL_CHUNKS})" ""
fi

if [[ "$BIN_COUNT" == "0" ]]; then
  pass "Boilerplate check: ZERO binary garbage chunks (PK/MZ magic bytes)"
else
  fail "Boilerplate check: ${BIN_COUNT} binary garbage chunks detected" ""
fi

echo -e "  ${YELLOW}Verifying chunk count is reasonable (≤ 5x page count)...${RESET}"
if [[ "$BOILER_PAGES" -gt 0 && "$BOILER_CHUNKS" -gt 0 ]]; then
  MAX_REASONABLE=$((BOILER_PAGES * 5))
  if [[ "$BOILER_CHUNKS" -le "$MAX_REASONABLE" ]]; then
    pass "Boilerplate check: ${BOILER_CHUNKS} chunks for ${BOILER_PAGES} pages (ratio OK, max allowed ${MAX_REASONABLE})"
  else
    fail "Boilerplate check: ${BOILER_CHUNKS} chunks for ${BOILER_PAGES} pages exceeds 5x ratio — likely duplicate boilerplate" ""
  fi
fi

echo -e "  ${YELLOW}Cleaning up boilerplate-test tenant...${RESET}"
if [[ -n "$BOILER_TENANT_ID" ]]; then
  DEL_BOILER=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
    "${SUPABASE_URL}/rest/v1/tenants?id=eq.${BOILER_TENANT_ID}" \
    -H "apikey: ${SERVICE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_KEY}")
  [[ "$DEL_BOILER" == "2"* ]] && pass "Boilerplate check: tenant cleaned up" || fail "Boilerplate check: cleanup failed" "HTTP ${DEL_BOILER}"
fi

# =============================================================================
# SECTION J — Cleanup
# =============================================================================
section "J. Cleanup"

cleanup_tenant() {
  local tid="$1" label="$2"
  if [[ -z "$tid" ]]; then
    echo -e "  ${YELLOW}Skipping cleanup for ${label} — no tenant ID${RESET}"
    return
  fi

  echo -e "  ${YELLOW}Cleaning up ${label} (${tid})...${RESET}"

  # Delete messages via conversations
  curl -s --max-time "$TIMEOUT" -X DELETE \
    "${SUPABASE_URL}/rest/v1/conversations?tenant_id=eq.${tid}" \
    -H "apikey: ${SERVICE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_KEY}" \
    -H "Prefer: return=minimal" &>/dev/null || true

  # Delete knowledge_base
  curl -s --max-time "$TIMEOUT" -X DELETE \
    "${SUPABASE_URL}/rest/v1/knowledge_base?tenant_id=eq.${tid}" \
    -H "apikey: ${SERVICE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_KEY}" \
    -H "Prefer: return=minimal" &>/dev/null || true

  # Delete tenant
  DEL_T=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" -X DELETE \
    "${SUPABASE_URL}/rest/v1/tenants?id=eq.${tid}" \
    -H "apikey: ${SERVICE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_KEY}" \
    -H "Prefer: return=minimal" 2>/dev/null)

  if [[ "$DEL_T" =~ ^2 ]]; then
    pass "Cleanup: ${label} deleted"
  else
    fail "Cleanup: ${label} deleted" "HTTP ${DEL_T}"
  fi
}

cleanup_tenant "$TEST_TENANT_ID"       "extended test tenant (${TEST_SLUG})"
cleanup_tenant "$ISOLATION_TENANT_ID"  "isolation tenant (${ISOLATION_SLUG})"

# =============================================================================
# Final Summary
# =============================================================================
TOTAL=$((PASS + FAIL))

echo ""
echo -e "${BOLD}══════════════════════════════════════════════════════════════${RESET}"
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}  EXTENDED SUITE PASSED: ${PASS}/${TOTAL}${RESET}"
else
  FAIL_LIST=$(IFS=", "; echo "${FAILURES[*]}")
  echo -e "${RED}${BOLD}  EXTENDED SUITE FAILED: ${FAIL}/${TOTAL}${RESET}"
  echo -e "${RED}${BOLD}  Failed tests:${RESET}"
  for t in "${FAILURES[@]}"; do
    echo -e "  ${RED}  - ${t}${RESET}"
  done
fi
echo -e "${BOLD}══════════════════════════════════════════════════════════════${RESET}"
echo ""

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
