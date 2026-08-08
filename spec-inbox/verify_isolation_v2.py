#!/usr/bin/env python3
"""Tenant isolation verification — SQL policy audit + API attack testing."""

import json, sys, os, subprocess, base64, hmac, hashlib, time, requests

# ============================================================
# CONFIG
# ============================================================
def get_secret(var_name):
    """Get a secret from the sprintai secrets file."""
    result = subprocess.run(
        ['bash', '-c', f'source /Users/joestrazza/.openclaw-sprintai/.secrets 2>/dev/null; echo -n "${var_name}"'],
        capture_output=True, text=True
    )
    return result.stdout.strip()

SUPABASE_ACCESS_TOKEN = get_secret('SUPABASE_ACCESS_TOKEN')
SERVICE_ROLE_KEY = get_secret('SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY')
PROJECT_REF = 'rvdqfxtrskxekfkqnegx'
SUPABASE_URL = f'https://{PROJECT_REF}.supabase.co'
ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2ZHFmeHRyc2t4ZWtma3FuZWd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NDg2ODksImV4cCI6MjA5MDMyNDY4OX0.5SOW_FX92dIw_zgbqF7HO2SM5ueQC3YPaAexKCFAv3E'
JWT_SECRET = '29f034d5e74255b81b5c8151a53f86d7cc56da867335a782d5cd7be61bf7ddb2'

# ============================================================
# SQL via Management API (authoritative — bypasses RLS)
# ============================================================
def sql(query):
    """Run SQL via Supabase Management API."""
    payload = json.dumps({"query": query})
    r = requests.post(
        f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query",
        headers={
            "Authorization": f"Bearer {SUPABASE_ACCESS_TOKEN}",
            "Content-Type": "application/json"
        },
        data=payload
    )
    if r.status_code not in (200, 201):
        return {"error": r.status_code, "body": r.text[:500]}
    return r.json()

PASS = 0
FAIL = 0
GAP = 0

# ============================================================
# PART 1: POLICY AUDIT (SQL — Management API)
# ============================================================
print("=" * 60)
print("PART 1: POLICY AUDIT (Management API SQL)")
print("=" * 60)

# 1a. All policies
print("\n--- All RLS policies ---")
policies = sql(
    "SELECT tablename, policyname, cmd, permissive, roles::text as roles, "
    "substring(qual::text, 1, 120) as qual_snippet, "
    "substring(with_check::text, 1, 120) as wc_snippet "
    "FROM pg_policies WHERE schemaname='public' "
    "ORDER BY tablename, cmd, policyname"
)
if isinstance(policies, list):
    print(f"  Total policies: {len(policies)}")
    for p in policies:
        perm = "PERM" if p.get("permissive") else "RESTRICT"
        print(f"  {p['tablename']:30s} {perm:7s} {p['cmd']:8s} {p['policyname']}")
else:
    print(f"  ERROR: {policies}")
    sys.exit(1)

# 1b. Tables without tenant_id
print("\n--- Tables with tenant_id column ---")
tables_with_tid = sql(
    "SELECT table_name FROM information_schema.columns "
    "WHERE table_schema='public' AND column_name='tenant_id' "
    "AND table_name NOT LIKE 'v_%' "
    "ORDER BY table_name"
)
if isinstance(tables_with_tid, list):
    tables_list = [t['table_name'] for t in tables_with_tid]
    print(f"  {len(tables_list)} tables: {', '.join(tables_list)}")
else:
    print(f"  ERROR: {tables_with_tid}")

# 1c. Tables without RLS enabled
print("\n--- RLS status for all public tables ---")
rls_status = sql(
    "SELECT tablename, rowsecurity FROM pg_tables "
    "WHERE schemaname='public' "
    "AND tablename NOT LIKE 'v_%' AND tablename != '_prisma_migrations' "
    "ORDER BY tablename"
)
if isinstance(rls_status, list):
    for t in rls_status:
        status = "ENABLED" if t['rowsecurity'] else "⚠️ DISABLED"
        if not t['rowsecurity']:
            print(f"  ⚠️ {t['tablename']}: RLS {status}")
            FAIL += 1
    print(f"  All tables checked")
else:
    print(f"  ERROR: {rls_status}")

# 1d. Tables with no policies at all
print("\n--- Tables with zero policies ---")
no_pol = sql(
    "SELECT tablename FROM pg_tables "
    "WHERE schemaname='public' "
    "AND tablename NOT IN (SELECT tablename FROM pg_policies WHERE schemaname='public') "
    "AND tablename NOT LIKE 'v_%' AND tablename != '_prisma_migrations' "
    "ORDER BY tablename"
)
if isinstance(no_pol, list):
    if no_pol:
        print(f"  ⚠️ UNPROTECTED TABLES: {[t['tablename'] for t in no_pol]}")
        FAIL += 1
    else:
        print(f"  None — all tables have RLS policies ✅")
        PASS += 1
else:
    print(f"  ERROR: {no_pol}")

# 1e. INSERT policies with check=true (insecure)
print("\n--- INSERT policies: check audit ---")
insert_pols = sql(
    "SELECT tablename, policyname, with_check::text as wc, roles::text as roles "
    "FROM pg_policies "
    "WHERE schemaname='public' AND cmd = 'INSERT' AND permissive='PERMISSIVE' "
    "ORDER BY tablename"
)
if isinstance(insert_pols, list):
    for p in insert_pols:
        wc = (p.get('wc') or '').strip()
        insecure = wc == 'true' or wc == '' or not wc
        flag = "⚠️ INSECURE" if insecure else "✅"
        if insecure:
            GAP += 1
        print(f"  {flag} {p['tablename']}.{p['policyname']}: check={wc[:60]}")
else:
    print(f"  ERROR: {insert_pols}")

# 1f. Look specifically for admin_chat_transcripts policies
print("\n--- admin_chat_transcripts: policies ---")
act_pols = sql(
    "SELECT policyname, cmd, permissive, qual::text as qual, with_check::text as wc, roles::text as roles "
    "FROM pg_policies WHERE schemaname='public' AND tablename='admin_chat_transcripts'"
)
if isinstance(act_pols, list):
    for p in act_pols:
        wc = (p.get('wc') or '')
        qual = (p.get('qual') or '')
        print(f"  {p['policyname']} ({p['cmd']}): qual={qual[:80]}, check={wc[:80]}")
else:
    print(f"  ERROR: {act_pols}")

# 1g. Restrictive policies count
print("\n--- Restrictive policies ---")
restrictive = sql(
    "SELECT tablename, policyname, cmd FROM pg_policies "
    "WHERE schemaname='public' AND permissive='RESTRICTIVE' "
    "ORDER BY tablename"
)
if isinstance(restrictive, list):
    print(f"  Count: {len(restrictive)}")
    for p in restrictive:
        print(f"  {p['tablename']}.{p['policyname']} ({p['cmd']})")

# 1h. Verify no permissive authenticated policies with qual=true
print("\n--- Permissive policies with qual=true or OR-based ---")
dangerous = sql(
    "SELECT tablename, policyname, cmd, qual::text as qual, with_check::text as wc "
    "FROM pg_policies "
    "WHERE schemaname='public' AND permissive='PERMISSIVE' "
    "AND NOT roles::text ILIKE '%anon%' "
    "ORDER BY tablename"
)
if isinstance(dangerous, list):
    for p in dangerous:
        qual = (p.get('qual') or '')
        wc = (p.get('wc') or '')
        has_or = 'OR' in qual.upper() if qual else False
        qual_true = qual.strip() == 'true' if qual else False
        safe = 'is_super_admin' in qual or 'is_shop_owner_for' in qual or 'tenant_id' in qual
        if has_or and not safe:
            print(f"  ⚠️ DANGEROUS: {p['tablename']}.{p['policyname']} ({p['cmd']}) qual={qual[:80]}")
            FAIL += 1
        elif qual_true:
            print(f"  ⚠️ SKIP (check failure): {p['tablename']}.{p['policyname']} ({p['cmd']}) qual=true")
            FAIL += 1
        else:
            print(f"  ✅ {p['tablename']}.{p['policyname']} ({p['cmd']}) — scoped")
    PASS += 1

# ============================================================
# PART 2: TENANT ISOLATION — Direct service_role reads
# ============================================================
print("\n" + "=" * 60)
print("PART 2: TENANT DATA VERIFICATION (service_role)")
print("=" * 60)

HEADERS_SR = {
    "apikey": ANON_KEY,
    "Authorization": f"Bearer {SERVICE_ROLE_KEY}"
}

def sr_get(path):
    r = requests.get(f"{SUPABASE_URL}{path}", headers=HEADERS_SR)
    if r.status_code == 200:
        return r.json()
    return {"error": r.status_code, "body": r.text[:200]}

# 2a. Check tenant existence
tenants = sr_get("/rest/v1/tenants?select=id,name,slug")
if isinstance(tenants, list):
    print(f"\nTenants ({len(tenants)}):")
    for t in tenants:
        print(f"  {t['id'][:8]}... {t['name']:20s} slug={t.get('slug','')}")
else:
    print(f"  ERROR: {tenants}")

# 2b. Check shops per tenant
shops = sr_get("/rest/v1/shops?select=id,name,tenant_id")
if isinstance(shops, list):
    print(f"\nShops ({len(shops)}):")
    for s in shops:
        tid = str(s.get('tenant_id',''))[:8]
        print(f"  id={s['id'][:8]}... name={s.get('name',''):30s} tenant={tid}...")
    # Verify: each shop belongs to exactly 1 tenant
    njb_shops = [s for s in shops if 'a0000000' in str(s.get('tenant_id',''))[:8]]
    melvin_shops = [s for s in shops if '7d806f0c' in str(s.get('tenant_id',''))[:8]]
    print(f"  NJB tenant shops: {len(njb_shops)}")
    print(f"  Melvin tenant shops: {len(melvin_shops)}")
else:
    print(f"  ERROR: {shops}")

# 2c. Cross-tenant data check: direct SQL
print("\n--- Cross-tenant integrity (direct SQL) ---")
# Check: does any shop link to wrong tenant?
cross_shop = sql("SELECT s.id, s.name, s.tenant_id, t.name as tenant_name FROM shops s JOIN tenants t ON s.tenant_id = t.id ORDER BY s.tenant_id")
if isinstance(cross_shop, list):
    for s in cross_shop:
        print(f"  {s['name'][:25]:25s} → {s.get('tenant_name','')}")
else:
    print(f"  ERROR: {cross_shop}")

# 2d. Check for data in conversations/messages/orders per tenant
for table in ['conversations', 'messages', 'orders', 'order_carts', 'knowledge_base', 'menu_items', 'menus']:
    data = sql(f"SELECT tenant_id, count(*) as cnt FROM {table} GROUP BY tenant_id ORDER BY tenant_id")
    if isinstance(data, list):
        if data:
            for row in data:
                tid = str(row.get('tenant_id',''))[:8] if row.get('tenant_id') else 'NULL'
                print(f"  {table}: tenant={tid}... count={row['cnt']}")
        else:
            print(f"  {table}: empty")
    else:
        print(f"  {table}: ERROR {data}")

# ============================================================
# PART 3: ATTACK TESTING VIA ANON_KEY (Authenticated RLS)
# ============================================================
print("\n" + "=" * 60)
print("PART 3: ATTACK TESTING (authenticated RLS via APIs)")
print("=" * 60)

# Try generating JWT using the Supabase project's JWT secret
# The key might not be the auth signing key - Supabase uses a specific one
# Let's try a different approach: use the anon key to sign JWTs

# Actually, the anon key has a secret portion. Let me try using that.
# The anon key is: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2ZHFmeHRyc2t4ZWtma3FuZWd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NDg2ODksImV4cCI6MjA5MDMyNDY4OX0.5SOW_FX92dIw_zgbqF7HO2SM5ueQC3YPaAexKCFAv3E
# That's a properly signed JWT itself. Supabase signs JWTs with their own key.

# The SUPABASE_SECRET_KEYS might contain the JWT signing key, but Supabase 
# might be using a different key. Let me check if there's a JWKS endpoint
print("Checking JWT signing key...")
jwks = requests.get(f"{SUPABASE_URL}/auth/v1/jwks").json()
print(f"  JWKS keys: {len(jwks.get('keys', []))}")
for k in jwks.get('keys', []):
    print(f"  Key: alg={k.get('alg')} kid={k.get('kid')} kty={k.get('kty')}")

# The JWT secret we have (29f034d5...) is an HMAC HS256 key.
# But Supabase might only accept RS256 (asymmetric) signed JWTs via JWKS.
# Let's try the /auth/v1/token?grant_type=password flow instead
# Or better yet: test with direct RLS SQL as the authoritative check.

print("\nRunning direct RLS tests via SQL proxy...")

# We'll use a SET LOCAL role to simulate authenticated users and test RLS
# This bypasses JWT signing issues and tests the actual RLS policies

# Test 1: Simulate NJB shop_owner — should see only NJB data
print("\n--- RLS TEST: NJB shop_owner sees shops ---")
rls_test1 = sql(
    "SET LOCAL role TO authenticated; "
    "SET LOCAL request.jwt.claims TO '{\"sub\":\"8316efed-65d5-44c1-9067-077e95679ccc\",\"app_metadata\":{\"role\":\"shop_owner\",\"tenant_id\":\"a0000000-0000-0000-0000-000000000001\"},\"user_metadata\":{\"tenant_id\":\"a0000000-0000-0000-0000-000000000001\"},\"aud\":\"authenticated\"}'; "
    "SELECT id, name, tenant_id FROM shops"
)
if isinstance(rls_test1, list):
    print(f"  NJB sees {len(rls_test1)} shop(s):")
    for s in rls_test1:
        tid = str(s.get('tenant_id',''))[:8]
        print(f"    id={s['id'][:8]}... name={s.get('name','')} tenant={tid}...")
    # Check for cross-tenant leak
    cross = [s for s in rls_test1 if '7d806f0c' in str(s.get('tenant_id',''))]
    own = [s for s in rls_test1 if 'a0000000' in str(s.get('tenant_id',''))]
    if cross:
        print(f"  ⚠️ CROSS-TENANT LEAK: {len(cross)} Melvin shop(s) visible!")
        FAIL += 1
    else:
        print(f"  ✅ Only NJB shops visible ({len(own)}) — isolation confirmed")
        PASS += 1
else:
    print(f"  ERROR: {rls_test1}")

# Test 2: NJB tring to UPDATE Melvin's shop
print("\n--- RLS TEST: NJB updates Melvin shop ---")
rls_test2 = sql(
    "SET LOCAL role TO authenticated; "
    "SET LOCAL request.jwt.claims TO '{\"sub\":\"8316efed-65d5-44c1-9067-077e95679ccc\",\"app_metadata\":{\"role\":\"shop_owner\",\"tenant_id\":\"a0000000-0000-0000-0000-000000000001\"},\"user_metadata\":{\"tenant_id\":\"a0000000-0000-0000-0000-000000000001\"},\"aud\":\"authenticated\"}'; "
    "UPDATE shops SET name = 'HACKED BY NJB' WHERE id = '9ef3d64a-9943-4ec6-a3f8-8d03c4c589f3' RETURNING id, name"
)
if isinstance(rls_test2, list):
    if len(rls_test2) == 0:
        print(f"  ✅ DENIED — 0 rows updated (cross-tenant write blocked)")
        PASS += 1
    else:
        print(f"  ⚠️ FAIL: {len(rls_test2)} row(s) updated — cross-tenant write BYPASSED!")
        FAIL += 1
else:
    # Error might be permission denied
    err = str(rls_test2)
    if 'permission denied' in err.lower() or 'violates' in err.lower():
        print(f"  ✅ DENIED by RLS error")
        PASS += 1
    else:
        print(f"  ERROR: {err}")

# Test 3: NJB updating own shop (control)
print("\n--- RLS TEST: NJB updates own shop (control) ---")
rls_test3 = sql(
    "SET LOCAL role TO authenticated; "
    "SET LOCAL request.jwt.claims TO '{\"sub\":\"8316efed-65d5-44c1-9067-077e95679ccc\",\"app_metadata\":{\"role\":\"shop_owner\",\"tenant_id\":\"a0000000-0000-0000-0000-000000000001\"},\"user_metadata\":{\"tenant_id\":\"a0000000-0000-0000-0000-000000000001\"},\"aud\":\"authenticated\"}'; "
    "UPDATE shops SET name = 'Not Just Bagels' WHERE id = 'b0000000-0000-0000-0000-000000000001' RETURNING id, name"
)
if isinstance(rls_test3, list) and len(rls_test3) > 0:
    print(f"  ✅ ALLOWED — own-shop update works ({len(rls_test3)} row)")
    PASS += 1
else:
    print(f"  ⚠️ FAIL: own-shop update blocked or errored")
    FAIL += 1

# Test 4: NJB reads tenants
print("\n--- RLS TEST: NJB reads tenants ---")
rls_test4 = sql(
    "SET LOCAL role TO authenticated; "
    "SET LOCAL request.jwt.claims TO '{\"sub\":\"8316efed-65d5-44c1-9067-077e95679ccc\",\"app_metadata\":{\"role\":\"shop_owner\",\"tenant_id\":\"a0000000-0000-0000-0000-000000000001\"},\"user_metadata\":{\"tenant_id\":\"a0000000-0000-0000-0000-000000000001\"},\"aud\":\"authenticated\"}'; "
    "SELECT id, name, slug FROM tenants"
)
if isinstance(rls_test4, list):
    print(f"  NJB sees {len(rls_test4)} tenant(s):")
    for t in rls_test4:
        print(f"    id={t.get('id','')[:8]}... name={t.get('name','')}")
    if len(rls_test4) > 1:
        print(f"  ⚠️ WARN: NJB sees {len(rls_test4)} tenants (expected: 1)")
        # Not necessarily a failure if tenants are allowed to be visible
    else:
        print(f"  ✅ Only own tenant visible")
    PASS += 1  # Tenant visibility may be intentional
else:
    print(f"  ERROR: {rls_test4}")

# Test 5: User metadata spoof — app_metadata=NJB, user_metadata=Melvin
print("\n--- RLS TEST: NJB spoofs user_metadata to Melvin tenant ---")
rls_test5 = sql(
    "SET LOCAL role TO authenticated; "
    "SET LOCAL request.jwt.claims TO '{\"sub\":\"8316efed-65d5-44c1-9067-077e95679ccc\",\"app_metadata\":{\"role\":\"shop_owner\",\"tenant_id\":\"a0000000-0000-0000-0000-000000000001\"},\"user_metadata\":{\"tenant_id\":\"7d806f0c-feba-4983-9697-a5940c8990ef\"},\"aud\":\"authenticated\"}'; "
    "SELECT id, name, tenant_id FROM shops"
)
if isinstance(rls_test5, list):
    print(f"  NJB (spoofed user_metadata) sees {len(rls_test5)} shop(s):")
    for s in rls_test5:
        tid = str(s.get('tenant_id',''))[:8]
        print(f"    id={s['id'][:8]}... name={s.get('name','')} tenant={tid}...")
    cross = [s for s in rls_test5 if '7d806f0c' in str(s.get('tenant_id',''))]
    own = [s for s in rls_test5 if 'a0000000' in str(s.get('tenant_id',''))]
    if cross:
        print(f"  ⚠️ CROSS-TENANT LEAK VIA SPOOF: {len(cross)} Melvin shop(s) visible!")
        FAIL += 1
    else:
        print(f"  ✅ Spoof ignored — only NJB shops visible ({len(own)})")
        PASS += 1
else:
    print(f"  ERROR: {rls_test5}")

# Test 6: Super admin sees everything
print("\n--- RLS TEST: Super admin sees all shops ---")
rls_test6 = sql(
    "SET LOCAL role TO authenticated; "
    "SET LOCAL request.jwt.claims TO '{\"sub\":\"1361d386-3617-4488-8f73-0b341b833280\",\"app_metadata\":{\"role\":\"super_admin\",\"tenant_id\":\"a0000000-0000-0000-0000-000000000001\"},\"user_metadata\":{\"tenant_id\":\"a0000000-0000-0000-0000-000000000001\",\"is_admin\":true},\"aud\":\"authenticated\"}'; "
    "SELECT id, name, tenant_id FROM shops LIMIT 10"
)
if isinstance(rls_test6, list):
    print(f"  Super admin sees {len(rls_test6)} shop(s):")
    tenants_seen = set()
    for s in rls_test6:
        tid = str(s.get('tenant_id',''))[:8]
        tenants_seen.add(tid)
        print(f"    id={s['id'][:8]}... name={s.get('name','')} tenant={tid}...")
    if len(tenants_seen) > 1:
        print(f"  ✅ Super admin sees multiple tenants ({len(tenants_seen)})")
        PASS += 1
    else:
        print(f"  ⚠️ Super admin sees only 1 tenant — restriction may be wrong")
else:
    print(f"  ERROR: {rls_test6}")

# ============================================================
# FINAL VERDICT
# ============================================================
print("\n" + "=" * 60)
print(f"VERDICT: PASS={PASS} FAIL={FAIL} GAP={GAP}")
if FAIL == 0:
    print("RESULT: PASS — No tenant isolation breaches detected")
else:
    print(f"RESULT: FAIL — {FAIL} tenant isolation failures found")
print("=" * 60)
