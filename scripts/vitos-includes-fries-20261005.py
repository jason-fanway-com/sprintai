#!/usr/bin/env python3
"""vitos-includes-fries-20261005 — Vito's items that come with fries record it (menu_items.meta.includes = [French Fries id]),
so a separate "french fries" in the same order is asked about: the included fries, or another order? (Jason 2026-10-05)
Source: the item's own name or description says it comes with fries (Jack's menu). usage: [--apply]"""
import json, os, re, sys, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "engine"))
import e2e  # noqa: E402
SHOP = "e0000000-0000-0000-0000-000000000001"
assert e2e.get(f"shops?id=eq.{SHOP}&select=is_test")[0]["is_test"] is True
menu = e2e.get(f"menus?shop_id=eq.{SHOP}&select=id&order=created_at.desc&limit=1")[0]["id"]
items = e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&select=id,name,category,description,meta&limit=1000")
fries = [i for i in items if i["name"] == "French Fries"]
assert len(fries) == 1, [i["name"] for i in fries]
WITH = re.compile(r"\b(served )?with (french )?fries\b", re.I)  # one-time data generation over the source text, not a runtime rule
todo = [i for i in items if i["id"] != fries[0]["id"] and (WITH.search(i["name"]) or WITH.search(i["description"] or ""))
        and fries[0]["id"] not in ((i["meta"] or {}).get("includes") or [])]
print(len(todo), "items:", sorted({f"{i['category']}/{i['name']}" for i in todo})[:60])
if "--apply" in sys.argv:
    for i in todo:
        meta = {**(i["meta"] or {}), "includes": sorted(set(((i["meta"] or {}).get("includes") or []) + [fries[0]["id"]]))}
        r = urllib.request.Request(f"{e2e.U}/rest/v1/menu_items?id=eq.{i['id']}", method="PATCH", data=json.dumps({"meta": meta}).encode(),
            headers={"apikey": e2e.K, "Authorization": f"Bearer {e2e.K}", "Content-Type": "application/json", "Prefer": "return=minimal"})
        urllib.request.urlopen(r, timeout=60)
    print("applied")
