# Prompt Line Classification — 2026-09-09

Source: `supabase/functions/chat-sms/index.ts`, function `buildSystemPrompt` (lines 624–916).  
Purpose: line-by-line classification of the current shared system prompt into destination buckets.  
Companion: migration `124_instruction_layers_schema.sql` creates the tables; this doc is the input to C2 (renderer).

## Destination buckets

| Bucket | Meaning |
|---|---|
| **code** | Applies universally to all shops; baked into the function, no per-shop data needed |
| **compiled menu** | The live menu rendered from DB (category/item/price/option rows) |
| **shop_settings** | Structured per-shop config: hours, fulfilment modes, quantity words, etc. |
| **shop_voice** | Shop personality: greeting, sign-off, persona |
| **shop_notes** | Ad-hoc factual notes ≤140 chars, no $ (kitchen-facing facts, alias mappings, constraints) |

---

## Line-by-line classification

### Opening identity (line 838)

| Line | Destination | Reason |
|---|---|---|
| `You are the ordering assistant for ${shop.name}. Help customers order for pickup or delivery via text.` | **shop_voice** | Identity template — `shop.name` is per-shop; the role sentence is persona boilerplate |

### SMS formatting rules (line 840)

| Line | Destination | Reason |
|---|---|---|
| `You are replying by SMS text message. Plain text only. Never use markdown…` | **code** | Universal channel constraint, same for every shop |
| `Keep replies under about 300 characters.` | **code** | SMS segment economics, universal |
| `Write the way a person texts.` | **code** | Universal tone rule; *how* to write is code, *who you are* is shop_voice |

### Dynamic context header (lines 842–844)

| Line | Destination | Reason |
|---|---|---|
| `CURRENT PHASE: ${phase}` | **code** | Runtime state — changes turn by turn |
| `CURRENT TIME: ${currentTime}` | **code** | Runtime state |
| `TODAY'S HOURS: ${hoursStr}` | **shop_settings** | Derived from `shop.open_hours`; lives in `shop_settings.hours_line` once extracted |
| `${deliveryAvail}` (DELIVERY AVAILABLE: Yes/No) | **shop_settings** | Derived from `delivery_enabled`; drives `shop_settings.fulfilment_modes` |
| `${orderTypeInfo}` (ORDER TYPE: …) | **code** | Runtime state — changes as the order progresses |
| `${deliveryInfo}` (DELIVERY ADDRESS: …) | **code** | Runtime state — customer's address this session |
| `${deliveryFeeInfo}` (DELIVERY FEE: …) | **shop_settings** | Per-shop fee; candidate for `shop_settings` once a delivery_fee column exists |
| `${tipInfo}` (DRIVER TIP: …) | **code** | Runtime state — tip chosen this session |
| `${wingPolicy}` | **shop_settings** | Derived from `shop.wing_flavors_included` / `wing_mix_extra`; already structured DB fields |
| `${customerContextBlock}` (RETURNING CUSTOMER CONTEXT) | **code** | Runtime CRM state — changes per customer |

### Available menu (line 846)

| Line | Destination | Reason |
|---|---|---|
| `AVAILABLE MENU:\n${menuStr}` | **compiled menu** | Live per-shop menu rendered from DB at request time |

### Sold-out list (line 848)

| Line | Destination | Reason |
|---|---|---|
| `SOLD OUT TODAY: …` (conditional) | **code** | Runtime state — changes daily per shop |

### Special instructions (line 848)

| Line | Destination | Reason |
|---|---|---|
| `SPECIAL INSTRUCTIONS: ${shop.ai_instructions}` | **shop_notes** | Per-shop free text; these are the facts and rules the editor enters — should migrate to structured shop_notes rows |

### Precedence rule (line 849)

| Line | Destination | Reason |
|---|---|---|
| `PRECEDENCE RULE: The structured fields above … override any conflicting SPECIAL INSTRUCTIONS.` | **code** | Universal conflict-resolution rule, same for all shops |
| `ITEM-NAME PRECEDENCE: The AVAILABLE MENU is authoritative for item NAMES and PRICES.` | **code** | Universal grounding rule |

### Shop context (line 850)

| Line | Destination | Reason |
|---|---|---|
| `Background information about this shop … ${shop.shop_context}` | **shop_voice** | Per-shop background facts (location, description) → `shop_voice.persona` or a future `shop_voice.background` column |

### Current cart (lines 851–853)

| Line | Destination | Reason |
|---|---|---|
| `CURRENT CART:\n${cartStr}` | **code** | Runtime state — the live cart |
| Subtotal / service fee / delivery fee / tip / order total block | **code** | Runtime pricing, assembled from live cart |
| `ORDER NOTES: ${notes}` | **code** | Runtime state — notes captured this session |

---

### RULES section (lines 856–910)

Each rule with its destination and reason:

| Rule label | Destination | Reason |
|---|---|---|
| Keep ALL responses under 300 characters for SMS | **code** | Universal SMS constraint |
| MONEY/SCOPE RULE — never state totals/amounts in reply | **code** | Universal guard, applies to all shops |
| Only use item IDs exactly as shown | **code** | Universal menu-grounding guard |
| Never add items not in the available menu | **code** | Universal constraint |
| REMEMBERED-CUSTOMER GROUNDING — never add_item from memory | **code** | Universal safety rule |
| SOLD OUT ITEMS — tell customer we're out | **code** | Universal handling pattern |
| Never use em dashes in responses | **code** | Universal GSM-7 safety rule |
| When cart has items and customer is done, ask for pickup name | **code** | Universal checkout flow |
| When confirming before submit_order, say "Confirm?" | **code** | Universal checkout flow |
| Only call submit_order after explicit confirmation | **code** | Universal safety gate |
| Be friendly but concise — every character over 160 costs a segment | **shop_voice** | Tone guidance; "friendly but concise" is persona direction |
| SERVICE FEE: A $0.99 service fee is added to every order | **code** | Platform-wide constant (hardcoded $0.99); candidate for shop_settings once per-shop fees exist |
| OFF-MENU ITEMS — politely decline, suggest similar | **code** | Universal handling pattern |
| CLEAR_CART RESTRICTION — never call clear_cart on additive messages | **code** | Universal safety guard |
| SAFE WORDS — offer CHANGE or RESTART | **code** | Universal UX rule |
| CUSTOMER QUESTIONS — always answer before advancing order | **code** | Universal conversational rule |
| ITEM AVAILABILITY — every menu item is in stock unless SOLD OUT | **code** | Universal grounding rule |
| QUANTITY PARSING — number + item = single add_item call | **code** | Universal parsing rule |
| QUANTITY REDUCTION — modify_item not add_item for decreases | **code** | Universal cart integrity rule |
| CRITICAL MULTI-ITEM RULE — process entire message in one turn | **code** | Universal turn-processing rule |
| PICKUP NAME RULE — single word after name-ask = submit order | **code** | Universal checkout flow |
| EARLY ORDER TYPE GATE — ask pickup/delivery when delivery available | **code** | Universal delivery-shop flow |
| DELIVERY FLOW — when/how to offer delivery | **code** | Universal delivery flow |
| ADDRESS COLLECTION — collect street/city/state/zip naturally | **code** | Universal delivery flow |
| DRIVER TIP — ask once after address | **code** | Universal delivery flow |
| **SANDWICH MAPPING** — BOBO/SOBO/HOBO/PROBO/TBOBO | **shop_notes** | ⚠️ NJB-ONLY. These sandwich names are Not Just Bagels–specific and are currently injected into EVERY shop's prompt including Zio's and Vito's (pizza shops). Zio's bot today knows BOBO means "Bacon Egg & Cheese" when no such item exists on their menu. → `shop_notes` for NJB only |
| MULTI-ITEM FOCUS — if you said you're adding something, use the tool | **code** | Universal tool-use discipline |
| **CRITICAL BUNDLE RULE** — "a dozen" = start_bundle, bundle_size=14, $15.00; "half dozen" = bundle_size=6, $7.50 | **shop_settings** | ⚠️ NJB-ONLY. Hardcoded bagel bundle vocabulary and prices. Pizza shops receive this rule on every message. "dozen" → 14 and "half dozen" → 6 belong in `shop_settings.quantity_words` for NJB only. The bundle prices ($15.00 / $7.50) belong in the compiled menu |
| — bundle flavor-flow sub-rules (add_to_bundle, etc.) | **code** | Universal bundle mechanics — once the bundle trigger is per-shop, the mechanics are universal |
| OPTION GROUNDING — only name options that appear in item's own entry | **code** | Universal menu-grounding guard |
| TOPPING-ONLY PIZZA REQUESTS — compose base + topping | **code** | Universal pizza handling rule (relevant only to pizza shops, but harmless to others as dead code) |
| WHEN YOU DO NOT KNOW THE CHOICES — ask, never guess | **code** | Universal honesty rule |
| NEVER CLAIM AN ACTION YOU DO NOT TAKE | **code** | Universal honesty rule |
| NEVER NARRATE A TECHNICAL FAILURE | **code** | Universal UX rule |
| NEVER STATE SHOP POLICY YOU WERE NOT TOLD | **code** | Universal grounding rule |
| Never state the NUMBER of available flavors | **code** | Universal grounding rule |
| NEVER suggest switching from a larger bundle to a smaller one | **code** | Bundle mechanics — universal once bundle is per-shop |
| NEVER ask "are you ordering individual bagels or a bundle?" | **code** | Bundle mechanics — universal |
| REQUIRED OPTIONS — call add_item immediately even without choice | **code** | Universal option-handling rule |
| OPTIONAL OPTIONS — ask after required are settled | **code** | Universal option-handling rule |
| OPTIONS IN add_item — pass selections as object | **code** | Universal tool protocol |
| **EXACT-NAME MATCHING** — bagel/flagel/wrap; don't ask about cream cheese for plain bagel | **shop_notes** | ⚠️ NJB-ONLY. Specific to bagel menu structure ("Bagel With" category). Currently sent to all shops. |
| **COMBO ITEMS** — "Bagel With" items already include the bagel | **shop_notes** | ⚠️ NJB-ONLY. The "Bagel With" category is NJB-specific. Pizza shops receive this on every message. |
| **BAGEL WITH PRICING** — "Bagel with Jelly at $0.75 is a full item, not an add-on" | **shop_notes** | ⚠️ NJB-ONLY. Contains hardcoded NJB prices. The $0.75 jelly bagel and $3.50 cream cheese bagel are NJB-specific menu facts. Currently sent to all shops. Note: this rule contains dollar amounts, so cannot literally go in shop_notes (no $ constraint); this instruction belongs in shop_voice.persona for NJB. |
| UPSELL GUARD — only suggest items in the AVAILABLE MENU | **code** | Universal grounding rule |
| MODIFIER GROUNDING — only offer flagel/wrap/size if item's entry lists it | **code** | Universal modifier guard; the flagel/wrap examples are bagel-shop flavored but the rule is universal |
| **CREAM CHEESE DISAMBIGUATION** — two types: "Bagel With" vs "per pound"; prices $3.50–$4.95 / $10.95–$13.95 | **shop_notes** | ⚠️ NJB-ONLY. The specific product categories and hardcoded prices are NJB-specific. The prices contain $ so cannot go in shop_notes literally; this belongs in shop_voice.persona for NJB once C2 renders it. Currently sent to all shops. |
| CONTEXT MEMORY — remember customer's stated choices | **code** | Universal conversational rule |
| **TOASTED PROMPT** — after "Bagel With" or breakfast sandwich, ask "Want that toasted?" | **shop_notes** | ⚠️ NJB-ONLY. Toasting is a bagel-shop behavior. Pizza shops receive this and may ask pizza customers if they want their slice "toasted". |
| PREP INSTRUCTIONS — call set_note for toasted/scooped/etc | **code** | Universal note-capture rule |

### Phase behavior (line 911)

| Line | Destination | Reason |
|---|---|---|
| `PHASE BEHAVIOR: greeting/building / checkout / confirmed / expired` | **code** | Universal state machine description |

### Appended blocks (lines 734–744, appended after template)

| Line | Destination | Reason |
|---|---|---|
| `COMPLIANCE NOTE: Do NOT write any 'Msg & data rates'…` | **code** | Universal compliance handling |
| `EXPIRED LINK CONTEXT: …` | **code** | Runtime state (triggered by prior link expiry) |

---

## Summary counts

| Bucket | Count |
|---|---|
| **code** | 47 |
| **compiled menu** | 1 |
| **shop_settings** | 5 |
| **shop_voice** | 3 |
| **shop_notes** | 7 |

---

## Key findings (shop-specific rules sent to ALL shops today)

The following rules are hardcoded in the **shared** template and injected into every shop's system prompt on every message, regardless of whether the rules make any sense for that shop:

### ⚠️ SANDWICH MAPPING (NJB-only, Zio's and Vito's receive it)
```
BOBO = Bacon Egg & Cheese; SOBO = Sausage; HOBO = Ham; PROBO = Pork Roll; TBOBO = Turkey Bacon
```
These are Not Just Bagels' proprietary sandwich names. Zio's Pizzeria bot knows today that if a customer says "bacon egg and cheese" they should look for "BOBO Sandwich" on a menu that has no such item.

### ⚠️ BUNDLE RULE with hardcoded NJB prices (all shops receive it)
```
"a dozen" → start_bundle, bundle_size=14, bundle_price_cents=1500
"half dozen" → start_bundle, bundle_size=6, bundle_price_cents=750
```
If a Zio's customer ever says "a dozen wings" the bot may try to call `start_bundle`. The bundle size of 14 (baker's dozen) and prices are NJB menu data embedded in universal code.

### ⚠️ BAGEL WITH / CREAM CHEESE DISAMBIGUATION (all shops receive it)
Rules about the "Bagel With" product category, cream cheese disambiguation, and toasting prompts — all specific to NJB's menu structure — are sent to Zio's and Vito's on every message.

### ⚠️ HARDCODED PRICES in prompt rules
The CREAM CHEESE DISAMBIGUATION rule contains literal prices: `$3.50-$4.95` and `$10.95-$13.95`. These are NJB's actual menu prices as of the time the rule was written. If NJB changes a price, the rule is now wrong and the prompt contradicts the menu.

---

## Population applied (2026-09-09)

Tables populated from this classification (migration 124, zero behavior change — nothing reads these yet):

| Table | Rows inserted |
|---|---|
| shop_settings | 3 (Zio's, Vito's, NJB) |
| shop_voice | 3 (Zio's, Vito's, NJB) |
| shop_notes | 4 (NJB only: sandwich aliases, bundle vocabulary, cream cheese upsell, specialty bagel availability) |
| prompt_versions | 0 (placeholder; current template is legacy code, not a versioned row) |

NJB `shop_settings.quantity_words` = `{"dozen": 14, "half dozen": 6}` (extracted from the bundle rule).  
NJB `shop_settings.fulfilment_modes` = `["pickup"]` (delivery_enabled=false).  
Zio's `shop_settings.fulfilment_modes` = `["pickup", "delivery"]` (delivery_enabled=true, radius=3 mi).

---

*Generated by stream C1 (instruction-layer schema). Next: stream C2 renders a per-shop prompt from these tables, eliminating the cross-contamination above.*
