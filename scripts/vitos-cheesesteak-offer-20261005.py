#!/usr/bin/env python3
"""vitos-cheesesteak-offer-20261005 — Vito's cheesesteaks: offer toppings once (ask_mode offer_once) and drop
"American cheese" from the descriptions now that the customer picks the cheese (Jason 2026-10-05). Then recompile.
usage: vitos-cheesesteak-offer-20261005.py [--apply]"""
import json, os, re, sys, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "engine"))
import e2e  # noqa: E402
SHOP = "e0000000-0000-0000-0000-000000000001"
def req(method, path, body=None, prefer="return=minimal"):
    r = urllib.request.Request(f"{e2e.U}/{path}", method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"apikey": e2e.K, "Authorization": f"Bearer {e2e.K}", "Content-Type": "application/json", "Prefer": prefer})
    with urllib.request.urlopen(r, timeout=300) as resp:
        t = resp.read().decode(); return json.loads(t) if t else None
assert e2e.get(f"shops?id=eq.{SHOP}&select=is_test")[0]["is_test"] is True
menu = e2e.get(f"menus?shop_id=eq.{SHOP}&select=id&order=created_at.desc&limit=1")[0]["id"]
steaks = [i for i in e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&category=eq.Hot%20Sandwiches&select=id,name,description") if "cheesesteak" in i["name"].lower()]
apply = "--apply" in sys.argv
for it in steaks:
    tops = e2e.get(f"option_groups?menu_item_id=eq.{it['id']}&name=eq.Toppings&select=id,ask_mode")
    has_cheese = bool(e2e.get(f"option_groups?menu_item_id=eq.{it['id']}&name=eq.Cheese&select=id"))
    desc = it["description"] or ""
    new = re.sub(r",\s*American cheese\b|\bAmerican cheese,\s*", "", desc) if has_cheese else desc
    new = re.sub(r"(^|\. )([a-z])", lambda m: m.group(1) + m.group(2).upper(), new)  # "Served with fries. Sauce, ..." 
    print(f"{it['name']}: toppings {[t['ask_mode'] for t in tops]} -> offer_once; desc {desc!r} -> {new!r}")
    if apply:
        for t in tops: req("PATCH", f"rest/v1/option_groups?id=eq.{t['id']}", {"ask_mode": "offer_once"})
        if new != desc: req("PATCH", f"rest/v1/menu_items?id=eq.{it['id']}", {"description": new})
if not apply: sys.exit(0)
rep = req("POST", "functions/v1/compile-menu", {"shop_id": SHOP}, prefer="return=representation")
print("invariants:", [(i["invariant"], i["pass"]) for i in rep.get("invariants", [])])
print("blocked:", [b["name"] for b in e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&bot_state=eq.blocked&select=name")])
p = e2e.get(f"menu_items?id=eq.{steaks[0]['id']}&select=name,description,ask_plan")[0]
print(p["name"], "|", p["description"], "|", [(s["kind"], s.get("ask_mode"), [c["display"] for c in s["choices"]]) for s in p["ask_plan"]["steps"]])
