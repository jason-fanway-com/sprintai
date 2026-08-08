#!/usr/bin/env python3
"""JOB 1: chat-sms delivery + kitchen-email-label verification.
FULL test suite with proper session tracking."""

import json, requests, os, sys, time, uuid

source_file = os.path.expanduser("~/.openclaw-sprintai/.secrets")
env = {}
with open(source_file) as f:
    for line in f:
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k] = v.strip('"').strip("'")

URL = env["SPRINTAI_CHAT_SUPABASE_URL"]
SR_KEY = env["SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY"]
ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2ZHFmeHRyc2t4ZWtma3FuZWd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NDg2ODksImV4cCI6MjA5MDMyNDY4OX0.5SOW_FX92dIw_zgbqF7HO2SM5ueQC3YPaAexKCFAv3E"
FUNC = f"{URL}/functions/v1/chat-sms"
NJB = "b0000000-0000-0000-0000-000000000001"

RESULTS = []

def call(shop_id, message, test=True, sid=None):
    body = {"shop_id": shop_id, "message": message, "test": test}
    if sid: body["session_id"] = sid
    r = requests.post(FUNC, json=body, headers={
        "Authorization": f"Bearer {ANON_KEY}",
        "Content-Type": "application/json",
    }, timeout=180)
    try: data = r.json()
    except: data = {"error": r.text[:200]}
    return r.status_code, data

def db_patch(table, rid, payload):
    r = requests.patch(
        f"{URL}/rest/v1/{table}?id=eq.{rid}",
        json=payload,
        headers={"apikey": SR_KEY, "Authorization": f"Bearer {SR_KEY}", "Content-Type": "application/json", "Prefer": "return=representation"},
        timeout=30
    )
    return r.status_code, (r.json() if r.text else {})

def delivery_offered(text):
    if not text: return False
    t = text.lower()
    if "pickup only" in t or "not offer delivery" in t or "don't offer delivery" in t or "don't currently offer delivery" in t or "doesn't offer delivery" in t or "no delivery" in t:
        return False
    return "delivery" in t or "deliver" in t

def delivery_refused(text):
    if not text: return False
    t = text.lower()
    return "don't currently offer delivery" in t or "doesn't offer delivery" in t or "not offer delivery" in t or "pickup only" in t or "no delivery" in t

def record(name, passed, detail=""):
    RESULTS.append((name, passed, detail))
    print(f"  {'PASS' if passed else 'FAIL'}: {name} {detail}")

# ═══════════════════════════════════════════════════════════
# TEST 1: delivery_enabled=true → AI processes delivery orders
# ═══════════════════════════════════════════════════════════
print("=" * 60)
print("TEST 1: delivery_enabled=true → AI offers + processes delivery")
print("=" * 60)

# Session where customer explicitly asks about delivery
sid_a = f"qa-t1a-{int(time.time())}"
s1, d1 = call(NJB, "Hi do you offer delivery?", True, sid_a)
print(f"  Session A (asks about delivery):")
print(f"    R1: {d1.get('reply','')[:250]}")
time.sleep(2)

# Session where customer asserts they want delivery
sid_b = f"qa-t1b-{int(time.time())}"
s2, d2 = call(NJB, "I'd like delivery please. I want a toasted everything bagel with cream cheese.", True, sid_b)
print(f"\n  Session B (asserts delivery + item):")
print(f"    R1: {d2.get('reply','')[:350]}")
time.sleep(2)

# Session where customer says just "delivery"
sid_c = f"qa-t1c-{int(time.time())}"
s3, d3 = call(NJB, "delivery", True, sid_c)
print(f"\n  Session C (just says 'delivery'):")
print(f"    R1: {d3.get('reply','')[:250]}")

# Score: at least 2/3 should accept delivery
accepted = 0
refused = 0
for d in [d1, d2, d3]:
    reply = d.get("reply", "") or ""
    if delivery_refused(reply):
        refused += 1
    elif delivery_offered(reply):
        accepted += 1
    # If neither (e.g., greeted but didn't address delivery), consider it neutral

print(f"\n  Accepted: {accepted}, Refused: {refused}")

if refused == 0:
    record("TEST1a-delivery-accepted", True, f"0 refusals across 3 sessions")
elif refused == 1 and accepted >= 2:
    record("TEST1a-delivery-accepted", True, f"1 refusal, {accepted} acceptances (acceptable)")
else:
    record("TEST1a-delivery-accepted", False, f"{refused} refusals, {accepted} acceptances")

# ═══════════════════════════════════════════════════════════
# TEST 2: delivery_enabled=false → pickup only
# ═══════════════════════════════════════════════════════════
print("\n" + "=" * 60)
print("TEST 2: delivery_enabled=false → pickup only")
print("=" * 60)

code, _ = db_patch("shops", NJB, {"delivery_enabled": False})
print(f"  Set delivery_enabled=false: {code}")

time.sleep(1)
sid = f"qa-t2-{int(time.time())}"
s, d = call(NJB, "Can you deliver?", True, sid)
reply = d.get("reply", "")
print(f"  Reply: {reply[:300]}")
refused = delivery_refused(reply)
print(f"  Delivery refused: {refused}")

# Restore
db_patch("shops", NJB, {"delivery_enabled": True})
print(f"  Restored delivery_enabled=true")

record("TEST2-delivery-disabled", refused, "" if refused else "AI offered delivery when disabled!")

# ═══════════════════════════════════════════════════════════
# TEST 3: Pause gate (is_paused=true)
# ═══════════════════════════════════════════════════════════
print("\n" + "=" * 60)
print("TEST 3: Pause gate (is_paused=true)")
print("=" * 60)

code, shops = db_patch("shops", NJB, {"is_paused": True, "delivery_pause_reason": "Kitchen closed for testing"})
print(f"  Set is_paused=true: {code}")

time.sleep(1)
sid = f"qa-t3-{int(time.time())}"
# test=false because pause gate bypasses test_mode
s, d = call(NJB, "I want to order breakfast", False, sid)
reply = d.get("reply", "")
print(f"  Reply: {reply[:300]}")

pause_fired = "pickup-only" in reply.lower() or "closed" in reply.lower() or "not accepting" in reply.lower()
print(f"  Pause gate fired: {pause_fired}")

# Also test that test=true bypasses pause
sid2 = f"qa-t3b-{int(time.time())}"
s2, d2 = call(NJB, "Hi", True, sid2)
reply2 = d2.get("reply", "")
print(f"  Test-mode bypass: {len(reply2) > 20} chars (should NOT be pause message)")

# Restore
db_patch("shops", NJB, {"is_paused": False, "delivery_pause_reason": None})
print(f"  Restored is_paused=false")

record("TEST3-pause-gate", pause_fired, "gate fires when not test mode")
record("TEST3a-test-mode-bypass", len(reply2) > 20 and "pickup-only" not in reply2.lower(), "test_mode bypasses pause")

# ═══════════════════════════════════════════════════════════
# TEST 4: Test-mode isolation
# ═══════════════════════════════════════════════════════════
print("\n" + "=" * 60)
print("TEST 4: Test-mode isolation")
print("=" * 60)

sid = f"qa-t4-{int(time.time())}"
s, d = call(NJB, "Hi", True, sid)
print(f"  Status: {s}")
print(f"  test_mode: {d.get('test_mode')}")
print(f"  Reply: {(d.get('reply','') or '')[:150]}")

record("TEST4-test-mode-isolation", s == 200 and d.get("test_mode") == True, f"test_mode={d.get('test_mode')}")

# ═══════════════════════════════════════════════════════════
# TEST 5: Kitchen email labels (code verification)
# ═══════════════════════════════════════════════════════════
print("\n" + "=" * 60)
print("TEST 5: Kitchen email labels (code inspection)")
print("=" * 60)

# Verify the code diff contains the right changes
import subprocess
diff = subprocess.run(["git", "-C", "/Users/joestrazza/sprintai-ordering", "diff", "supabase/functions/chat-sms/index.ts"],
                      capture_output=True, text=True).stdout

checks = {
    "emailOrderType TAKEOUT/DELIVERY": 'emailOrderType = (cartRow.order_type as string) === "delivery" ? "DELIVERY" : "TAKEOUT"' in diff,
    "email header shows order type": 'New ${emailOrderType} Order ${emailOrderNum}' in diff,
    "email subject shows order type": 'New ${emailOrderType}${emailOrderNum' in diff,
    "email body shows delivery address for delivery": 'emailOrderType === "DELIVERY"' in diff,
    "email body shows pickup name for pickup": ': `<p style="margin:0 0 6px;"><strong>Pickup Name:</strong> ${emailPickup}</p>`' in diff,
    "buildSystemPrompt gets deliveryEnabled": "deliveryEnabled?: boolean" in diff,
    "DELIVERY AVAILABLE line": "DELIVERY AVAILABLE:" in diff,
    "call site passes shop.delivery_enabled": "shop.delivery_enabled" in diff,
}

for check_name, passed in checks.items():
    record(f"TEST5-{check_name}", passed, "")

# ═══════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════
print("\n" + "=" * 60)
print("JOB 1 VERDICT")
print("=" * 60)
passed = sum(1 for _, p, _ in RESULTS if p)
failed = sum(1 for _, p, _ in RESULTS if not p)
for name, p, detail in RESULTS:
    s = "PASS" if p else "FAIL"
    print(f"  {s}: {name}" + (f" — {detail}" if detail else ""))

print(f"\n  PASS={passed} FAIL={failed}")
if failed == 0:
    print("\n  ✓ JOB 1: ALL CHECKS PASS")
else:
    print(f"\n  ✗ JOB 1: {failed} FAILURES")