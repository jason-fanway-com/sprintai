#!/usr/bin/env python3
"""engine e2e — drive scripted conversations through the DEPLOYED chat-sms web
channel for a shop and assert the DATABASE, not the prose.

usage: e2e.py --shop <uuid> [--runs 5] [--scenario canary|delivery3|narrowing|corrections|all] [--address "..."]
Reads SPRINTAI_CHAT_SUPABASE_URL / _SERVICE_ROLE_KEY from ~/.openclaw-sprintai/.secrets.
Exit 0 only when every run of every scenario passes every assertion.
"""
import argparse, json, os, sys, time, uuid, urllib.request

def load_secrets():
    p = os.path.expanduser("~/.openclaw-sprintai/.secrets")
    for line in open(p):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, v = line.split("=", 1); os.environ.setdefault(k, v.strip().strip('"').strip("'"))
load_secrets()
U = os.environ["SPRINTAI_CHAT_SUPABASE_URL"]; K = os.environ["SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY"]

def post(path, body):
    req = urllib.request.Request(f"{U}{path}", data=json.dumps(body).encode(), headers={"Authorization": f"Bearer {K}", "apikey": K, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=240) as r: return json.loads(r.read().decode())

def get(path):
    req = urllib.request.Request(f"{U}/rest/v1/{path}", headers={"Authorization": f"Bearer {K}", "apikey": K})
    with urllib.request.urlopen(req, timeout=60) as r: return json.loads(r.read().decode())

def say(shop, session, msg):
    t0 = time.time()
    r = post("/functions/v1/chat-sms", {"shop_id": shop, "message": msg, "session_id": session, "test": True})
    return r.get("reply", ""), time.time() - t0

def cart_for(shop, session):
    convs = get(f"conversations?customer_phone=eq.web:{session}&select=id&limit=1")
    if not convs: return None
    rows = get(f"order_carts?conversation_id=eq.{convs[0]['id']}&select=id,cart_json,engine_form,subtotal_cents,total_cents,tax_cents,delivery_fee_cents,driver_tip_cents,service_fee_cents,order_type,stripe_checkout_session_id,phase&order=created_at.desc&limit=1")
    return rows[0] if rows else None

# scenario = list of (message, checks) where checks is a function(cart, reply) -> list of failure strings
def lines(cart): return [(l["menu_item_id"], l["quantity"], l["price_cents"]) for l in (cart or {}).get("cart_json") or []]
def names(cart): return [l["name"] for l in (cart or {}).get("cart_json") or []]

def expect(cond, msg): return [] if cond else [msg]

def canary(addr):
    return [
        ("cheeseburger", lambda c, r: expect("cooked" in r.lower() or "Cheese Burger" in r, f"expected temp question, got: {r!r}")),
        ("medium", lambda c, r: expect(len(lines(c)) == 1 and lines(c)[0][1] == 1 and lines(c)[0][2] == 849, f"cart {lines(c)}")),
        ("pickup", lambda c, r: expect(c["order_type"] == "pickup", f"order_type {c['order_type']}") + expect("Anything else" in r, f"expected anything else: {r!r}")),
        ("thats it", lambda c, r: expect("Reply YES" in r, f"expected readback, got: {r!r}") + expect(c["subtotal_cents"] == 849, f"subtotal {c['subtotal_cents']}")),
        ("yes", lambda c, r: expect(bool(c["stripe_checkout_session_id"]), "no checkout session") + expect(c["total_cents"] == 849 + 99 + c["tax_cents"], f"total {c['total_cents']} vs 948+tax {c['tax_cents']}") + expect(len(lines(c)) == 1, f"extra lines {names(c)}")),
    ]

def delivery3(addr):
    return [
        ("hi", lambda c, r: expect("ickup or delivery" in r, f"opener: {r!r}")),
        ("delivery, 2 large pepperoni pizzas and an order of garlic knots", lambda c, r: expect(len(lines(c)) == 2, f"expected 2 lines, got {names(c)}") + expect(any(q == 2 for _, q, _ in lines(c)), f"qty {lines(c)}") + expect("address" in r.lower(), f"expected address question: {r!r}")),
        (addr, lambda c, r: expect(c["order_type"] == "delivery", f"order_type {c['order_type']}") + expect("Anything else" in r, f"expected anything else: {r!r}")),
        ("thats it", lambda c, r: expect("tip" in r.lower(), f"expected tip question: {r!r}")),
        ("20", lambda c, r: expect("Reply YES" in r, f"expected readback: {r!r}") + expect(c["driver_tip_cents"] == round(c["subtotal_cents"] * 0.2), f"tip {c['driver_tip_cents']} vs 20% of {c['subtotal_cents']}")),
        ("yes", lambda c, r: expect(bool(c["stripe_checkout_session_id"]), "no checkout session") + expect(len(lines(c)) == 2, f"lines {names(c)}") + expect(c["total_cents"] == c["subtotal_cents"] + c["service_fee_cents"] + c["delivery_fee_cents"] + c["driver_tip_cents"] + c["tax_cents"], "total mismatch")),
    ]

def narrowing(addr):
    return [
        ("pickup", lambda c, r: []),
        ("I want a pizza", lambda c, r: expect("pizza" in r.lower() and ("kind" in r.lower() or "which" in r.lower()), f"expected kind question: {r!r}") + expect(len(lines(c)) == 0, f"nothing should be priced yet: {names(c)}")),
        ("pepperoni", lambda c, r: expect("size" in r.lower(), f"expected size question: {r!r}")),
        ("large", lambda c, r: expect(len(lines(c)) == 1 and "Pepperoni" in names(c)[0] and "Large" in names(c)[0], f"lines {names(c)}")),
        ("whats in my cart", lambda c, r: expect("Pepperoni" in r, f"cart readback missing item: {r!r}") + expect(len(lines(c)) == 1, f"lines changed: {names(c)}")),
    ]

def corrections(addr):
    return [
        ("pickup", lambda c, r: []),
        ("a large cheese pizza and garlic knots", lambda c, r: expect(len(lines(c)) == 2, f"lines {names(c)}")),
        ("make that 3 knots", lambda c, r: expect(any(q == 3 for _, q, _ in lines(c)), f"qty {lines(c)}") + expect(len(lines(c)) == 2, f"lines {names(c)}")),
        ("actually pepperoni not cheese", lambda c, r: expect(not any("Cheese" in n for n in names(c)), f"cheese still there: {names(c)}")),
        ("large", lambda c, r: expect(any("Large Pepperoni" in n for n in names(c)), f"lines {names(c)}") + expect(len(lines(c)) == 2, f"lines {names(c)}")),
        ("remove the knots", lambda c, r: expect(len(lines(c)) == 1 and "Pepperoni" in names(c)[0], f"lines {names(c)}")),
        ("thats it", lambda c, r: expect("Reply YES" in r, f"expected readback: {r!r}") + expect(c["subtotal_cents"] == lines(c)[0][2] * lines(c)[0][1], "subtotal mismatch")),
    ]

SCEN = {"canary": canary, "delivery3": delivery3, "narrowing": narrowing, "corrections": corrections}

def run(shop, name, steps):
    session = str(uuid.uuid4()); fails = []; transcript = []; ms = []
    for msg, check in steps:
        reply, dt = say(shop, session, msg); ms.append(dt)
        cart = cart_for(shop, session)
        transcript.append((msg, reply, dt))
        f = check(cart or {}, reply)
        if f: fails.extend([f"after {msg!r}: {x}" for x in f])
    return fails, transcript, ms

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--shop", required=True); ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--scenario", default="all"); ap.add_argument("--address", default="3300 Hamilton Blvd, Allentown, PA 18103"); ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    which = list(SCEN) if a.scenario == "all" else [a.scenario]
    total = 0; passed = 0; all_ms = []
    for name in which:
        for i in range(a.runs):
            total += 1
            fails, transcript, ms = run(a.shop, name, SCEN[name](a.address)); all_ms += ms
            ok = not fails; passed += ok
            print(f"[{name} #{i+1}] {'PASS' if ok else 'FAIL'}  ({sum(ms):.1f}s, max turn {max(ms):.1f}s)")
            if not ok or a.verbose:
                for m, r, dt in transcript: print(f"    C: {m}\n    B: {r.replace(chr(10), ' / ')}  ({dt:.1f}s)")
                for f in fails: print(f"    !! {f}")
    all_ms.sort(); p50 = all_ms[len(all_ms)//2] if all_ms else 0; p95 = all_ms[int(len(all_ms)*0.95)-1] if all_ms else 0
    print(f"\n{passed}/{total} runs passed; turn p50 {p50:.1f}s p95 {p95:.1f}s")
    sys.exit(0 if passed == total else 1)

if __name__ == "__main__": main()
