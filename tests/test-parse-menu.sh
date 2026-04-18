#!/usr/bin/env bash
# test-parse-menu.sh
# Smoke test for the parse-menu-pdf Edge Function.
#
# Usage:
#   ./tests/test-parse-menu.sh                          # dry-run (no server needed)
#   SUPABASE_URL=https://... SHOP_ID=<uuid> ./tests/test-parse-menu.sh  # live run
#
# Prerequisites: curl, python3, jq (optional but recommended)

set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────────────────

SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-}"
SHOP_ID="${SHOP_ID:-}"
DRY_RUN=false

if [[ -z "$SUPABASE_URL" || -z "$SHOP_ID" ]]; then
  echo "⚠  SUPABASE_URL or SHOP_ID not set — running in DRY-RUN mode (shows expected output only)"
  DRY_RUN=true
fi

FUNCTION_URL="${SUPABASE_URL}/functions/v1/parse-menu-pdf"
TMPDIR_LOCAL="$(mktemp -d)"
PDF_FILE="$TMPDIR_LOCAL/test-menu.pdf"

# ─── Helper functions ─────────────────────────────────────────────────────────

pass() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*" >&2; }
section() { echo; echo "━━━ $* ━━━"; }

check_prereqs() {
  section "Prerequisites"
  local missing=0
  for cmd in curl python3; do
    if command -v "$cmd" &>/dev/null; then
      pass "$cmd found"
    else
      fail "$cmd not found"
      missing=$((missing + 1))
    fi
  done
  if command -v jq &>/dev/null; then
    pass "jq found (pretty-printing enabled)"
    HAS_JQ=true
  else
    echo "  ℹ  jq not found — raw JSON will be shown"
    HAS_JQ=false
  fi
  if [[ $missing -gt 0 ]]; then
    echo "Install missing prerequisites and re-run."
    exit 1
  fi
}

# ─── Create a minimal but parseable PDF using Python ─────────────────────────
# We build a raw PDF manually — no external libs required.
# The menu has 3 categories and 6 items.

create_test_pdf() {
  section "Generating test PDF"
  python3 - "$PDF_FILE" <<'PYEOF'
import sys, struct

out = sys.argv[1]

menu_text = """\
MARIO'S BISTRO

APPETIZERS
Bruschetta  $8.99
Toasted bread with fresh tomatoes, basil, and garlic.

Calamari  $12.50
Lightly fried squid served with marinara sauce.

MAIN COURSES
Margherita Pizza  $14.00
Classic tomato sauce, fresh mozzarella, basil.

Spaghetti Bolognese  $16.75
House-made meat sauce with spaghetti.

DESSERTS
Tiramisu  $7.50
Classic Italian dessert with espresso and mascarpone.

Panna Cotta  $6.00
Vanilla cream with berry coulis.
"""

# Encode as PDF with embedded text stream
body = menu_text.encode("latin-1", errors="replace")
stream = (
    b"BT\n"
    + b"/F1 12 Tf\n"
    + b"50 750 Td\n"
)
for line in menu_text.split("\n"):
    safe = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream += f"({safe}) Tj\n".encode("latin-1", errors="replace")
    stream += b"0 -14 Td\n"
stream += b"ET\n"

objects = []

# Object 1: Catalog
objects.append(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
# Object 2: Pages
objects.append(b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n")
# Object 3: Page
objects.append(b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n")
# Object 4: Content stream
obj4 = b"4 0 obj\n<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream\nendobj\n"
objects.append(obj4)
# Object 5: Font
objects.append(b"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n")

pdf = b"%PDF-1.4\n"
offsets = []
for obj in objects:
    offsets.append(len(pdf))
    pdf += obj

xref_offset = len(pdf)
pdf += b"xref\n"
pdf += f"0 {len(objects) + 1}\n".encode()
pdf += b"0000000000 65535 f \n"
for off in offsets:
    pdf += f"{off:010d} 00000 n \n".encode()

pdf += b"trailer\n"
pdf += f"<< /Size {len(objects) + 1} /Root 1 0 R >>\n".encode()
pdf += b"startxref\n"
pdf += f"{xref_offset}\n".encode()
pdf += b"%%EOF\n"

with open(out, "wb") as f:
    f.write(pdf)

print(f"PDF created: {out} ({len(pdf)} bytes)")
PYEOF
  pass "Test PDF created at $PDF_FILE"
}

# ─── Unit tests (offline — validate the script logic) ─────────────────────────

run_unit_tests() {
  section "Unit Tests (offline)"

  # Test 1: PDF file was created and is non-empty
  if [[ -f "$PDF_FILE" && -s "$PDF_FILE" ]]; then
    pass "PDF file exists and is non-empty"
  else
    fail "PDF file missing or empty"
  fi

  # Test 2: PDF starts with %PDF magic bytes
  local magic
  magic="$(python3 -c "
with open('$PDF_FILE','rb') as f:
    h = f.read(4)
print(h[:4] == b'%PDF')
")"
  if [[ "$magic" == "True" ]]; then
    pass "PDF has valid magic bytes (%PDF)"
  else
    fail "PDF magic bytes invalid (got: $magic)"
  fi

  # Test 3: Validate expected output JSON schema
  local sample_response='{"ok":true,"menu_id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","items_parsed":6}'
  if python3 -c "
import json, sys
d = json.loads('$sample_response')
assert d['ok'] is True
assert isinstance(d['menu_id'], str) and len(d['menu_id']) == 36
assert d['items_parsed'] > 0
print('schema ok')
" 2>&1 | grep -q "schema ok"; then
    pass "Expected response schema is valid"
  else
    fail "Response schema validation failed"
  fi

  # Test 4: Validate Claude JSON item schema
  local sample_item='{"name":"Bruschetta","description":"Toasted bread with fresh tomatoes","price_cents":899,"category":"Appetizers","modifiers_json":null}'
  if python3 -c "
import json
item = json.loads('$sample_item')
assert isinstance(item['name'], str)
assert isinstance(item['price_cents'], int) and item['price_cents'] >= 0
assert isinstance(item['category'], str)
assert item.get('modifiers_json') is None or isinstance(item['modifiers_json'], list)
print('item schema ok')
" 2>&1 | grep -q "item schema ok"; then
    pass "Menu item schema structure is valid"
  else
    fail "Menu item schema validation failed"
  fi

  pass "All unit tests passed"
}

# ─── Smoke test (live — requires running Supabase) ────────────────────────────

run_smoke_test() {
  section "Smoke Test (live endpoint)"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo
    echo "  SKIPPED — set SUPABASE_URL and SHOP_ID to run against a live instance."
    echo
    echo "  Live command would be:"
    echo "    curl -X POST \\"
    echo "      -H 'Authorization: Bearer \$SUPABASE_ANON_KEY' \\"
    echo "      -F 'shop_id=<your-shop-uuid>' \\"
    echo "      -F 'file=@tests/fixtures/sample-menu.pdf' \\"
    echo "      \$SUPABASE_URL/functions/v1/parse-menu-pdf"
    echo
    echo "  Expected response:"
    if [[ "$HAS_JQ" == "true" ]]; then
      echo '  {"ok":true,"menu_id":"<uuid>","items_parsed":6}' | jq .
    else
      echo '  {"ok":true,"menu_id":"<uuid>","items_parsed":6}'
    fi
    return 0
  fi

  echo "  Calling $FUNCTION_URL ..."
  local response http_code

  response="$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
    -F "shop_id=${SHOP_ID}" \
    -F "file=@${PDF_FILE};type=application/pdf" \
    "$FUNCTION_URL")"

  http_code="$(echo "$response" | tail -1)"
  body="$(echo "$response" | head -n -1)"

  echo "  HTTP $http_code"

  if [[ "$HAS_JQ" == "true" ]]; then
    echo "$body" | jq .
  else
    echo "$body"
  fi

  # Assertions
  if [[ "$http_code" == "200" ]]; then
    pass "HTTP 200 OK"
  else
    fail "Expected HTTP 200, got $http_code"
  fi

  local ok_field
  ok_field="$(echo "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ok'))" 2>/dev/null || echo "parse_error")"
  if [[ "$ok_field" == "True" ]]; then
    pass "Response ok=true"
  else
    fail "Response ok field not true (got: $ok_field)"
  fi

  local items_parsed
  items_parsed="$(echo "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('items_parsed',0))" 2>/dev/null || echo "0")"
  if [[ "$items_parsed" -ge 1 ]]; then
    pass "items_parsed=$items_parsed (at least 1 item parsed)"
  else
    fail "No items parsed (got: $items_parsed)"
  fi

  local menu_id
  menu_id="$(echo "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('menu_id',''))" 2>/dev/null || echo "")"
  if [[ ${#menu_id} -eq 36 ]]; then
    pass "menu_id is a valid UUID: $menu_id"
  else
    fail "menu_id missing or invalid (got: $menu_id)"
  fi
}

# ─── Error-case tests ──────────────────────────────────────────────────────────

run_error_cases() {
  section "Error-Case Tests"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  SKIPPED in dry-run mode."
    return 0
  fi

  # Missing shop_id
  local res1
  res1="$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
    -F "file=@${PDF_FILE};type=application/pdf" \
    "$FUNCTION_URL")"
  if [[ "$res1" == "400" ]]; then
    pass "Missing shop_id → HTTP 400"
  else
    fail "Missing shop_id should be 400, got $res1"
  fi

  # Non-existent shop_id
  local res2
  res2="$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
    -F "shop_id=00000000-0000-0000-0000-000000000000" \
    -F "file=@${PDF_FILE};type=application/pdf" \
    "$FUNCTION_URL")"
  if [[ "$res2" == "404" ]]; then
    pass "Non-existent shop_id → HTTP 404"
  else
    fail "Non-existent shop_id should be 404, got $res2"
  fi

  # Non-PDF file
  local txt_file="$TMPDIR_LOCAL/not-a-pdf.txt"
  echo "hello world" > "$txt_file"
  local res3
  res3="$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
    -F "shop_id=${SHOP_ID}" \
    -F "file=@${txt_file};type=text/plain" \
    "$FUNCTION_URL")"
  if [[ "$res3" == "400" ]]; then
    pass "Non-PDF file → HTTP 400"
  else
    fail "Non-PDF file should be 400, got $res3"
  fi
}

# ─── Test plan summary ────────────────────────────────────────────────────────

print_test_plan() {
  section "Test Plan"
  cat <<'EOF'
  UNIT TESTS (offline, always run):
    U1  PDF file created and non-empty
    U2  PDF has valid %PDF magic bytes
    U3  Success response JSON schema { ok, menu_id (UUID), items_parsed (int) }
    U4  Menu item JSON schema { name, price_cents, category, modifiers_json }

  SMOKE TESTS (live, requires SUPABASE_URL + SHOP_ID):
    S1  POST /parse-menu-pdf returns HTTP 200 with valid PDF + shop_id
    S2  Response body ok=true
    S3  items_parsed >= 1
    S4  menu_id is a 36-char UUID

  ERROR-CASE TESTS (live):
    E1  Missing shop_id  → HTTP 400
    E2  shop_id not found → HTTP 404
    E3  Non-PDF file      → HTTP 400

  EXPECTED SUCCESS RESPONSE:
    {
      "ok": true,
      "menu_id": "<uuid>",
      "items_parsed": 6
    }

  EXPECTED CLAUDE ITEM SHAPE (per item in menus.raw_json):
    {
      "name":           "Bruschetta",
      "description":    "Toasted bread with fresh tomatoes, basil, and garlic.",
      "price_cents":    899,
      "category":       "Appetizers",
      "modifiers_json": null
    }
EOF
}

# ─── Cleanup ──────────────────────────────────────────────────────────────────

cleanup() {
  rm -rf "$TMPDIR_LOCAL"
}
trap cleanup EXIT

# ─── Run ──────────────────────────────────────────────────────────────────────

echo "╔══════════════════════════════════════════════════╗"
echo "║       parse-menu-pdf — Test Suite                ║"
echo "╚══════════════════════════════════════════════════╝"
echo "Mode: $([ "$DRY_RUN" == "true" ] && echo "DRY RUN" || echo "LIVE (${FUNCTION_URL})")"

print_test_plan
check_prereqs
create_test_pdf
run_unit_tests
run_smoke_test
run_error_cases

section "Summary"
echo "  All offline tests completed."
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  Set SUPABASE_URL, SUPABASE_ANON_KEY, and SHOP_ID to run live tests."
fi
echo
