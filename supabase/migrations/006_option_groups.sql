-- SprintAI Option Groups Migration — Item Customization
-- Adds structured option groups and choices for menu items (e.g. bread type, condiments)
-- Replaces flat modifiers_json with a proper option group model supporting required/optional groups

-- ============================================================
-- OPTION GROUPS
-- ============================================================
CREATE TABLE option_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                      -- e.g. "Bread Type", "Condiments"
  required BOOLEAN NOT NULL DEFAULT false, -- whether customer MUST select from this group
  min_select INTEGER NOT NULL DEFAULT 0,   -- minimum selections required (e.g. 1 for required)
  max_select INTEGER NOT NULL DEFAULT 1,   -- maximum selections allowed (1 = single, >1 = multi-select)
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_option_groups_menu_item ON option_groups(menu_item_id);

-- ============================================================
-- OPTION CHOICES
-- ============================================================
CREATE TABLE option_choices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  option_group_id UUID NOT NULL REFERENCES option_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                      -- e.g. "Roll", "Bagel", "Salt", "Pepper"
  price_cents INTEGER NOT NULL DEFAULT 0,  -- extra cost beyond the base item (0 if free)
  is_default BOOLEAN NOT NULL DEFAULT false,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_option_choices_group ON option_choices(option_group_id);

-- ============================================================
-- ROW-LEVEL SECURITY
-- ============================================================
ALTER TABLE option_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE option_choices ENABLE ROW LEVEL SECURITY;

-- Admins have full access
CREATE POLICY "Admins have full access to option_groups"
  ON option_groups FOR ALL
  USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');

CREATE POLICY "Admins have full access to option_choices"
  ON option_choices FOR ALL
  USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');

-- Tenants can view option groups for their menu items
CREATE POLICY "Tenants can view their own option_groups"
  ON option_groups FOR SELECT
  USING (
    menu_item_id IN (
      SELECT mi.id FROM menu_items mi
      JOIN menus m ON m.id = mi.menu_id
      JOIN shops s ON s.id = m.shop_id
      WHERE s.tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
    )
  );

CREATE POLICY "Tenants can view their own option_choices"
  ON option_choices FOR SELECT
  USING (
    option_group_id IN (
      SELECT og.id FROM option_groups og
      JOIN menu_items mi ON mi.id = og.menu_item_id
      JOIN menus m ON m.id = mi.menu_id
      JOIN shops s ON s.id = m.shop_id
      WHERE s.tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
    )
  );
