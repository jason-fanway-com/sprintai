-- 110: the qa_ro row filters name a slug that no longer exists.
--
-- Every qa_ro view scopes rows to `is_test = true OR slug IN
-- ('not-just-bagels','njb-test-clone-11353')`. The NJB test clone was retired
-- 2026-09-06 and its slug is now `retired-njb-test-clone`, so that array entry
-- is dead string. It is not currently hiding anything — the retirement also set
-- is_test = true, so the clone's rows still match the first branch — but a
-- filter that names a slug which does not exist is a trap for the next person
-- who reads it and assumes it is load-bearing.
--
-- Replaced with the real remaining special case: the ONE production shop the
-- reviewer must be able to see despite is_test = false.

CREATE OR REPLACE FUNCTION qa_ro.visible_shop_ids()
RETURNS TABLE (id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT shops.id FROM shops
   WHERE shops.is_test = true
      -- Not Just Bagels: the only real restaurant, is_test = false, and the
      -- reviewer needs to see it to qualify a launch. Retired clones do not
      -- need naming here — retirement sets is_test = true.
      OR shops.slug = 'not-just-bagels';
$$;

COMMENT ON FUNCTION qa_ro.visible_shop_ids() IS
  'Single definition of which shops qa_ro exposes. Views call this instead of repeating a slug list that drifts.';

GRANT EXECUTE ON FUNCTION qa_ro.visible_shop_ids() TO qa_readonly;
