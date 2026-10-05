#!/usr/bin/env python3
"""vitos-fish-no-temp-20261005 — Vito's Fish Sandwich: drop the burger Temp question (Jason 2026-10-05). Burgers keep it.
usage: vitos-fish-no-temp-20261005.py [--apply]"""
import json, os, sys, urllib.request
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
fish = [i for i in e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&name=ilike.Fish%20Sandwich*&select=id,name")]
gs = [g for f in fish for g in e2e.get(f"option_groups?menu_item_id=eq.{f['id']}&name=eq.Temp&select=id")]
print(f"{[f['name'] for f in fish]}: {len(gs)} Temp group(s)")
if "--apply" not in sys.argv: sys.exit(0)
for g in gs:
    req("DELETE", f"rest/v1/option_choices?option_group_id=eq.{g['id']}"); req("DELETE", f"rest/v1/option_groups?id=eq.{g['id']}")
req("POST", "functions/v1/compile-menu", {"shop_id": SHOP}, prefer="return=representation")
# the compiler then asks whether the burger category's remaining items (only the Fish Sandwich; burgers are excluded) pick a temperature: no
req("PATCH", f"rest/v1/owner_questions?menu_id=eq.{menu}&scope_id=eq.Angus%20Burgers%20%26%20Specialty&slot_key=eq.temp&status=eq.pending",
    {"status": "answered", "asked_via": "owner_direct", "answer": {"exists": False, "note": "Jason 2026-10-05: the Fish Sandwich has no temperature; burgers keep theirs."}})
rep = req("POST", "functions/v1/compile-menu", {"shop_id": SHOP}, prefer="return=representation")
print("invariants:", [(i["invariant"], i["pass"]) for i in rep.get("invariants", [])])
print("blocked:", [b["name"] for b in e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&bot_state=eq.blocked&select=name")])
print("pending owner questions:", [q["question_text"] for q in e2e.get(f"owner_questions?menu_id=eq.{menu}&status=eq.pending&select=question_text")])
