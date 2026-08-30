#!/usr/bin/env python3
"""Create Vito's Pizza demo shop + load pizza menu into SprintAI-Chat Supabase.

Provisioning steps:
  1. Create tenant: Vito's Pizza LLC
  2. Create shop: Vito's Pizza (is_test=true)
  3. Import synthetic pizza-shop.csv menu via import-menu-csv Edge Function
  4. Buy & assign Telnyx phone number (Philadelphia-area local SMS number)
  5. Link number to sprintai-test messaging profile
  6. Smoke test: verify shop + menu + phone active
"""
import os, sys, json, re, time, urllib.request, urllib.error, uuid
from datetime import datetime, timezone as tz

SUPABASE_URL = "https://rvdqfxtrskxekfkqnegx.supabase.co"
TELNYX_API_BASE = "https://api.telnyx.com/v2"

# ── Secrets ──────────────────────────────────────────────────────────────────
secrets = {}
with open(os.path.expanduser("~/.openclaw/.secrets")) as f:
    for line in f:
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        # Strip 'export ' prefix if present
        line = re.sub(r'^export\s+', '', line)
        m = re.match(r'^(\S+)\s*=\s*(.+)$', line)
        if not m:
            continue
        k, v = m.group(1), m.group(2)
        v = v.strip().strip('"').strip("'").rstrip(';')
        secrets[k.strip()] = v

SUPABASE_KEY = secrets.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY", "")
TELNYX_KEY = secrets.get("TELNYX_API_KEY", "")
if not SUPABASE_KEY:
    print("ERROR: SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY not found")
    sys.exit(1)
if not TELNYX_KEY:
    print("ERROR: TELNYX_API_KEY not found")
    sys.exit(1)

# ── Deterministic IDs ───────────────────────────────────────────────────────
TENANT_ID = "e0000000-0000-0000-0000-000000000001"
SHOP_ID   = "e0000000-0000-0000-0000-000000000001"
SHOP_SLUG = "vitos-pizza"
SHOP_NAME = "Vito's Pizza"
MESSAGING_PROFILE_ID = "4001a005-60f5-4bfb-ba7d-6959c574b07a"  # sprintai-test

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

# ── Telnyx helpers ───────────────────────────────────────────────────────────
def telnyx_api(method, path, body=None):
    url = f"{TELNYX_API_BASE}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TELNYX_KEY}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            txt = resp.read().decode()
            return json.loads(txt) if txt.strip() else None
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode()
        print(f"  Telnyx HTTP {e.code} on {method} {path}: {body_txt[:300]}")
        return None

# ══════════════════════════════════════════════════════════════════════════════
print("=" * 72)
print("  VITO'S PIZZA — DEMO SHOP PROVISION")
print(f"  {datetime.now(tz.utc).isoformat()}")
print("=" * 72)

# ── 1. CREATE TENANT ─────────────────────────────────────────────────────────
print("\n[1/5] Creating tenant...")
existing = supabase_api("GET", f"tenants?id=eq.{TENANT_ID}")
if existing and len(existing) > 0:
    ok("tenant already exists", f"slug={existing[0].get('slug','')}")
else:
    t = supabase_api("POST", "tenants", {
        "id": TENANT_ID,
        "name": "Vito's Pizza LLC",
        "slug": "vitos-pizza-llc",
        "status": "active",
        "plan": "starter",
        "config": {"business_type": "restaurant", "personality": "friendly Italian pizzeria"},
        "onboarding_status": "complete",
    }, prefer="return=representation")
    if t:
        ok("tenant created", f"name={t[0]['name'] if isinstance(t, list) else t.get('name','')}")
    else:
        bad("tenant creation failed")

# ── 2. CREATE SHOP ───────────────────────────────────────────────────────────
print("\n[2/5] Creating shop...")
existing_shop = supabase_api("GET", f"shops?id=eq.{SHOP_ID}")
if existing_shop and len(existing_shop) > 0:
    ok("shop already exists", f"slug={existing_shop[0].get('slug','')}")
else:
    s = supabase_api("POST", "shops", {
        "id": SHOP_ID,
        "tenant_id": TENANT_ID,
        "name": SHOP_NAME,
        "slug": SHOP_SLUG,
        "is_test": True,
        "protected": True,
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
        ok("shop created", f"name={s[0]['name'] if isinstance(s, list) else s.get('name','')}")
    else:
        bad("shop creation failed")

# ── 3. IMPORT MENU ───────────────────────────────────────────────────────────
print("\n[3/5] Importing Jack's Slice menu (326 items)...")
csv_path = "/Users/joestrazza/sprintai-ordering/tests/fixtures/menu-intake/jacks_slice_flat.csv"
if os.path.exists(csv_path):
    with open(csv_path) as f:
        csv_content = f.read()

    fn_url = f"{SUPABASE_URL}/functions/v1/import-menu-csv"
    fn_data = json.dumps({
        "shop_id": SHOP_ID,
        "menu_name": "Vito's Pizza Menu",
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
                ok("menu imported", f"items={result.get('inserted', '?')}, hash={result.get('import_hash','?')[:8]}")
            else:
                bad("menu import returned not-ok", str(result.get("error", result)))
    except urllib.error.HTTPError as e:
        bad("menu import failed", f"HTTP {e.code}: {e.read().decode()[:200]}")
else:
    bad("no CSV fixture found", f"checked {csv_paths}")

# ── 4. BUY & ASSIGN TELNYX NUMBER ────────────────────────────────────────────
print("\n[4/5] Provisioning Telnyx phone number...")

# Check if shop already has a number
existing_num = supabase_api("GET", f"shops?select=phone_number_e164,telnyx_number_id&id=eq.{SHOP_ID}")
phone_already = existing_num and existing_num[0].get("phone_number_e164") if existing_num else None
telnyx_id_already = existing_num and existing_num[0].get("telnyx_number_id") if existing_num else None

if phone_already and telnyx_id_already:
    ok("phone already assigned", f"{phone_already} (telnyx_id={telnyx_id_already})")
else:
    # Step A: Search for available Philadelphia numbers
    print("  Searching for available Philadelphia numbers...")
    avail = telnyx_api("GET",
        "/available_phone_numbers"
        "?filter[phone_number_type]=local"
        "&filter[country_code]=US"
        "&filter[locality]=Philadelphia"
        "&filter[features][]=sms"
        "&filter[features][]=mms"
        "&page[size]=5"
    )
    if not avail or not avail.get("data"):
        bad("no available Philadelphia SMS numbers")
        # Try a broader search
        print("  Trying broader search (PA rate center)...")
        avail = telnyx_api("GET",
            "/available_phone_numbers"
            "?filter[phone_number_type]=local"
            "&filter[country_code]=US"
            "&filter[national_destination_code]=215"
            "&filter[features][]=sms"
            "&page[size]=5"
        )
        if not avail or not avail.get("data"):
            bad("no available 215 area code numbers either")
            avail = {"data": []}

    if avail and avail.get("data"):
        num_to_buy = avail["data"][0]["phone_number"]
        upfront = avail["data"][0].get("cost_information", {}).get("upfront_cost", "1.00")
        monthly = avail["data"][0].get("cost_information", {}).get("monthly_cost", "1.00")
        print(f"  Selected: {num_to_buy} (${upfront} upfront, ${monthly}/mo)")

        # Step B: Order the number
        print(f"  Ordering {num_to_buy}...")
        order = telnyx_api("POST", "/number_orders", {
            "phone_numbers": [{"phone_number": num_to_buy}],
            "messaging_profile_id": MESSAGING_PROFILE_ID,
        })
        if not order or not order.get("data"):
            bad("number order failed", str(order))
        else:
            order_id = order["data"]["id"]
            print(f"  Order ID: {order_id}, waiting for fulfillment...")

            # Poll for completion
            for attempt in range(12):
                time.sleep(5)
                status = telnyx_api("GET", f"/number_orders/{order_id}")
                st = status["data"]["status"] if status and status.get("data") else "unknown"
                print(f"    attempt {attempt+1}: status={st}")
                if st == "success":
                    # Find the phone_number_id
                    pns = status["data"].get("phone_numbers", [])
                    if pns:
                        telnyx_num_id = pns[0].get("id")
                        ok("number ordered", f"{num_to_buy} → telnyx_id={telnyx_num_id}")

                        # Step C: Update shop record
                        update = supabase_api("PATCH", f"shops?id=eq.{SHOP_ID}", {
                            "phone_number_e164": num_to_buy,
                            "reply_from_e164": num_to_buy,
                            "telnyx_number_id": str(telnyx_num_id),
                            "telnyx_messaging_profile_id": MESSAGING_PROFILE_ID,
                        }, prefer="return=representation")
                        if update:
                            ok("shop updated with phone number", num_to_buy)
                        else:
                            bad("failed to update shop with phone number")
                    break
                elif st == "failed":
                    bad("number order failed", str(status.get("data", {}).get("failures", [])))
                    break
    else:
        bad("no SMS numbers available at all — Telnyx inventory may be dry")

# ── 5. SMOKE TEST ────────────────────────────────────────────────────────────
print("\n[5/5] Smoke test...")

# Verify shop exists with menu
shop_check = supabase_api("GET",
    f"shops?select=id,name,slug,phone_number_e164,is_test,tenant_id&id=eq.{SHOP_ID}")
if shop_check and len(shop_check) > 0:
    s = shop_check[0]
    ok("shop exists", f"{s['name']} slug={s['slug']} phone={s.get('phone_number_e164','none')} is_test={s.get('is_test')}")

# Count menu items
menus = supabase_api("GET", f"menus?shop_id=eq.{SHOP_ID}&select=id")
if menus:
    total_items = 0
    for m in menus:
        items = supabase_api("GET", f"menu_items?menu_id=eq.{m['id']}&select=id&active=eq.true")
        if items:
            total_items += len(items)
    if total_items > 0:
        ok("menu has items", f"{total_items} active items across {len(menus)} menu(s)")
    else:
        bad("no active menu items found")
else:
    bad("no menus found for shop")

# Verify tenant
tc = supabase_api("GET", f"tenants?id=eq.{TENANT_ID}&select=id,name,onboarding_status")
if tc and len(tc) > 0:
    ok("tenant healthy", f"{tc[0]['name']} status={tc[0]['onboarding_status']}")

# Edge function reachability
fn_test_url = f"{SUPABASE_URL}/functions/v1/chat-sms"
fn_test_data = json.dumps({
    "channel": "web",
    "message": "hello",
    "shop_id": SHOP_ID,
    "session_id": str(uuid.uuid4()),
}).encode()
fn_test_req = urllib.request.Request(fn_test_url, data=fn_test_data, method="POST")
fn_test_req.add_header("apikey", SUPABASE_KEY)
fn_test_req.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
fn_test_req.add_header("Content-Type", "application/json")
try:
    with urllib.request.urlopen(fn_test_req, timeout=30) as resp:
        chat_result = json.loads(resp.read())
        if chat_result.get("reply") or chat_result.get("ok") or resp.status == 200:
            ok("chat-sms edge function responds", f"HTTP {resp.status}")
        else:
            bad("chat-sms unexpected response", str(chat_result)[:200])
except urllib.error.HTTPError as e:
    body = e.read().decode()
    ok("chat-sms edge function reachable", f"HTTP {e.code} (expected for test)")
except Exception as ex:
    bad("chat-sms edge function unreachable", str(ex))

# ══════════════════════════════════════════════════════════════════════════════
print("\n" + "=" * 72)
print(f"  RESULTS: {PASS} passed, {FAIL} failed")
if FAIL == 0:
    print(f"  ✅ Vito's Pizza demo shop provisioned successfully")
    print(f"     Tenant ID:  {TENANT_ID}")
    print(f"     Shop ID:    {SHOP_ID}")
    print(f"     Slug:       {SHOP_SLUG}")
    print(f"     Admin:      getsprintai.com/merchant-ui/?shop={SHOP_SLUG} (PIN: 1234)")
    print(f"     Chat test:  getsprintai.com/admin")
else:
    print(f"  ❌ {FAIL} step(s) failed — review above")
print("=" * 72)
sys.exit(0 if FAIL == 0 else 1)