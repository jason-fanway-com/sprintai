#!/usr/bin/env python3
"""vitos-sandwich-options-20261005 — Vito's (demo shop) sandwich options, per Jason 2026-10-05.

1. Hot sandwiches and paninis: drop the required White/Wheat/Rye bread choice (they come on a roll / panini bread).
2. Everything except salads: drop the salad protein add-ons (Chicken $4, Shrimp $6, Blackened Salmon $8, Black Diamond Steak $8).
3. Hot-sandwich cheesesteaks: add an optional Toppings group.
Then recompile Vito's menu (compile-menu) so the bot's ordering plans change too.

usage: vitos-sandwich-options-20261005.py [--apply]     (default is a dry run that only prints what it would change)
Vito's only (is_test demo shop). Never point this at a real shop: a real shop's options come from its owner.
"""
import json, os, sys, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "engine"))
import e2e  # noqa: E402  service credentials

SHOP = "e0000000-0000-0000-0000-000000000001"
APPLY = "--apply" in sys.argv
SALAD_PROTEINS = {"Chicken", "Shrimp", "Blackened Salmon", "Black Diamond Steak"}
TOPPINGS = [("Fried Onions", 0), ("Sweet Peppers", 0), ("Hot Peppers", 0), ("Sauce", 0), ("Ketchup", 0), ("Mayo", 0),
            ("Lettuce", 0), ("Tomato", 0), ("Pickles", 0), ("Mushrooms", 100), ("Extra Cheese", 150)]

def req(method, path, body=None, prefer="return=representation"):
    r = urllib.request.Request(f"{e2e.U}/rest/v1/{path}", method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"apikey": e2e.K, "Authorization": f"Bearer {e2e.K}", "Content-Type": "application/json", "Prefer": prefer})
    with urllib.request.urlopen(r, timeout=60) as resp:
        t = resp.read().decode(); return json.loads(t) if t else None

shop = e2e.get(f"shops?id=eq.{SHOP}&select=is_test")[0]
assert shop["is_test"] is True, "Vito's must be the is_test demo shop"
menu = e2e.get(f"menus?shop_id=eq.{SHOP}&select=id&order=created_at.desc&limit=1")[0]["id"]
items = {i["id"]: i for i in e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&select=id,name,category&limit=1000")}
groups = []
ids = list(items)
for k in range(0, len(ids), 80):
    groups += e2e.get("option_groups?menu_item_id=in.(%s)&select=id,menu_item_id,name" % ",".join(ids[k:k+80]))

drop = []
for g in groups:
    it = items[g["menu_item_id"]]
    if g["name"] == "Bread" and it["category"] in ("Hot Sandwiches", "Homemade Paninis"):
        drop.append((g, it))
    elif g["name"] == "Add-ons" and it["category"] != "Salads":
        names = {c["name"] for c in e2e.get(f"option_choices?option_group_id=eq.{g['id']}&select=name")}
        if names and names <= SALAD_PROTEINS:
            drop.append((g, it))
steaks = [i for i in items.values() if i["category"] == "Hot Sandwiches" and "cheesesteak" in i["name"].lower()]
have_top = {g["menu_item_id"] for g in groups if g["name"] == "Toppings"}
add = [i for i in steaks if i["id"] not in have_top]

print(f"menu {menu}: drop {len(drop)} groups, add Toppings to {len(add)} cheesesteaks")
for g, it in drop: print(f"  drop {g['name']:8} {it['category']}/{it['name']}")
for it in add: print(f"  add  Toppings {it['category']}/{it['name']}")
if not APPLY:
    print("dry run; pass --apply"); sys.exit(0)

for g, _ in drop:
    req("DELETE", f"option_choices?option_group_id=eq.{g['id']}", prefer="return=minimal")
    req("DELETE", f"option_groups?id=eq.{g['id']}", prefer="return=minimal")
for it in add:
    grp = req("POST", "option_groups", {"menu_item_id": it["id"], "name": "Toppings", "required": False, "min_select": 0,
                                        "max_select": len(TOPPINGS), "display_order": 1, "kind": "modifier", "provenance": "owner_confirmed"})[0]
    req("POST", "option_choices", [{"option_group_id": grp["id"], "name": n, "price_cents": p, "is_default": False, "display_order": k,
                                    "provenance": "owner_confirmed"} for k, (n, p) in enumerate(TOPPINGS)], prefer="return=minimal")
# the compiler infers a bread slot for Hot Sandwiches and blocks them until the owner says whether one exists: no
req("PATCH", f"owner_questions?menu_id=eq.{menu}&scope_type=eq.category&scope_id=eq.Hot%20Sandwiches&slot_key=eq.bread",
    {"status": "answered", "answer": {"exists": False, "note": "Jason 2026-10-05: hot sandwiches come on a roll; customers do not pick a bread. No slot."}, "asked_via": "owner_direct"},
    prefer="return=minimal")
print("applied; recompiling ...")
r = urllib.request.Request(f"{e2e.U}/functions/v1/compile-menu", method="POST", data=json.dumps({"shop_id": SHOP}).encode(),
    headers={"Authorization": f"Bearer {e2e.K}", "Content-Type": "application/json"})
with urllib.request.urlopen(r, timeout=300) as resp:
    rep = json.loads(resp.read().decode())
blocked = e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&bot_state=eq.blocked&select=name")
print("blocked after compile:", [b["name"] for b in blocked])
print("compile:", json.dumps({k: rep.get(k) for k in ("ok", "compiled_at", "menu_id")}), "invariants:", json.dumps(rep.get("invariants"))[:600])
