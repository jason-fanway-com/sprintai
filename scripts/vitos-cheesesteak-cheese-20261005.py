#!/usr/bin/env python3
"""vitos-cheesesteak-cheese-20261005 — Vito's hot-sandwich cheesesteaks ask which cheese (Jason 2026-10-05).
Required single choice, no charge: American, Provolone, Cheese Whiz, Swiss, Pepper Jack. The Slice Cheesesteak keeps its nacho cheese.
usage: vitos-cheesesteak-cheese-20261005.py [--apply]"""
import json, os, sys, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "engine"))
import e2e  # noqa: E402
SHOP = "e0000000-0000-0000-0000-000000000001"
CHEESES = ["American", "Provolone", "Cheese Whiz", "Swiss", "Pepper Jack"]
def req(method, path, body=None, prefer="return=minimal"):
    r = urllib.request.Request(f"{e2e.U}/{path}", method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"apikey": e2e.K, "Authorization": f"Bearer {e2e.K}", "Content-Type": "application/json", "Prefer": prefer})
    with urllib.request.urlopen(r, timeout=300) as resp:
        t = resp.read().decode(); return json.loads(t) if t else None
assert e2e.get(f"shops?id=eq.{SHOP}&select=is_test")[0]["is_test"] is True
menu = e2e.get(f"menus?shop_id=eq.{SHOP}&select=id&order=created_at.desc&limit=1")[0]["id"]
steaks = [i for i in e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&category=eq.Hot%20Sandwiches&select=id,name")
          if "cheesesteak" in i["name"].lower() and "the slice" not in i["name"].lower()]
todo = [i for i in steaks if not e2e.get(f"option_groups?menu_item_id=eq.{i['id']}&name=eq.Cheese&select=id")]
print("add Cheese to:", [i["name"] for i in todo])
if "--apply" not in sys.argv: sys.exit(0)
for it in todo:
    g = req("POST", "rest/v1/option_groups", {"menu_item_id": it["id"], "name": "Cheese", "required": True, "min_select": 1, "max_select": 1,
                                             "display_order": 0, "kind": "slot", "provenance": "owner_confirmed"}, prefer="return=representation")[0]
    req("POST", "rest/v1/option_choices", [{"option_group_id": g["id"], "name": c, "price_cents": 0, "is_default": False, "display_order": k,
                                           "provenance": "owner_confirmed"} for k, c in enumerate(CHEESES)])
rep = req("POST", "functions/v1/compile-menu", {"shop_id": SHOP}, prefer="return=representation")
print("invariants:", [(i["invariant"], i["pass"]) for i in rep.get("invariants", [])])
print("blocked:", [b["name"] for b in e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&bot_state=eq.blocked&select=name")])
print("pending owner questions:", [q["question_text"] for q in e2e.get(f"owner_questions?menu_id=eq.{menu}&status=eq.pending&select=question_text")])
for it in steaks[:1]:
    p = e2e.get(f"menu_items?id=eq.{it['id']}&select=name,ask_plan")[0]
    print(p["name"], [(s["kind"], s.get("ask_mode"), [c["display"] for c in s["choices"]][:6]) for s in p["ask_plan"]["steps"]])
