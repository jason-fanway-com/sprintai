#!/usr/bin/env python3
"""vitos-match-jacks-options-20261005 — make Vito's (demo shop) options match Jack's menu file
(menu-pipeline/fixtures/jacks-slice-menu.csv), per Jason 2026-10-05 "our menu should mimic jacks".

1. Cold sandwiches: no bread choice.          2. Quesadillas: protein add-ons Shrimp +$6, Black Diamond Steak +$8.
3. Salads: protein add-ons exactly as Jack's lists per salad (none where it lists none).
4. Flatbreads: no pizza toppings.             5. Wraps: no tortilla choice.
Then answer the compiler's resulting "is there a bread/wrap slot?" questions with no, recompile, and report blocked items.
usage: vitos-match-jacks-options-20261005.py [--apply]   (dry run by default)
"""
import csv, json, os, re, sys, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "engine"))
import e2e  # noqa: E402
SHOP = "e0000000-0000-0000-0000-000000000001"; APPLY = "--apply" in sys.argv
PROT = {"chicken": ("Chicken", 400), "shrimp": ("Shrimp", 600), "salmon": ("Blackened Salmon", 800), "steak": ("Black Diamond Steak", 800)}
src = {(r["category"], r["name"]): r for r in csv.DictReader(open(os.path.join(os.path.dirname(__file__), "..", "menu-pipeline", "fixtures", "jacks-slice-menu.csv")))}

def req(method, path, body=None, prefer="return=representation"):
    r = urllib.request.Request(f"{e2e.U}/rest/v1/{path}", method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"apikey": e2e.K, "Authorization": f"Bearer {e2e.K}", "Content-Type": "application/json", "Prefer": prefer})
    with urllib.request.urlopen(r, timeout=60) as resp:
        t = resp.read().decode(); return json.loads(t) if t else None

assert e2e.get(f"shops?id=eq.{SHOP}&select=is_test")[0]["is_test"] is True
menu = e2e.get(f"menus?shop_id=eq.{SHOP}&select=id&order=created_at.desc&limit=1")[0]["id"]
items = e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&is_derived=eq.false&select=id,name,category&limit=1000")
def groups_of(i): return e2e.get(f"option_groups?menu_item_id=eq.{i}&select=id,name")
def choices_of(g): return {c["name"] for c in e2e.get(f"option_choices?option_group_id=eq.{g}&select=name")}

drop, add, why = [], [], []
for it in items:
    cat, name = it["category"], it["name"]
    gs = groups_of(it["id"]) if cat in ("Cold Sandwiches", "Quesadillas", "Salads", "Flatbreads", "Wraps") else []
    if cat == "Cold Sandwiches": drop += [(g, it) for g in gs if g["name"] == "Bread"]
    if cat == "Flatbreads": drop += [(g, it) for g in gs if g["name"] == "Toppings"]
    if cat == "Wraps": drop += [(g, it) for g in gs if g["name"] == "Wrap Type"]
    if cat in ("Quesadillas", "Salads"):
        r = src.get((cat, name)); up = (r or {}).get("upsell", "").lower()
        m = re.search(r"add (?:a protein \(([^)]*)\)|(shrimp) \+\$6)", up)
        want = [PROT[w] for w in re.findall(r"chicken|shrimp|salmon|steak", (m.group(1) or m.group(2))) ] if m else []
        prot = [g for g in gs if g["name"] == "Add-ons" and choices_of(g["id"]) <= {p[0] for p in PROT.values()}]
        have = choices_of(prot[0]["id"]) if prot else set()
        if have != {n for n, _ in want}:
            drop += [(g, it) for g in prot]
            if want: add.append((it, want))
            why.append(f"{cat}/{name}: proteins {sorted(have) or 'none'} -> {[n for n, _ in want] or 'none'}")
print(f"menu {menu}: drop {len(drop)} groups, add proteins to {len(add)} items")
for g, it in drop: print(f"  drop {g['name']:9} {it['category']}/{it['name']}")
for w in why: print("  " + w)
if not APPLY: print("dry run; pass --apply"); sys.exit(0)
for g, _ in drop:
    req("DELETE", f"option_choices?option_group_id=eq.{g['id']}", prefer="return=minimal"); req("DELETE", f"option_groups?id=eq.{g['id']}", prefer="return=minimal")
for it, want in add:
    grp = req("POST", "option_groups", {"menu_item_id": it["id"], "name": "Add-ons", "required": False, "min_select": 0, "max_select": len(want),
                                        "display_order": 2, "kind": "modifier", "provenance": "owner_confirmed"})[0]
    req("POST", "option_choices", [{"option_group_id": grp["id"], "name": n, "price_cents": p, "is_default": False, "display_order": k,
                                    "provenance": "owner_confirmed"} for k, (n, p) in enumerate(want)], prefer="return=minimal")
def compile_():
    r = urllib.request.Request(f"{e2e.U}/functions/v1/compile-menu", method="POST", data=json.dumps({"shop_id": SHOP}).encode(),
        headers={"Authorization": f"Bearer {e2e.K}", "Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=300) as resp: return json.loads(resp.read().decode())
compile_()
# a removed bread/wrap slot makes the compiler ask the owner whether one exists: Jack's says no
pend = e2e.get(f"owner_questions?menu_id=eq.{menu}&status=eq.pending&select=id,scope_id,slot_key,question_text")
for q in pend:
    if q["scope_id"] in ("Cold Sandwiches", "Wraps", "Flatbreads", "Quesadillas", "Salads"):
        req("PATCH", f"owner_questions?id=eq.{q['id']}", {"status": "answered", "asked_via": "owner_direct",
            "answer": {"exists": False, "note": "Jason 2026-10-05: match Jack's menu, which has no such choice."}}, prefer="return=minimal")
        print("answered no:", q["question_text"])
rep = compile_()
print("invariants:", [(i["invariant"], i["pass"]) for i in rep.get("invariants", [])])
print("blocked:", [b["name"] for b in e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&bot_state=eq.blocked&select=name")])
print("pending owner questions:", [q["question_text"] for q in e2e.get(f"owner_questions?menu_id=eq.{menu}&status=eq.pending&select=question_text")])
