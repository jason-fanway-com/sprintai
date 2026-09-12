#!/usr/bin/env python3
"""Item 8 P0 acceptance battery (392894c fix verification, 2026-09-08).
Ten consecutive live runs against chat-sms, channel=web, Zio's real shop id,
engine ON. Not committed to the repo — scratch verification script."""
import json
import os
import subprocess
import sys
import uuid

URL = os.environ["SPRINTAI_CHAT_SUPABASE_URL"].rstrip("/") + "/functions/v1/chat-sms"
KEY = os.environ["SPRINTAI_CHAT_SUPABASE_ANON_KEY"]
SHOP_ID = "2cba7b51-211c-4437-8910-1af4dcc03498"

TURNS = ["pickup", "I want 4 large pizzas", "1 pepp, 1 plain, 1 hawaiin, 1 meat lovers"]

def post(session_id, message):
    body = json.dumps({"shop_id": SHOP_ID, "message": message, "session_id": session_id})
    r = subprocess.run(
        ["curl", "-s", "-X", "POST", URL,
         "-H", f"apikey: {KEY}", "-H", f"Authorization: Bearer {KEY}",
         "-H", "Content-Type: application/json", "-d", body],
        capture_output=True, text=True, timeout=170,
    )
    return r.stdout

def run_once(n):
    session_id = str(uuid.uuid4()).upper()
    print(f"\n===== RUN {n} (session {session_id}) =====")
    last = None
    for t in TURNS:
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
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    results = []
    for i in range(1, n + 1):
        sid, last = run_once(i)
        results.append((sid, last))
    print("\n\n===== SUMMARY =====")
    for i, (sid, last) in enumerate(results, 1):
        cart = (last or {}).get("cart", [])
        names = [f"{c.get('quantity')}x {c.get('name')} opts={c.get('options')}" for c in cart]
        total = sum((c.get("price_cents", 0) or 0) * (c.get("quantity", 1) or 1) for c in cart)
        print(f"run {i} ({sid}): {len(cart)} lines, total_before_fees={total} -> {names}")
