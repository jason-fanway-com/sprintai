-- SprintAI Ordering Platform — Test Seed
-- Creates: tenant, shop "Not Just Bagels", menu with 20 realistic items
--
-- Run this against your Supabase project:
--   supabase db query < scripts/seed-test-shop.sql
--   OR paste into the Supabase SQL Editor
--
-- After seeding:
--   Admin chat test: /chat-test (select "Not Just Bagels")
--   Merchant UI:     /merchant-ui/?shop=not-just-bagels  (PIN: 1234)

-- ============================================================
-- TENANT
-- ============================================================
INSERT INTO tenants (
  id, name, slug, status, plan, config, onboarding_status
) VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'Not Just Bagels LLC',
  'not-just-bagels-llc',
  'active',
  'starter',
  '{"business_type": "restaurant", "email": "owner@notjustbagels.com", "personality": "friendly and helpful"}'::jsonb,
  'complete'
) ON CONFLICT (id) DO UPDATE SET
  status           = EXCLUDED.status,
  onboarding_status = EXCLUDED.onboarding_status;

-- ============================================================
-- SHOP
-- ============================================================
INSERT INTO shops (
  id, tenant_id, name, slug, phone_number_e164,
  open_hours, timezone, email_ticket_recipient,
  is_paused, merchant_pin
) VALUES (
  'b0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001',
  'Not Just Bagels',
  'not-just-bagels',
  '+12125550001',
  '{
    "mon": [{"open": "07:00", "close": "15:00"}],
    "tue": [{"open": "07:00", "close": "15:00"}],
    "wed": [{"open": "07:00", "close": "15:00"}],
    "thu": [{"open": "07:00", "close": "15:00"}],
    "fri": [{"open": "07:00", "close": "15:00"}],
    "sat": [{"open": "07:00", "close": "16:00"}],
    "sun": [{"open": "08:00", "close": "14:00"}]
  }'::jsonb,
  'America/New_York',
  'orders@notjustbagels.com',
  false,
  '1234'
) ON CONFLICT (id) DO UPDATE SET
  merchant_pin = EXCLUDED.merchant_pin,
  open_hours   = EXCLUDED.open_hours;

-- ============================================================
-- MENU
-- ============================================================
INSERT INTO menus (
  id, shop_id, name, source, effective_from
) VALUES (
  'c0000000-0000-0000-0000-000000000001',
  'b0000000-0000-0000-0000-000000000001',
  'Main Menu',
  'manual',
  NOW()
) ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- MENU ITEMS
-- ============================================================
-- We use ON CONFLICT DO NOTHING so re-running is safe.

-- ─── BAGELS ──────────────────────────────────────────────────────────────────
INSERT INTO menu_items (menu_id, name, description, price_cents, category, display_order, active)
VALUES
  ('c0000000-0000-0000-0000-000000000001', 'Plain Bagel',           'Classic NY-style plain bagel',                           350, 'Bagels', 1,  true),
  ('c0000000-0000-0000-0000-000000000001', 'Everything Bagel',      'Topped with everything seasoning',                       350, 'Bagels', 2,  true),
  ('c0000000-0000-0000-0000-000000000001', 'Sesame Bagel',          'Classic sesame seed bagel',                              350, 'Bagels', 3,  true),
  ('c0000000-0000-0000-0000-000000000001', 'Poppy Seed Bagel',      'Traditional poppy seed bagel',                           350, 'Bagels', 4,  true),
  ('c0000000-0000-0000-0000-000000000001', 'Salt Bagel',            'Topped with coarse sea salt',                            350, 'Bagels', 5,  true),
  ('c0000000-0000-0000-0000-000000000001', 'Onion Bagel',           'Baked with dried onion flakes',                          350, 'Bagels', 6,  true),
  ('c0000000-0000-0000-0000-000000000001', 'Cinnamon Raisin Bagel', 'Sweet cinnamon bagel with plump raisins',                375, 'Bagels', 7,  true),
  ('c0000000-0000-0000-0000-000000000001', 'Blueberry Bagel',       'Sweet bagel studded with blueberries',                   375, 'Bagels', 8,  true),
  ('c0000000-0000-0000-0000-000000000001', 'Whole Wheat Bagel',     'Hearty whole wheat, great for any topping',              375, 'Bagels', 9,  true),
  ('c0000000-0000-0000-0000-000000000001', 'Asiago Cheese Bagel',   'Topped with aged asiago cheese, baked golden',           400, 'Bagels', 10, true)
ON CONFLICT DO NOTHING;

-- ─── SPREADS ─────────────────────────────────────────────────────────────────
INSERT INTO menu_items (menu_id, name, description, price_cents, category, display_order, active)
VALUES
  ('c0000000-0000-0000-0000-000000000001', 'Plain Cream Cheese',    'Classic smooth cream cheese',                            200, 'Spreads', 11, true),
  ('c0000000-0000-0000-0000-000000000001', 'Scallion Cream Cheese', 'Cream cheese mixed with fresh scallions',                250, 'Spreads', 12, true),
  ('c0000000-0000-0000-0000-000000000001', 'Lox Spread',            'Cream cheese blended with smoked salmon',                350, 'Spreads', 13, true),
  ('c0000000-0000-0000-0000-000000000001', 'Veggie Cream Cheese',   'Cream cheese with cucumber, tomato, and herbs',          275, 'Spreads', 14, true),
  ('c0000000-0000-0000-0000-000000000001', 'Butter',                'Salted or unsalted butter',                              100, 'Spreads', 15, true)
ON CONFLICT DO NOTHING;

-- ─── SANDWICHES ──────────────────────────────────────────────────────────────
INSERT INTO menu_items (menu_id, name, description, price_cents, category, modifiers_json, display_order, active)
VALUES
  (
    'c0000000-0000-0000-0000-000000000001',
    'Lox and Cream Cheese',
    'Nova lox, cream cheese, capers, red onion, tomato on your choice of bagel',
    1400, 'Sandwiches',
    '[{"name": "Plain Bagel", "price_cents": 0}, {"name": "Everything Bagel", "price_cents": 0}, {"name": "Sesame Bagel", "price_cents": 0}, {"name": "Whole Wheat Bagel", "price_cents": 0}]'::jsonb,
    16, true
  ),
  (
    'c0000000-0000-0000-0000-000000000001',
    'Egg and Cheese',
    'Fried egg and American cheese on your choice of bagel',
    800, 'Sandwiches',
    '[{"name": "Plain Bagel", "price_cents": 0}, {"name": "Everything Bagel", "price_cents": 0}, {"name": "Sesame Bagel", "price_cents": 0}, {"name": "Whole Wheat Bagel", "price_cents": 0}]'::jsonb,
    17, true
  ),
  (
    'c0000000-0000-0000-0000-000000000001',
    'BEC (Bacon Egg Cheese)',
    'Crispy bacon, fried egg, and American cheese',
    925, 'Sandwiches',
    '[{"name": "Plain Bagel", "price_cents": 0}, {"name": "Everything Bagel", "price_cents": 0}, {"name": "Sesame Bagel", "price_cents": 0}]'::jsonb,
    18, true
  ),
  (
    'c0000000-0000-0000-0000-000000000001',
    'Turkey Club Bagel',
    'Sliced turkey, cream cheese, lettuce, tomato',
    1050, 'Sandwiches',
    '[{"name": "Plain Bagel", "price_cents": 0}, {"name": "Everything Bagel", "price_cents": 0}, {"name": "Whole Wheat Bagel", "price_cents": 0}]'::jsonb,
    19, true
  )
ON CONFLICT DO NOTHING;

-- ─── BULK ────────────────────────────────────────────────────────────────────
INSERT INTO menu_items (menu_id, name, description, price_cents, category, display_order, active)
VALUES
  ('c0000000-0000-0000-0000-000000000001', 'Half Dozen Bagels', 'Your choice of 6 fresh-baked bagels',   1200, 'Bulk', 20, true),
  ('c0000000-0000-0000-0000-000000000001', 'Dozen Bagels',      'Your choice of 12 fresh-baked bagels',  2200, 'Bulk', 21, true)
ON CONFLICT DO NOTHING;

-- ─── DRINKS ──────────────────────────────────────────────────────────────────
INSERT INTO menu_items (menu_id, name, description, price_cents, category, modifiers_json, display_order, active)
VALUES
  (
    'c0000000-0000-0000-0000-000000000001',
    'Coffee',
    'Fresh brewed drip coffee',
    300, 'Drinks',
    '[{"name": "Regular", "price_cents": 0}, {"name": "Large", "price_cents": 100}]'::jsonb,
    22, true
  ),
  (
    'c0000000-0000-0000-0000-000000000001',
    'Orange Juice',
    'Fresh squeezed orange juice',
    425, 'Drinks',
    '[{"name": "Small", "price_cents": 0}, {"name": "Large", "price_cents": 150}]'::jsonb,
    23, true
  )
ON CONFLICT DO NOTHING;

-- ============================================================
-- DONE
-- ============================================================
SELECT
  s.name    AS shop,
  s.slug,
  s.phone_number_e164 AS phone,
  s.merchant_pin,
  COUNT(mi.id) AS menu_item_count
FROM shops s
JOIN menus m ON m.shop_id = s.id
JOIN menu_items mi ON mi.menu_id = m.id
WHERE s.id = 'b0000000-0000-0000-0000-000000000001'
GROUP BY s.id;
