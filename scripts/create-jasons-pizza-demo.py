#!/usr/bin/env python3
"""Create Jason's Pizza demo shop + load pizza menu into SprintAI-Chat Supabase."""
import os, json, urllib.request, urllib.error

SUPABASE_URL = "https://rvdqfxtrskxekfkqnegx.supabase.co"
# Read from secrets file to avoid copy-paste corruption
import re
secrets = {}
with open(os.path.expanduser("~/.openclaw/.secrets")) as f:
    for line in f:
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        m = re.match(r'^(\S+)\s*=\s*"?(.+?)"?$', line)
        if not m:
            continue
        k, v = m.group(1), m.group(2)
        secrets[k.strip()] = v.strip().strip('"').strip("'")

KEY = secrets.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY", "")
if not KEY:
    print("ERROR: SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY not found in secrets")
    exit(1)

def api(method, path, body=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("apikey", KEY)
    req.add_header("Authorization", f"Bearer {KEY}")
    if body:
        req.add_header("Content-Type", "application/json")
        req.add_header("Prefer", "return=representation")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"HTTP {e.code}: {body}")
        return None

# 1. Create tenant
print("Creating tenant...")
t = api("POST", "tenants", {"id": "d0000000-0000-0000-0000-000000000001", "name": "Jason's Pizza Demo", "slug": "jasons-pizza-demo"})
print(f"  Tenant: {t}")

# 2. Create shop
print("Creating shop...")
s = api("POST", "shops", {
    "id": "d0000000-0000-0000-0000-000000000001",
    "tenant_id": "d0000000-0000-0000-0000-000000000001",
    "name": "Jason's Pizza",
    "slug": "jasons-pizza",
    "phone_number_e164": "+16107358315",
    "reply_from_e164": "+16107358315",
    "protected": True,
    "subscription_pm_set": True,
    "timezone": "America/New_York"
})
print(f"  Shop: {s}")

# 3. Import pizza menu via edge function
print("Importing pizza menu...")
with open("/Users/joestrazza/sprintai-ordering/menu-pipeline/out/pizza-shop.csv") as f:
    csv_content = f.read()

fn_url = f"{SUPABASE_URL}/functions/v1/import-menu-csv"
fn_data = json.dumps({
    "shop_id": "d0000000-0000-0000-0000-000000000001",
    "menu_name": "Jason's Pizza Menu",
    "csv": csv_content
}).encode()
fn_req = urllib.request.Request(fn_url, data=fn_data, method="POST")
fn_req.add_header("apikey", KEY)
fn_req.add_header("Authorization", f"Bearer {KEY}")
fn_req.add_header("Content-Type", "application/json")
try:
    with urllib.request.urlopen(fn_req) as resp:
        result = json.loads(resp.read())
        print(json.dumps(result, indent=2))
except urllib.error.HTTPError as e:
    print(f"Edge function HTTP {e.code}: {e.read().decode()}")

print("\nDone!")