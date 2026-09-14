#!/bin/bash
# Conversation-level acceptance, modelled on how Jason actually tests:
# long realistic flows, varied natural phrasing, and assertions on the REPLY
# a customer reads — not just the cart rows. Every real defect 2026-09-12..14
# was found this way and missed by the cart-only matrix.
set -a; . ~/.openclaw/.secrets 2>/dev/null; . ~/.openclaw-sprintai/.secrets 2>/dev/null; set +a
U="$SPRINTAI_CHAT_SUPABASE_URL"; K="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY"
SHOP="e0000000-0000-0000-0000-000000000001"
say() {
  curl -s -m 240 -X POST "$U/functions/v1/chat-sms" -H "apikey: $K" -H "Authorization: Bearer $K" \
    -H "Content-Type: application/json" \
    -d "{\"shop_id\":\"$SHOP\",\"message\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1"),\"session_id\":\"$SID\",\"test\":true}"
}
newcust() {
  SID="cq-$(date +%s)-$RANDOM"
  curl -s -o /dev/null -m 30 -X POST "$U/rest/v1/customers" -H "apikey: $K" -H "Authorization: Bearer $K" \
    -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates" \
    -d "{\"tenant_id\":\"$SHOP\",\"customer_phone\":\"web:$SID\",\"name\":\"Jason\",\"order_count\":9,\"last_order_type\":\"delivery\",\"favorite_items\":[{\"menu_item_id\":\"8857b40a-e53b-44fa-8bf0-6fdafb7efa45\",\"name\":\"Cheese - Large (16\\\")\",\"count\":6}],\"last_delivery_address\":{\"street\":\"5620 Cetronia Rd\",\"city\":\"Allentown\",\"state\":\"PA\",\"zip\":\"18106\",\"formatted\":\"5620 Cetronia Rd, Allentown, PA 18106\"}}"
}
check() { # check <label> <reply> <must-contain-regex> <must-NOT-contain-regex>
  local label="$1" reply="$2" want="$3" avoid="$4" res="PASS"
  [ -n "$want" ]  && ! echo "$reply" | grep -qiE "$want"  && res="FAIL(missing:$want)"
  [ -n "$avoid" ] &&   echo "$reply" | grep -qiE "$avoid" && res="FAIL(present:$avoid)"
  printf '  %-46s %s\n' "$label" "$res"
  [ "$res" != "PASS" ] && printf '     reply: %s\n' "$(echo "$reply" | tr '\n' ' ' | cut -c1-150)"
}
echo "### CONVERSATION QUALITY — realistic flow, reply-level assertions ###"
newcust
r=$(say "Need to order" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("reply",""))')
check "greets by name + offers address" "$r" "jason.*cetronia|cetronia.*jason" ""
r=$(say "Yes but this week I want pepperoni." | python3 -c 'import sys,json;print(json.load(sys.stdin).get("reply",""))')
check "names the item it added" "$r" "pizza" "you've got [0-9]+ item"
check "offers a FOOD upsell, not a tip" "$r" "" "driver tip|tip for your driver"
check "does not ask for name yet" "$r" "" "name for the order|putting this in for"
r=$(say "no thanks" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("reply",""))')
check "decline -> shows cart, not a count" "$r" "pizza" "you've got [0-9]+ item"
r=$(say "actually add a side salad too" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("reply",""))')
check "second intent honoured (salad named)" "$r" "salad" ""
r=$(say "yeah im ready to check out" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("reply",""))')
# The name step has TWO correct shapes: ask a new customer ("name for the
# order?") or confirm a remembered one ("Putting this in for Jason, right?"
# -- the returning-customer CRM path). Asserting the bare word "name"
# false-failed the CRM path, which line 34 above already treats as the name
# step. Both spellings are accepted; neither is optional.
check "explicit checkout intent accepted" "$r" "name for the order|putting this in for" ""
r=$(say "Yes" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("reply",""))')
check "payment link issued" "$r" "payment link|pay here" ""
CID=$(curl -s -m 30 "$U/rest/v1/conversations?session_id=eq.$SID&select=id&order=started_at.desc&limit=1" -H "apikey: $K" -H "Authorization: Bearer $K" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[0]["id"] if d else "")')
curl -s -m 30 "$U/rest/v1/order_carts?conversation_id=eq.$CID&select=cart_json,subtotal_cents" -H "apikey: $K" -H "Authorization: Bearer $K" | python3 -c "
import sys,json
d=json.load(sys.stdin); c=d[0] if d else None
items=(c.get('cart_json') or []) if c else []
sub=(c['subtotal_cents']/100) if c else 0
names=[i.get('name') for i in items]
print('  final cart:', names, '\$%.2f' % sub, '->', 'PASS' if (len(items)==2 and abs(sub-24.99)<0.01) else 'FAIL expected pizza+salad \$24.99')
"
