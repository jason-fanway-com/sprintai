#!/usr/bin/env python3
"""PO scope-addition verify (2026-09-08): does the 392894c/item-8 fix
(compiled add_item honoring model-asserted modifiers/options) generalize
beyond pizza-topping composition to OTHER stated attributes on OTHER
slot/modifier kinds -- specifically Zio's "dressing" (modifier kind,
non-blocking) and "pasta type" (slot kind "choice", blocking/required)?
Live runs against chat-sms, channel=web, Zio's real shop id, engine ON.
Attribute is stated in the SAME turn as the add, per PO instruction.
Not committed to the repo -- scratch verification script."""
import json
import os
import subprocess
import sys
import uuid

URL = os.environ["SPRINTAI_CHAT_SUPABASE_URL"].rstrip("/") + "/functions/v1/chat-sms"
KEY = os.environ["SPRINTAI_CHAT_SUPABASE_ANON_KEY"]
SHOP_ID = "2cba7b51-211c-4437-8910-1af4dcc03498"

SCENARIOS = {
    "dressing (modifier kind, salad)": ["pickup", "I'll get a Zio's Salad with ranch dressing"],
    "pasta type (slot kind, required)": ["pickup", "I'll get the Pasta Carbonara with linguine"],
}

def post(session_id, message):
    body = json.dumps({"shop_id": SHOP_ID, "message": message, "session_id": session_id})
    r = subprocess.run(
        ["curl", "-s", "-X", "POST", URL,
         "-H", f"apikey: {KEY}", "-H", f"Authorization: Bearer {KEY}",
         "-H", "Content-Type: application/json", "-d", body],
        capture_output=True, text=True, timeout=170,
    )
    return r.stdout

def run_scenario(label, turns):
    session_id = str(uuid.uuid4()).upper()
    print(f"\n===== SCENARIO: {label} (session {session_id}) =====")
    last = None
    for t in turns:
        print(f"--- turn: {t!r} ---")
        raw = post(session_id, t)
        print(raw)
        try:
            last = json.loads(raw)
        except Exception as e:
            print(f"JSON PARSE ERROR: {e}")
            last = None
    return session_id, last

if __name__ == "__main__":
    results = []
    for label, turns in SCENARIOS.items():
        sid, last = run_scenario(label, turns)
        results.append((label, sid, last))
    print("\n\n===== SUMMARY =====")
    for label, sid, last in results:
        cart = (last or {}).get("cart", [])
        names = [f"{c.get('quantity')}x {c.get('name')} opts={c.get('options')} pending={c.get('pending_options')}" for c in cart]
        reply = (last or {}).get("reply") or (last or {}).get("message")
        print(f"[{label}] ({sid}): {len(cart)} lines -> {names}")
        print(f"  reply: {reply!r}")
