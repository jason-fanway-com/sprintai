#!/usr/bin/env python3
"""fnas-setup-20261006 — FNA's Grille (first real customer, Jason 2026-10-06): after the menu CSV
(menu-pipeline/fixtures/fnas-grille-menu.csv) is imported, make the chips swap a single choice
(fries OR tots, not both) and compile. Prints invariants, blocked items and pending owner questions.
usage: fnas-setup-20261006.py [--apply]"""
import json, os, sys, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "engine"))
import e2e  # noqa: E402
SHOP = "3477b955-fef4-495f-a656-f75632cf4042"
def req(method, path, body=None, prefer="return=minimal"):
    r = urllib.request.Request(f"{e2e.U}/{path}", method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"apikey": e2e.K, "Authorization": f"Bearer {e2e.K}", "Content-Type": "application/json", "Prefer": prefer})
    with urllib.request.urlopen(r, timeout=300) as resp:
        t = resp.read().decode(); return json.loads(t) if t else None
menu = e2e.get(f"menus?shop_id=eq.{SHOP}&source=eq.csv&select=id")[0]["id"]
items = e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&select=id,name")
swap = []
for it in items:
    for g in e2e.get(f"option_groups?menu_item_id=eq.{it['id']}&name=eq.Add-ons&select=id,max_select"):
        names = {c["name"] for c in e2e.get(f"option_choices?option_group_id=eq.{g['id']}&select=name")}
        if names == {"Fries Instead of Chips", "Tots Instead of Chips"} and g["max_select"] != 1:
            swap.append(g["id"])
print(f"{len(items)} items; {len(swap)} chips-swap group(s) to set max_select=1")
if "--apply" not in sys.argv: sys.exit(0)
for gid in swap:
    req("PATCH", f"rest/v1/option_groups?id=eq.{gid}", {"max_select": 1})
rep = req("POST", "functions/v1/compile-menu", {"shop_id": SHOP}, prefer="return=representation")
print("invariants:", [(i["invariant"], i["pass"]) for i in rep.get("invariants", [])])
print("blocked:", [b["name"] for b in e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&bot_state=eq.blocked&select=name")])
for q in e2e.get(f"owner_questions?menu_id=eq.{menu}&status=eq.pending&select=scope_id,slot_key,question_text"):
    print("Q:", q["scope_id"], "|", q["slot_key"], "|", q["question_text"])
