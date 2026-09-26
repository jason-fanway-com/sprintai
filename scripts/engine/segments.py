#!/usr/bin/env python3
"""segments.py — carrier segments per conversation, from an endgame/replay transcript (.md) or from live conversation ids.
usage: python3 scripts/engine/segments.py ~/po-scratch/endgame-*.md   |   python3 scripts/engine/segments.py --conv <conversation_id>
Outbound $0.013/segment and inbound $0.009/segment are Telnyx actuals for Vito's (2026-09-26, rate + carrier fee)."""
import sys, re, json, os
GSM=set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"); EXT=set("^{}\\[~]|€")
OUT, IN = 0.013, 0.009
def segs(s):
    if all((c in GSM) or (c in EXT) for c in s):
        n=sum(2 if c in EXT else 1 for c in s); return 1 if n<=160 else -(-n//153)
    return 1 if len(s)<=70 else -(-len(s)//67)
def report(name, turns):
    o=sum(segs(b) for _,b in turns); i=sum(segs(c) for c,_ in turns); cost=o*OUT+i*IN
    print(f"{name[:44]:44} turns {len(turns):2}  out {o:3}  in {i:3}  ${cost:.3f}")
    return o,i,cost,len(turns)
if sys.argv[1:] and sys.argv[1]=="--conv":
    sys.path.insert(0, os.path.dirname(__file__)); from e2e import get
    for cid in sys.argv[2:]:
        ms=get(f"messages?conversation_id=eq.{cid}&select=role,content&order=created_at.asc"); turns=[]; cur=None
        for m in ms:
            if m["role"] in ("customer","user"): cur=[m["content"],""]; turns.append(cur)
            elif cur: cur[1]=(cur[1]+"\n"+m["content"]).strip()
        report(cid[:8], [(c,b) for c,b in turns])
    sys.exit()
tot=[0,0,0.0,0,0]
for f in sys.argv[1:]:
    text=open(os.path.expanduser(f)).read()
    for sec in re.split(r"^## ", text, flags=re.M)[1:]:
        name=sec.split("\n",1)[0]
        pairs=re.findall(r"\*\*C:\*\* (.*?)\n\n\*\*B:\*\* (.*?)  _\(", sec, flags=re.S)
        turns=[(c, b.replace(" / ", "\n")) for c,b in pairs]
        o,i,c,n=report(name, turns); tot[0]+=o; tot[1]+=i; tot[2]+=c; tot[3]+=n; tot[4]+=1
if tot[4]: print(f"\n== {tot[4]} conversations: avg out {tot[0]/tot[4]:.1f}, in {tot[1]/tot[4]:.1f}, turns {tot[3]/tot[4]:.1f}, SMS ${tot[2]/tot[4]:.3f} per order at Telnyx actuals")
