-- 061_normalize_open_hours_structured
-- Phase 5: Convert open_hours from array-window shape to flat-object shape.
--
-- OLD shape (array of windows per day):
--   { "mon": [{"open":"11:00","close":"21:00"}], "tue": [...], ... }
-- NEW shape (flat object per day with closed flag):
--   { "mon": {"closed":false,"open":"11:00","close":"21:00"}, "tue": {"closed":true}, ... }
--
-- Times are 24h "HH:MM" in shop-local timezone. Closed days have closed:true
-- and omit open/close. Missing days = implied closed.

-- Normalize open_hours: array-window shape -> flat-object shape
DO $$
DECLARE
  rec RECORD;
  new_hours JSONB;
  day_keys TEXT[] := ARRAY['mon','tue','wed','thu','fri','sat','sun'];
  d TEXT;
  wins JSONB;
BEGIN
  FOR rec IN SELECT id, open_hours FROM shops WHERE open_hours IS NOT NULL AND open_hours::text != '{}' LOOP
    new_hours := '{}'::JSONB;
    FOREACH d IN ARRAY day_keys LOOP
      wins := rec.open_hours -> d;
      IF wins IS NOT NULL AND jsonb_typeof(wins) = 'array' AND jsonb_array_length(wins) > 0 THEN
        -- Old shape: take the first window (or skip empty arrays)
        IF jsonb_array_length(wins) > 0 THEN
          new_hours := jsonb_set(new_hours, ARRAY[d],
            jsonb_build_object('closed', false, 'open', wins->0->>'open', 'close', wins->0->>'close'));
        END IF;
      ELSIF wins IS NOT NULL AND jsonb_typeof(wins) = 'object' THEN
        -- Already new shape — keep as-is
        new_hours := jsonb_set(new_hours, ARRAY[d], wins);
      END IF;
      -- null/missing = closed, omitted from new_hours
    END LOOP;
    UPDATE shops SET open_hours = new_hours WHERE id = rec.id;
  END LOOP;

  -- Normalize delivery_hours the same way if any exist
  FOR rec IN SELECT id, delivery_hours FROM shops WHERE delivery_hours IS NOT NULL AND delivery_hours::text != '{}' LOOP
    new_hours := '{}'::JSONB;
    FOREACH d IN ARRAY day_keys LOOP
      wins := rec.delivery_hours -> d;
      IF wins IS NOT NULL AND jsonb_typeof(wins) = 'array' AND jsonb_array_length(wins) > 0 THEN
        new_hours := jsonb_set(new_hours, ARRAY[d],
          jsonb_build_object('closed', false, 'open', wins->0->>'open', 'close', wins->0->>'close'));
      ELSIF wins IS NOT NULL AND jsonb_typeof(wins) = 'object' THEN
        new_hours := jsonb_set(new_hours, ARRAY[d], wins);
      END IF;
    END LOOP;
    UPDATE shops SET delivery_hours = new_hours WHERE id = rec.id;
  END LOOP;
END $$;

-- Also clean up string-valued open_hours (legacy free-text from Phase 3/4 crawl)
UPDATE shops SET open_hours = '{}'::jsonb
WHERE open_hours IS NOT NULL AND jsonb_typeof(open_hours) = 'string';

-- Update column comment
COMMENT ON COLUMN shops.open_hours IS
  'Per-day operating hours in the shop''s LOCAL timezone. Shape: { "mon": {"closed":false,"open":"11:00","close":"21:00"}, "tue": {"closed":true}, ... }. Times are 24h HH:MM, never UTC. Closed days have closed:true or are omitted.';

COMMENT ON COLUMN shops.delivery_hours IS
  'Delivery-specific hours, same shape as open_hours. Defaults to open_hours when empty.';