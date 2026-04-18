-- DEF-001: Add "custom_text" and "document" to the knowledge_base source CHECK constraint.
-- The train-tenant Edge Function stores these values, but the original constraint rejected them.

ALTER TABLE knowledge_base DROP CONSTRAINT IF EXISTS knowledge_base_source_check;

ALTER TABLE knowledge_base
  ADD CONSTRAINT knowledge_base_source_check
  CHECK (source IN ('website_scrape', 'manual', 'menu', 'faq', 'toast_menu', 'custom_text', 'document'));
