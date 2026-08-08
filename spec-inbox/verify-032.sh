#!/bin/bash
# verify-032.sh — tenant isolation verification for migration 032
set -euo pipefail

SUPABASE_URL="https://rvdqfxtrskxekfkqnegx.supabase.co"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2ZHFmeHRyc2t4ZWtma3FuZWd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NDg2ODksImV4cCI6MjA5MDMyNDY4OX0.5SOW_FX92dIw_zgbqF7HO2SM5ueQC3YPaAexKCFAv3E"
JWT_SECRET="29f034d5e74255b81b5c8151a53f86d7cc56da867335a782d5cd7be61bf7ddb2"

# ============================================================
# JWT GENERATION (Python)
# ============================================================
generate_jwt() {
  local SUB="$1"
  local ROLE="$2"
  local TENANT_ID="$3"
  local USER_META_ISADMIN="${4:-false}"
  local USER_META_TENANT="${5:-$TENANT_ID}"
  local APP_META_TENANT="${6:-$TENANT_ID}"


  python3 -c "
import hmac, hashlib, base64, json, time

secret = '$JWT_SECRET'
header = {'alg': 'HS256', 'typ': 'JWT'}
now = int(time.time())

payload = {
    'sub': '$SUB',
    'iss': 'supabase',
    'ref': 'rvdqfxtrskxekfkqnegx',
    'aud': 'authenticated',
    'role': 'authenticated',
    'iat': now,
    'exp': now + 3600,
    'email': 'test@sprintai-test.com',
    'app_metadata': {
        'role': '$ROLE',
        'tenant_id': '$APP_META_TENANT',
        'provider': 'email',
        'providers': ['email']
    },
    'user_metadata': {
        'tenant_id': '$USER_META_TENANT'
    }
}
if '$USER_META_ISADMIN' == 'true':
    payload['user_metadata']['is_admin'] = True

# Encode
b64 = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b'=').decode()
h = b64(header)
p = b64(payload)
sig = base64.urlsafe_b64encode(hmac.new(secret.encode(), f'{h}.{p}'.encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
token = f'{h}.{p}.{sig}'
print(token)
" 2>/dev/null
}

# ============================================================
# GENERATE JWTs
# ============================================================
echo "=== GENERATING JWTs ==="

# NJB shop_owner — app_metadata has tenant_id=a00..001, user_metadata also a00..001
NJB_TOKEN=$(generate_jwt "8316efed-65d5-44c1-9067-077e95679ccc" "shop_owner" "a0000000-0000-0000-0000-000000000001" "false" "a0000000-0000-0000-0000-000000000001" "a0000000-0000-0000-0000-000000000001")
echo "NJB shop_owner token: ${NJB_TOKEN:0:30}..."

# Super admin (Jason) — app_metadata.role=super_admin, user_metadata.is_admin=true
SA_TOKEN=$(generate_jwt "1361d386-3617-4488-8f73-0b341b833280" "super_admin" "a0000000-0000-0000-0000-000000000001" "true" "a0000000-0000-0000-0000-000000000001" "a0000000-0000-0000-0000-000000000001")
echo "Super admin token: ${SA_TOKEN:0:30}..."

# ATTACKER shop_owner: user_metadata modified to claim different tenant
# app_metadata.tenant_id = a00..001 (NJB), but user_metadata.tenant_id = 7d80..ef (Melvin's)
SPOOF_TOKEN=$(generate_jwt "8316efed-65d5-44c1-9067-077e95679ccc" "shop_owner" "a0000000-0000-0000-0000-000000000001" "false" "7d806f0c-feba-4983-9697-a5940c8990ef" "a0000000-0000-0000-0000-000000000001")
echo "Spoof user_metadata token: ${SPOOF_TOKEN:0:30}..."

echo ""
echo "============================================================"
echo "ATTACK 1: List all tenants as NJB shop_owner"
echo "EXPECT: Only NJB's tenant"
echo "============================================================"
curl -s "$SUPABASE_URL/rest/v1/tenants?select=id,name,slug" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $NJB_TOKEN" | python3 -m json.tool

echo ""
echo "============================================================"
echo "ATTACK 2: List all shops as NJB shop_owner"
echo "EXPECT: Only NJB's shop (b000...000001)"
echo "============================================================"
curl -s "$SUPABASE_URL/rest/v1/shops?select=id,name,slug,tenant_id" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $NJB_TOKEN" | python3 -c "
import sys, json
shops = json.load(sys.stdin)
print(f'Got {len(shops)} shop(s):')
for s in shops:
    print(f'  {s[\"id\"][:8]}... {s[\"name\"]} (tenant={s[\"tenant_id\"][:8]}...)')
"

echo ""
echo "============================================================"
echo "ATTACK 3a: UPDATE/rename another tenant's shop (Melvin's QA Diner 9ef3d64a)"
echo "EXPECT: DENIED at DB — 0 rows affected or error"
echo "============================================================"
curl -s -X PATCH "$SUPABASE_URL/rest/v1/shops?id=eq.9ef3d64a-9943-4ec6-a3f8-8d03c4c589f3" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $NJB_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"name":"HACKED BY NJB"}' | python3 -c "
import sys, json
try:
    r = json.load(sys.stdin)
    if isinstance(r, dict) and 'message' in r:
        print(f'DENIED: {r[\"message\"]}')
    elif isinstance(r, list):
        print(f'ALLOWED ({len(r)} rows): CRITICAL FAILURE - cross-tenant write still works!')
        for row in r:
            print(f'  {row}')
    else:
        print(f'RESULT: {r}')
except:
    print(f'RAW: {sys.stdin.read()[:200]}')
"

echo ""
echo "============================================================"
echo "ATTACK 3b: UPDATE own shop (NJB b000...000001) — should WORK"
echo "EXPECT: ALLOWED (1 row)"
echo "============================================================"
curl -s -X PATCH "$SUPABASE_URL/rest/v1/shops?id=eq.b0000000-0000-0000-0000-000000000001" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $NJB_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"name":"Not Just Bagels"}' | python3 -c "
import sys, json
r = json.load(sys.stdin)
if isinstance(r, list):
    print(f'ALLOWED ({len(r)} rows): own-shop update works correctly')
else:
    print(f'ERROR: {r.get(\"message\", r)}')
"

echo ""
echo "============================================================"
echo "ATTACK 4: UPDATE other-tenant menus"
echo "============================================================"
# Get a menu from Melvin's shop
MENU_RESP=$(curl -s "$SUPABASE_URL/rest/v1/menus?select=id,name,shop_id&shop_id=eq.9ef3d64a-9943-4ec6-a3f8-8d03c4c589f3&limit=1" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY")
OTHER_MENU_ID=$(echo "$MENU_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null)
echo "Other-tenant menu id: ${OTHER_MENU_ID:0:8}..."

if [ -n "$OTHER_MENU_ID" ]; then
  curl -s -X PATCH "$SUPABASE_URL/rest/v1/menus?id=eq.$OTHER_MENU_ID" \
    -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $NJB_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    -d '{"name":"HACKED MENU"}' | python3 -c "
import sys, json
r = json.load(sys.stdin)
if isinstance(r, list):
    print(f'CRITICAL FAILURE: updated {len(r)} other-tenant menu(s)')
else:
    print(f'DENIED: {r.get(\"message\",r)}')
"
fi

echo ""
echo "============================================================"
echo "ATTACK 5: DELETE other-tenant menu_items"
echo "============================================================"
# Get a menu item from Melvin's shop
MI_RESP=$(curl -s "$SUPABASE_URL/rest/v1/menu_items?select=id,name&menu_id=eq.$OTHER_MENU_ID&limit=1" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" 2>/dev/null)
OTHER_MI_ID=$(echo "$MI_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null)
echo "Other-tenant menu_item id: ${OTHER_MI_ID:0:8}..."

if [ -n "$OTHER_MI_ID" ]; then
  curl -s -X DELETE "$SUPABASE_URL/rest/v1/menu_items?id=eq.$OTHER_MI_ID" \
    -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $NJB_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" | python3 -c "
import sys, json
r = json.load(sys.stdin)
if isinstance(r, list):
    print(f'CRITICAL FAILURE: deleted {len(r)} other-tenant menu_item(s)')
else:
    print(f'DENIED: {r.get(\"message\",r)}')
"
fi

echo ""
echo "============================================================"
echo "ATTACK 6: UPDATE other-tenant conversations"
echo "============================================================"
# Get a conversation from Melvin's tenant
CONV_RESP=$(curl -s "$SUPABASE_URL/rest/v1/conversations?select=id&tenant_id=eq.7d806f0c-feba-4983-9697-a5940c8990ef&limit=1" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" 2>/dev/null)
OTHER_CONV_ID=$(echo "$CONV_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null)
echo "Other-tenant conversation id: ${OTHER_CONV_ID:0:16}..."

if [ -n "$OTHER_CONV_ID" ]; then
  curl -s -X PATCH "$SUPABASE_URL/rest/v1/conversations?id=eq.$OTHER_CONV_ID" \
    -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $NJB_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    -d '{"status":"closed"}' | python3 -c "
import sys, json
r = json.load(sys.stdin)
if isinstance(r, list):
    print(f'CRITICAL FAILURE: updated {len(r)} other-tenant conversation(s)')
else:
    print(f'DENIED: {r.get(\"message\",r)}')
"
fi

echo ""
echo "============================================================"
echo "ATTACK 7: UPDATE other-tenant messages"
echo "============================================================"
# Get a message from Melvin's tenant  
MSG_RESP=$(curl -s "$SUPABASE_URL/rest/v1/messages?select=id&tenant_id=eq.7d806f0c-feba-4983-9697-a5940c8990ef&limit=1" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" 2>/dev/null)
OTHER_MSG_ID=$(echo "$MSG_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null)
echo "Other-tenant message id: ${OTHER_MSG_ID:0:16}..."

if [ -n "$OTHER_MSG_ID" ]; then
  curl -s -X PATCH "$SUPABASE_URL/rest/v1/messages?id=eq.$OTHER_MSG_ID" \
    -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $NJB_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    -d '{"content":"HACKED"}' | python3 -c "
import sys, json
r = json.load(sys.stdin)
if isinstance(r, list):
    print(f'CRITICAL FAILURE: updated {len(r)} other-tenant message(s)')
else:
    print(f'DENIED: {r.get(\"message\",r)}')
"
fi

echo ""
echo "============================================================"
echo "ATTACK 8: UPDATE other-tenant orders"
echo "============================================================"
ORD_RESP=$(curl -s "$SUPABASE_URL/rest/v1/orders?select=id&tenant_id=eq.7d806f0c-feba-4983-9697-a5940c8990ef&limit=1" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" 2>/dev/null)
OTHER_ORD_ID=$(echo "$ORD_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null)
echo "Other-tenant order id: ${OTHER_ORD_ID:0:16}..."

if [ -n "$OTHER_ORD_ID" ]; then
  curl -s -X PATCH "$SUPABASE_URL/rest/v1/orders?id=eq.$OTHER_ORD_ID" \
    -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $NJB_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    -d '{"status":"cancelled"}' | python3 -c "
import sys, json
r = json.load(sys.stdin)
if isinstance(r, list):
    print(f'CRITICAL FAILURE: updated {len(r)} other-tenant order(s)')
else:
    print(f'DENIED: {r.get(\"message\",r)}')
"
fi

echo ""
echo "============================================================"
echo "ATTACK 9: UPDATE other-tenant order_carts"
echo "============================================================"
CART_RESP=$(curl -s "$SUPABASE_URL/rest/v1/order_carts?select=id&tenant_id=eq.7d806f0c-feba-4983-9697-a5940c8990ef&limit=1" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" 2>/dev/null)
OTHER_CART_ID=$(echo "$CART_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null)
echo "Other-tenant order_cart id: ${OTHER_CART_ID:0:16}..."

if [ -n "$OTHER_CART_ID" ]; then
  curl -s -X PATCH "$SUPABASE_URL/rest/v1/order_carts?id=eq.$OTHER_CART_ID" \
    -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $NJB_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    -d '{"status":"abandoned"}' | python3 -c "
import sys, json
r = json.load(sys.stdin)
if isinstance(r, list):
    print(f'CRITICAL FAILURE: updated {len(r)} other-tenant cart(s)')
else:
    print(f'DENIED: {r.get(\"message\",r)}')
"
fi

echo ""
echo "============================================================"
echo "ATTACK 10: UPDATE other-tenant knowledge_base"
echo "============================================================"
KB_RESP=$(curl -s "$SUPABASE_URL/rest/v1/knowledge_base?select=id&tenant_id=eq.7d806f0c-feba-4983-9697-a5940c8990ef&limit=1" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" 2>/dev/null)
OTHER_KB_ID=$(echo "$KB_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null)
echo "Other-tenant knowledge_base id: ${OTHER_KB_ID:0:16}..."

if [ -n "$OTHER_KB_ID" ]; then
  curl -s -X PATCH "$SUPABASE_URL/rest/v1/knowledge_base?id=eq.$OTHER_KB_ID" \
    -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $NJB_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    -d '{"content":"HACKED"}' | python3 -c "
import sys, json
r = json.load(sys.stdin)
if isinstance(r, list):
    print(f'CRITICAL FAILURE: updated {len(r)} other-tenant KB row(s)')
else:
    print(f'DENIED: {r.get(\"message\",r)}')
"
fi

echo ""
echo "============================================================"
echo "ATTACK 11: SPOOF user_metadata — set user_metadata.tenant_id to OTHER tenant"
echo "EXPECT: Still only NJB data (app_metadata wins)"
echo "============================================================"
curl -s "$SUPABASE_URL/rest/v1/shops?select=id,name,tenant_id" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $SPOOF_TOKEN" | python3 -c "
import sys, json
shops = json.load(sys.stdin)
if isinstance(shops, list):
    print(f'Got {len(shops)} shop(s):')
    for s in shops:
        print(f'  {s[\"id\"][:8]}... {s[\"name\"]} (tenant={s[\"tenant_id\"][:8]}...)')
    # Check: should be NJB shop only, not Melvin's
    njb = [s for s in shops if 'Bagel' in s.get('name','')]
    melv = [s for s in shops if 'Melvin' in s.get('name','')]
    if melv:
        print(f'CRITICAL FAILURE: user_metadata spoof leaked {len(melv)} other-tenant shop(s)')
    elif len(shops) == 1 and njb:
        print('PASS: Only NJB shop returned — user_metadata spoof ignored')
    else:
        print(f'UNEXPECTED: {len(shops)} shops, njb={len(njb)}, melv={len(melv)}')
else:
    print(f'ERROR: {shops.get(\"message\", shops)}')
"

echo ""
echo "============================================================"
echo "ATTACK 12: Super admin (Jason) sees everything"
echo "============================================================"
curl -s "$SUPABASE_URL/rest/v1/tenants?select=id,name,slug&limit=5" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $SA_TOKEN" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(f'Super admin sees {len(data)} tenant(s) (first 5):')
for t in data:
    print(f'  {t[\"name\"]}')
"

curl -s "$SUPABASE_URL/rest/v1/shops?select=id,name,tenant_id&limit=5" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $SA_TOKEN" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(f'Super admin sees {len(data)} shop(s) (first 5):')
for s in data:
    print(f'  {s[\"name\"][:30]} (tenant={s[\"tenant_id\"][:8]}...)')
"

echo ""
echo "============================================================"
echo "ATTACK 13: admin_chat_transcripts — INSERT AS NJB (noisy-neighbor test)"
echo "EXPECT: INSERT succeeds (known gap), but can't READ inserted row"
echo "============================================================"
INSERT_RESP=$(curl -s -X POST "$SUPABASE_URL/rest/v1/admin_chat_transcripts" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $NJB_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"shop_id":"9ef3d64a-9943-4ec6-a3f8-8d03c4c589f3","transcript":"NOISY NEIGHBOR TEST - NJB writing to Melvin'\''s shop","role":"user","tokens_used":0,"model":"test"}')
echo "INSERT result:"
echo "$INSERT_RESP" | python3 -c "
import sys, json
r = json.load(sys.stdin)
if isinstance(r, list):
    print(f'INSERT allowed (known gap): {len(r)} row(s) inserted')
    for row in r:
        print(f'  id={str(row.get(\"id\",\"\"))[:8]}... shop_id={row.get(\"shop_id\",\"\")[:8]}...')
else:
    msg = r.get('message','')
    if 'violates' in msg.lower() or 'denied' in msg.lower():
        print(f'INSERT denied: {msg}')
    else:
        print(f'INSERT ERROR: {msg}')
"

echo ""
echo "============================================================"
echo "ATTACK 14: admin_chat_transcripts — READ all as NJB"
echo "EXPECT: Only NJB's own transcripts (shop_owner policy limits to own tenant)"
echo "============================================================"
curl -s "$SUPABASE_URL/rest/v1/admin_chat_transcripts?select=id,shop_id,transcript&limit=10" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $NJB_TOKEN" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, list):
    print(f'READ returns {len(data)} row(s)')
    for row in data:
        tid = str(row.get('shop_id',''))[:8]
        txt = str(row.get('transcript',''))[:60]
        print(f'  shop={tid}... txt={txt}')
    # Check: should NOT include Melvin's shop
    melvin_rows = [r for r in data if '9ef3d64a' in str(r.get('shop_id',''))]
    if melvin_rows:
        print(f'FAILURE: saw {len(melvin_rows)} Melvin shop transcript(s)')
    else:
        print('PASS: No cross-tenant transcript reads')
else:
    print(f'ERROR: {data.get(\"message\", data)}')
"

echo ""
echo "============================================================"
echo "DONE — Full Verification Complete"
echo "============================================================"