#!/usr/bin/env python3
"""vitos-cheesesteak-terms-20261005 — on Vito's the words "cheesesteak" / "chicken cheesesteak" also name the
"Cheesesteak / Chicken Cheesesteak" salad and wrap, so "cheesesteak" lists them among the others (Jason 2026-10-05).
Lexicon rows with provenance owner_confirmed (the compiler never deactivates those). usage: [--apply]"""
import json, os, sys, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "engine"))
import e2e  # noqa: E402
SHOP = "e0000000-0000-0000-0000-000000000001"
assert e2e.get(f"shops?id=eq.{SHOP}&select=is_test")[0]["is_test"] is True
menu = e2e.get(f"menus?shop_id=eq.{SHOP}&select=id&order=created_at.desc&limit=1")[0]["id"]
items = e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&name=eq.Cheesesteak%20%2F%20Chicken%20Cheesesteak&select=id,display_name")
rows = []
for it in items:
    for term in ("cheesesteak", "cheese steak", "chicken cheesesteak", "chicken cheese steak"):
        if not e2e.get(f"lexicon?menu_id=eq.{menu}&term=eq.{term.replace(' ', '%20')}&target_id=eq.{it['id']}&active=eq.true&select=id"):
            rows.append({"shop_id": SHOP, "menu_id": menu, "term": term, "target_type": "item", "target_id": it["id"], "provenance": "owner_confirmed", "weight": 1, "active": True})
print([(r["term"], next(i["display_name"] for i in items if i["id"] == r["target_id"])) for r in rows])
if "--apply" in sys.argv and rows:
    r = urllib.request.Request(f"{e2e.U}/rest/v1/lexicon", method="POST", data=json.dumps(rows).encode(),
        headers={"apikey": e2e.K, "Authorization": f"Bearer {e2e.K}", "Content-Type": "application/json", "Prefer": "return=minimal"})
    urllib.request.urlopen(r, timeout=60); print("inserted", len(rows))
