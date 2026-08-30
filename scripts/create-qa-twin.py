#!/usr/bin/env python3
"""Create a QA-twin of a source shop: same menu, no phone, no protection.

Pattern: every live/protected shop gets a QA twin that the Proof test-suite
runner can hit safely. The twin is:
  - unprotected (protected=false)
  - phone-less (phone_number_e164 IS NULL)
  - is_test=true
  - fully tenant-isolated (new tenant row)
  - menu-identical to the source (same CSV import)

Usage:
  python3 scripts/create-qa-twin.py <source_slug> <twin_slug> <twin_name> <menu_csv_path>

Example (Vito's Pizza):
  python3 scripts/create-qa-twin.py vitos-pizza vitos-pizza-qa "Vito's Pizza (QA)" \
    tests/fixtures/menu-intake/jacks_slice_flat.csv

The script is idempotent: if the twin already exists it reports status and exits 0.
"""
import os, sys, json, re, urllib.request, urllib.error, uuid

if len(sys.argv) < 4:
    print(f"Usage: {sys.argv[0]} <source_slug> <twin_slug> <twin_name> [menu_csv_path]")
    sys.exit(1)

SOURCE_SLUG  = sys.argv[1]
TWIN_SLUG    = sys.argv[2]
TWIN_NAME    = sys.argv[3]
MENU_CSV     = sys.argv[4] if len(sys.argv) > 4 else None

# Default CSV — same Jack's Slice flat CSV the demo shops use
if not MENU_CSV:
    MENU_CSV = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "tests", "fixtures", "menu-intake", "jacks_slice_flat.csv")

SUPABASE_URL = "https://rvdqfxtrskxekfkqnegx.supabase.co"

# ── Secrets ──────────────────────────────────────────────────────────────────
secrets = {}
with open(os.path.expanduser("~/.openclaw/.secrets")) as f:
    for line in f:
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        line = re.sub(r'^export\s+', '', line)
        m = re.match(r'^(\S+)\s*=\s*(.+)$', line)
        if not m:
            continue
        k, v = m.group(1), m.group(2)
        v = v.strip().strip('"').strip("'").rstrip(';')
        secrets[k.strip()] = v

SUPABASE_KEY = secrets.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY", "")
if not SUPABASE_KEY:
    print("ERROR: SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY not found")
    sys.exit(1)

# ── Deterministic twin IDs based on slug ─────────────────────────────────────
# Use a deterministic UUIDv5 namespace so re-runs are idempotent
QA_NAMESPACE = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")  # DNS namespace
TENANT_ID = str(uuid.uuid5(QA_NAMESPACE, f"qa-twin-tenant-{TWIN_SLUG}"))
SHOP_ID   = str(uuid.uuid5(QA_NAMESPACE, f"qa-twin-shop-{TWIN_SLUG}"))

PASS, FAIL = 0, 0

def ok(label, detail=""):
    global PASS
    print(f"  ✅ {label}{' — ' + detail if detail else ''}")
    PASS += 1

def bad(label, detail=""):
    global FAIL
    print(f"  ❌ {label}{' — ' + detail if detail else ''}")
    FAIL += 1

# ── Supabase REST helpers ────────────────────────────────────────────────────
def supabase_api(method, path, body=None, prefer=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("apikey", SUPABASE_KEY)
    req.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
    if body:
        req.add_header("Content-Type", "application/json")
        if prefer:
            req.add_header("Prefer", prefer)
    try:
        with urllib.request.urlopen(req) as resp:
            txt = resp.read().decode()
            return json.loads(txt) if txt.strip() else None
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode()
        print(f"  HTTP {e.code} on {method} {path}: {body_txt[:300]}")
        return None

# ══════════════════════════════════════════════════════════════════════════════
print("=" * 72)
print(f"  QA TWIN CREATOR — {SOURCE_SLUG} → {TWIN_SLUG}")
print("=" * 72)

# ── 1. Verify source shop exists ─────────────────────────────────────────────
print("\n[1] Checking source shop...")
src = supabase_api("GET", f"shops?slug=eq.{SOURCE_SLUG}&select=id,name,slug,protected,phone_number_e164,tenant_id")
if not src or len(src) == 0:
    bad(f"source shop not found", f"slug={SOURCE_SLUG}")
    sys.exit(1)
src_shop = src[0]
ok("source shop found", f"id={src_shop['id']} name={src_shop['name']} protected={src_shop.get('protected')} phone={src_shop.get('phone_number_e164','none')}")

# ── 2. Create QA tenant (idempotent) ─────────────────────────────────────────
print(f"\n[2] Creating QA tenant (id={TENANT_ID})...")
existing_tenant = supabase_api("GET", f"tenants?id=eq.{TENANT_ID}")
if existing_tenant and len(existing_tenant) > 0:
    ok("QA tenant already exists", f"slug={existing_tenant[0].get('slug','')}")
else:
    t = supabase_api("POST", "tenants", {
        "id": TENANT_ID,
        "name": f"{TWIN_NAME} LLC",
        "slug": f"{TWIN_SLUG}-llc",
        "status": "active",
        "plan": "starter",
        "config": {"business_type": "restaurant", "is_qa_twin": True},
        "onboarding_status": "complete",
    }, prefer="return=representation")
    if t:
        data = t[0] if isinstance(t, list) else t
        ok("QA tenant created", f"name={data.get('name','')}")
    else:
        bad("QA tenant creation failed")
        # continue anyway — shop creation might still work

# ── 3. Create QA twin shop (idempotent, ALWAYS unprotected + no phone) ───────
print(f"\n[3] Creating QA twin shop (id={SHOP_ID})...")
existing_shop = supabase_api("GET", f"shops?id=eq.{SHOP_ID}")
if existing_shop and len(existing_shop) > 0:
    s = existing_shop[0]
    ok("QA twin shop already exists",
       f"protected={s.get('protected')} phone={s.get('phone_number_e164','null')}")
else:
    s = supabase_api("POST", "shops", {
        "id": SHOP_ID,
        "tenant_id": TENANT_ID,
        "name": TWIN_NAME,
        "slug": TWIN_SLUG,
        "is_test": True,
        "protected": False,
        "phone_number_e164": None,
        "subscription_pm_set": True,
        "timezone": "America/New_York",
        "open_hours": {
            "mon": [{"open": "11:00", "close": "22:00"}],
            "tue": [{"open": "11:00", "close": "22:00"}],
            "wed": [{"open": "11:00", "close": "22:00"}],
            "thu": [{"open": "11:00", "close": "22:00"}],
            "fri": [{"open": "11:00", "close": "23:00"}],
            "sat": [{"open": "11:00", "close": "23:00"}],
            "sun": [{"open": "12:00", "close": "21:00"}],
        },
        "merchant_pin": "1234",
    }, prefer="return=representation")
    if s:
        data = s[0] if isinstance(s, list) else s
        ok("QA twin shop created", f"protected={data.get('protected')} phone={data.get('phone_number_e164','null')}")
    else:
        bad("QA twin shop creation failed")
        sys.exit(1)

# ── 4. Import menu (idempotent via import_hash) ──────────────────────────────
print(f"\n[4] Importing menu from {MENU_CSV}...")
if not os.path.exists(MENU_CSV):
    bad(f"menu CSV not found: {MENU_CSV}")
    sys.exit(1)

with open(MENU_CSV) as f:
    csv_content = f.read()

fn_url = f"{SUPABASE_URL}/functions/v1/import-menu-csv"
fn_data = json.dumps({
    "shop_id": SHOP_ID,
    "menu_name": f"{TWIN_NAME} Menu",
    "csv": csv_content
}).encode()
fn_req = urllib.request.Request(fn_url, data=fn_data, method="POST")
fn_req.add_header("apikey", SUPABASE_KEY)
fn_req.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
fn_req.add_header("Content-Type", "application/json")
try:
    with urllib.request.urlopen(fn_req) as resp:
        result = json.loads(resp.read())
        if result.get("ok"):
            ok("menu imported", f"inserted={result.get('inserted','?')}, hash={result.get('import_hash','?')[:8]}")
        else:
            bad("menu import returned not-ok", str(result.get("error", result)))
except urllib.error.HTTPError as e:
    bad("menu import failed", f"HTTP {e.code}: {e.read().decode()[:200]}")

# ── 5. Verify ────────────────────────────────────────────────────────────────
print("\n[5] Verification...")

# Shop check
shop = supabase_api("GET",
    f"shops?select=id,name,slug,phone_number_e164,protected,is_test,tenant_id&id=eq.{SHOP_ID}")
if shop and len(shop) > 0:
    s = shop[0]
    ok("shop verified",
       f"protected={s.get('protected')} phone={s.get('phone_number_e164','NULL')} is_test={s.get('is_test')}")

# Item count
menus = supabase_api("GET", f"menus?shop_id=eq.{SHOP_ID}&select=id")
total_items = 0
if menus:
    for m in menus:
        items = supabase_api("GET", f"menu_items?menu_id=eq.{m['id']}&select=id&active=eq.true")
        if items:
            total_items += len(items)
    if total_items > 0:
        ok("menu verified", f"{total_items} active items")
    else:
        bad("no active menu items found")
else:
    bad("no menus found for shop")

# Tenant check
tc = supabase_api("GET", f"tenants?id=eq.{TENANT_ID}&select=id,name")
if tc and len(tc) > 0:
    ok("tenant verified", tc[0]['name'])

# ── Results ──────────────────────────────────────────────────────────────────
print("\n" + "=" * 72)
print(f"  RESULTS: {PASS} passed, {FAIL} failed")
if FAIL == 0:
    print(f"  ✅ QA twin ready: {TWIN_SLUG}")
    print(f"     Shop ID:  {SHOP_ID}")
    print(f"     Items:    {total_items}")
    print(f"     Protected: false")
    print(f"     Phone:    null")
    print(f"     Web:      getsprintai.com/admin (test chat)")
else:
    print(f"  ❌ {FAIL} step(s) failed")
print("=" * 72)
sys.exit(0 if FAIL == 0 else 1)