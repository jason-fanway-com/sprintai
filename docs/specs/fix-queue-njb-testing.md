# Fix Queue — NJB conversation testing (prioritized)

Found via the demo-prep test run against the NJB clone, 2026-08-13. Workflow: fix (not work around) → verify on clone → replicate/deploy to prod → re-test.

## P1 — Breakfast-sandwich ordering fails on natural phrasing  (FIXED 2026-08-13, replicated to prod)
- **Fix:** added a breakfast-sandwich name map to ai_instructions ("bacon egg and cheese" = BOBO Sandwich (Bacon), SOBO/HOBO/PROBO/TBOBO for sausage/ham/pork-roll/turkey-bacon) + a "never reply empty; clarify if unsure" rule + friendly "that's what we call a BOBO!" framing. Owner (Jason) confirmed the BOBO mapping is correct; bot is transparent that BOBO includes hash brown, so the $8.75 is honest.
- **Verified on clone:** single ("That's what we call a BOBO… $8.75, comes with bacon/egg/hash brown/cheese, what bread?") and multi-item compound ("2 Sesame Bagels and a BOBO coming right up") both work. Multi-item-in-one-message defect closed too (this + the P2 loop fix).
- **Replicated to prod NJB** (ai_instructions patched). Longer-term: item aliases in menu data so this generalizes per-shop without hand-written instructions.

### (original notes)
- **Symptom:** "a bacon egg and cheese on a plain bagel" → bot returns empty (no item added). Deterministic.
- **Root cause:** no menu item is literally "Bacon, Egg & Cheese." The bacon breakfast sandwich is **"BOBO Sandwich (Bacon)"** ($8.75); menu also has cryptic SOBO/HOBO/PROBO/TBOBO names and "Turkey Bacon, Egg & Cheese." The model can't confidently map common terms → cryptic names, so it emits nothing.
- **Fix options (data/prompt, verify on clone → replicate to prod NJB):**
  1. Add term→item mapping to `ai_instructions` (e.g. "bacon egg and cheese = BOBO Sandwich (Bacon); sausage egg cheese = SOBO; ham = HOBO; pork roll = PROBO; turkey bacon = TBOBO").
  2. Or friendlier display names / aliases on the items themselves.
  3. Bot behavior: when a request is ambiguous among menu items, **clarify with options** rather than return empty.
- **Not demo-blocking** — off the demo golden path (bagels/dozen/86). But real customers will say "bacon egg and cheese," so P1.

## P2 — Ordering loop surfaced raw "couldn't process" on empty model output  (FIXED, deployed 2026-08-13)
- Loop bailed on `stop_reason === "end_turn"` even with pending tool calls (dropped them); empty text → raw error to customer.
- **Fix (deployed to chat-sms):** only stop when no pending tools; execute tools regardless of stop_reason; on empty output, degrade gracefully instead of erroring. Simple-item ordering regression-checked ✓.
- Follow-up: make the graceful fallback smarter (re-prompt with likely options) — minor.

## P0 — Pickup-only shops could not take orders  (FIXED + deployed 2026-08-13)  ← demo-breaker, product-wide
- **Symptom:** with `delivery_enabled=false`, EVERY first message got "Quick heads up — we're pickup-only right now. Want to put in a pickup order?" and the order was never processed. Affected all pickup-only shops.
- **Root cause:** chat-sms line ~2060 `deliveryIsPaused = shop.delivery_enabled === false || (pausedUntil...)` — conflated permanent pickup-only with a temporary delivery pause, short-circuiting the order flow on the greeting.
- **Fix (deployed):** `deliveryIsPaused = !!(pausedUntil && pausedUntil > now)` — only a *future* pause triggers the message. Permanent pickup-only is handled by the "DELIVERY AVAILABLE: No" system prompt (declines delivery gracefully, still takes the order).
- **Verified:** pickup-only shop now processes orders, dozen=14, and full order→checkout (Stripe link) with NJB's exact config (pickup-only, subscription=none); "do you deliver?" → graceful pickup-only decline.

## Delivery request = adversarial test  (per Jason)  ✓ passing
- NJB is pickup-only. "do you deliver?"/"deliver to X" → tactful "we're pickup only… what can I get started?" Verified.

## P3 — Delivery + tip flow  (validated for delivery-enabled shops)
- Test was unrealistic (tried to tip/place before adding items). Bot correctly refused empty cart + asked for full address. Re-test with items in cart to validate tip capture + TAKEOUT/DELIVERY ticket.

## Harness note (not a product bug)
- 86 cases must be set via the `availability_overrides` table (shop_id + menu_item_id + business_date), **not** `menu_items.is_available`. A first test used the wrong field and looked like a failure. Real 86 → alternative works (verified).
