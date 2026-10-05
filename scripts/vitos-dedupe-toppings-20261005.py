#!/usr/bin/env python3
"""vitos-dedupe-toppings-20261005 — repair after a shop-chat option edit re-sent the Cheesesteak's whole toppings list and
admin-chat inserted it again (fixed in admin-chat the same day). Keeps the first of each duplicate name; removes Pickles
(Jason's request: "we don't offer pickles on the cheesesteak"). Then recompiles. usage: [--apply]"""
import json, os, sys, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "engine"))
import e2e  # noqa: E402
SHOP = "e0000000-0000-0000-0000-000000000001"; ITEM = "a01b10d0-9c1d-455e-ba29-68b5875c0753"  # Hot Sandwiches / Cheesesteak
def req(method, path, body=None, prefer="return=minimal"):
    r = urllib.request.Request(f"{e2e.U}/{path}", method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"apikey": e2e.K, "Authorization": f"Bearer {e2e.K}", "Content-Type": "application/json", "Prefer": prefer})
    with urllib.request.urlopen(r, timeout=300) as resp:
        t = resp.read().decode(); return json.loads(t) if t else None
assert e2e.get(f"shops?id=eq.{SHOP}&select=is_test")[0]["is_test"] is True
g = e2e.get(f"option_groups?menu_item_id=eq.{ITEM}&name=eq.Toppings&select=id")[0]["id"]
ch = e2e.get(f"option_choices?option_group_id=eq.{g}&select=id,name,display_order,created_at&order=created_at.asc")
seen, drop = set(), []
for c in ch:
    k = c["name"].strip().lower()
    if k in seen or k == "pickles": drop.append(c)
    else: seen.add(k)
print("keep:", sorted(seen)); print("drop:", [(c["name"], c["created_at"][11:19]) for c in drop])
if "--apply" in sys.argv:
    for c in drop: req("DELETE", f"rest/v1/option_choices?id=eq.{c['id']}")
    rep = req("POST", "functions/v1/compile-menu", {"shop_id": SHOP}, prefer="return=representation")
    print("invariants:", [(i["invariant"], i["pass"]) for i in rep.get("invariants", [])])
    print("plan:", [[c["display"] for c in st["choices"]] for st in e2e.get(f"menu_items?id=eq.{ITEM}&select=ask_plan")[0]["ask_plan"]["steps"]])
