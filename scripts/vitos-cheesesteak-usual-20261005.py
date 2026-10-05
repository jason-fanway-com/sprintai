#!/usr/bin/env python3
"""vitos-cheesesteak-usual-20261005 — on Vito's, "cheesesteak" usually means the hot-sandwich Cheesesteak (Jason 2026-10-05):
menu_items.meta.primary_for, so an ambiguous "cheesesteak" confirms the sandwich and names the panini/roll/flatbread/salad/wrap.
usage: vitos-cheesesteak-usual-20261005.py [--apply]"""
import json, os, sys, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "engine"))
import e2e  # noqa: E402
SHOP = "e0000000-0000-0000-0000-000000000001"
USUAL = {"Cheesesteak": ["cheesesteak", "cheese steak", "philly cheesesteak", "philly cheese steak", "cheesesteaks", "cheese steaks"],
         "Chicken Cheesesteak": ["chicken cheesesteak", "chicken cheese steak", "chicken cheesesteaks"],
         "Buffalo Chicken Cheesesteak": ["buffalo chicken cheesesteak", "buffalo chicken cheese steak"]}
assert e2e.get(f"shops?id=eq.{SHOP}&select=is_test")[0]["is_test"] is True
menu = e2e.get(f"menus?shop_id=eq.{SHOP}&select=id&order=created_at.desc&limit=1")[0]["id"]
for it in e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&category=eq.Hot%20Sandwiches&select=id,name,meta"):
    if it["name"] not in USUAL: continue
    meta = {**(it["meta"] or {}), "primary_for": USUAL[it["name"]]}
    print(it["name"], "->", meta["primary_for"])
    if "--apply" in sys.argv:
        r = urllib.request.Request(f"{e2e.U}/rest/v1/menu_items?id=eq.{it['id']}", method="PATCH", data=json.dumps({"meta": meta}).encode(),
            headers={"apikey": e2e.K, "Authorization": f"Bearer {e2e.K}", "Content-Type": "application/json", "Prefer": "return=minimal"})
        urllib.request.urlopen(r, timeout=60)
