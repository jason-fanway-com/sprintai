#!/usr/bin/env python3
"""Run one scripted order against chat-sms-mtest under 3 models; report cart per turn."""
import json, os, sys, time, urllib.request, uuid

PROJ = "rvdqfxtrskxekfkqnegx"
BASE = f"https://{PROJ}.supabase.co/functions/v1/chat-sms-mtest"
SHOP = "22ed2761-a3f2-5bde-9012-916a93c521cd"  # Vito's Pizza (QA)
ANON = os.environ["SUPABASE_ANON_KEY"]

SCRIPT = [
    "large plain pizza",
    "Large fries and some wings",
    "Wings",
    "Add wings, bone in, all hot",
]
MODELS = [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    "anthropic/claude-sonnet-4.6",
]

def post(model, session_id, message):
    url = f"{BASE}?bot_model={urllib.parse.quote(model)}"
    body = json.dumps({"shop_id": SHOP, "message": message,
                       "session_id": session_id, "test": True}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {ANON}",
        "apikey": ANON,
    })
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())

def cart_summary(cart):
    if not cart: return []
    out = []
    for it in cart:
        nm = it.get("name") or it.get("item_name") or "?"
        qty = it.get("quantity") or it.get("qty") or 1
        out.append(f"{qty}x {nm}")
    return out

results = {}
for model in MODELS:
    sid = f"mtest-{uuid.uuid4()}"
    print(f"\n===== {model} (session {sid}) =====", flush=True)
    turns = []
    prev_len = 0
    for i, msg in enumerate(SCRIPT, 1):
        try:
            resp = post(model, sid, msg)
        except Exception as e:
            print(f"  turn {i} ERROR: {e}", flush=True)
            turns.append({"turn": i, "msg": msg, "error": str(e)})
            continue
        cart = resp.get("cart") or []
        summ = cart_summary(cart)
        added = len(cart) - prev_len
        prev_len = len(cart)
        reply = (resp.get("reply") or "").replace("\n", " ")[:160]
        turns.append({"turn": i, "msg": msg, "cart_size": len(cart),
                      "added_delta": added, "cart": summ, "reply": reply,
                      "phase": resp.get("phase")})
        print(f"  T{i} '{msg}' -> cart({len(cart)}) Δ{added:+d} {summ}", flush=True)
        print(f"      reply: {reply}", flush=True)
        time.sleep(1)
    results[model] = turns

print("\n\n===== JSON =====")
print(json.dumps(results, indent=1))
