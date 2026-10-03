#!/usr/bin/env python3
"""uber-e2e — one delivery order at a courier shop through the DEPLOYED functions, end to end:
text -> Uber quote on the address -> read-back -> pay link -> Stripe TEST payment -> courier booked by
stripe-webhook -> Uber sandbox robo courier -> status webhooks -> deliveries row.
usage: uber-e2e.py --shop <uuid> [--address "..."] [--wait-min 20]
Costs: one model call per non-closed message (about 5), Stripe test mode and Uber sandbox are free.
Reads credentials the same way e2e.py does; prints no secrets.
"""
import argparse, json, re, shutil, subprocess, sys, time, uuid, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))
import e2e  # noqa: E402  (loads the service credentials into this process only)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--shop", required=True)
    ap.add_argument("--address", default="3300 Hamilton Blvd, Allentown, PA 18103"); ap.add_argument("--wait-min", type=float, default=20)
    a = ap.parse_args()
    s = str(uuid.uuid4()); url = None
    script = ["delivery", a.address, "a large pepperoni pizza", "thats it"]
    turns = 0
    def say(m):
        nonlocal turns; turns += 1
        r, dt = e2e.say(a.shop, s, m); print(f"C: {m}\nB: {r.replace(chr(10), ' / ')}  ({dt:.1f}s)"); return r
    for m in script:
        r = say(m)
    for _ in range(4):  # answer whatever is left (tip, confirm), bounded
        if "Pay here" in r or "pay.getsprintai" in r: break
        if "YES" in r: r = say("yes")  # the read-back also says "Tip", so YES must win
        elif re.search(r"\btip\b", r, re.I): r = say("$3 tip")
        else: r = say("thats it")
    m = re.search(r"https://\S+", r)
    cart = e2e.cart_for(a.shop, s)
    print(f"\ncart {cart and cart['id']}  turns {turns}  delivery fee {cart and cart['delivery_fee_cents']}  tip {cart and cart['driver_tip_cents']}  total {cart and cart['total_cents']}")
    if not m or not cart: print("FAIL: no pay link"); sys.exit(1)
    if cart.get("order_type") != "delivery":
        refused = e2e.get(f"engine_ledger?cart_id=eq.{cart['id']}&event=eq.courier_quote_refused&select=data")
        print("FAIL: the order fell back to pickup; courier quote refused:", json.dumps([r["data"] for r in refused])); sys.exit(1)
    url = m.group(0).rstrip(".,)")
    print("paying the Stripe TEST checkout ...")
    p = subprocess.run([shutil.which("node") or "/opt/homebrew/bin/node", os.path.join(os.path.dirname(__file__), "pay-test-checkout.cjs"), url], capture_output=True, text=True, timeout=240)
    print((p.stdout + p.stderr).strip())
    if p.returncode != 0: sys.exit(1)
    deadline = time.time() + a.wait_min * 60; last = None; row = None
    while time.time() < deadline:
        rows = e2e.get(f"deliveries?cart_id=eq.{cart['id']}&select=*")
        row = rows[0] if rows else None
        st = (row or {}).get("status"), (row or {}).get("error")
        if st != last: print(time.strftime("%H:%M:%S"), "deliveries:", st); last = st
        if row and (row.get("status") in ("dropped_off", "canceled", "returned") or row.get("error")): break
        time.sleep(15)
    c2 = e2e.get(f"order_carts?id=eq.{cart['id']}&select=id,payment_status,delivery_status,order_type,delivery_fee_cents,driver_tip_cents,total_cents")
    print("\norder_carts:", json.dumps(c2[0] if c2 else None))
    print("deliveries:", json.dumps(row, indent=1))
    ok = bool(row and row.get("delivery_id") and row.get("status") == "dropped_off")
    print("\nRESULT:", "PASS (delivered in the sandbox)" if ok else "INCOMPLETE — see the row above")
    sys.exit(0 if ok else 1)

if __name__ == "__main__": main()
