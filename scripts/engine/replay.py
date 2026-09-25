#!/usr/bin/env python3
"""replay.py — script a customer conversation against the LIVE chat-sms function and print it.
usage (on the Air): python3 scripts/engine/replay.py "pickup|10 piece bone in wings|buffalo flavor|3" ["another|conversation"]
Each argument is one conversation, turns separated by |. Secrets come from ~/.openclaw-sprintai/.secrets via e2e.py.
Default shop is Vito's; set SHOP_ID to override. Costs one model call per turn (~1.5 cents per conversation)."""
import os, sys, uuid
sys.path.insert(0, os.path.dirname(__file__))
from e2e import say  # noqa: E402
SHOP = os.environ.get("SHOP_ID", "e0000000-0000-0000-0000-000000000001")
for convo in sys.argv[1:]:
    s = str(uuid.uuid4()); print(f"===== {convo[:60]}")
    for t in [x.strip() for x in convo.split("|") if x.strip()]:
        r, dt = say(SHOP, s, t)
        print("C:", t); print("B:", r.split("Msg & data")[0].strip().replace("\n", " / "), "(%.1fs)" % dt)
