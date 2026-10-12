-- ============================================================
-- 047_contact_allow_campaign.sql
--
-- contacts.allow_campaign — per-contact campaign opt-out.
--
-- Every contact can receive campaigns (broadcasts) by default. Setting
-- the flag to FALSE takes that one person out of every campaign:
--
--   - the launch skips them when it resolves the audience
--     (src/lib/whatsapp/broadcast-launch.ts);
--   - the engine re-checks at send time, so a contact who opts out
--     after a campaign was scheduled is still skipped — failed as
--     "opted out" and refunded, never sent
--     (src/lib/whatsapp/broadcast-engine.ts);
--   - the public API broadcast drops them too (broadcast-core.ts).
--
-- One-to-one messages (inbox replies, template sends from the inbox or
-- the API, automations, flows) are NOT affected — this only governs
-- marketing campaigns.
--
-- allow_campaign_updated_at records when the flag last changed (set by
-- the trigger below, whoever changed it), so "since when has this
-- person been opted out" is answerable.
--
-- NOT NULL DEFAULT TRUE: existing rows backfill to TRUE (Postgres 11+
-- does this as a metadata-only change, no table rewrite). Idempotent.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS allow_campaign BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS allow_campaign_updated_at TIMESTAMPTZ;

-- Opted-out contacts are the small minority — a partial index keeps
-- "who is opted out in this account" cheap without indexing every row.
CREATE INDEX IF NOT EXISTS idx_contacts_campaign_opted_out
  ON contacts(account_id)
  WHERE allow_campaign = FALSE;

CREATE OR REPLACE FUNCTION public.stamp_contact_allow_campaign()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.allow_campaign = FALSE THEN
      NEW.allow_campaign_updated_at := now();
    END IF;
  ELSIF NEW.allow_campaign IS DISTINCT FROM OLD.allow_campaign THEN
    NEW.allow_campaign_updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stamp_allow_campaign ON contacts;
CREATE TRIGGER stamp_allow_campaign
  BEFORE INSERT OR UPDATE OF allow_campaign ON contacts
  FOR EACH ROW EXECUTE FUNCTION public.stamp_contact_allow_campaign();

-- ------------------------------------------------------------
-- filter_contacts_by_tags (migration 025) gains an optional campaign
-- filter so the Contacts page can combine "tags" with "opted out".
-- NULL = no filter (the old behaviour). The signature changes, so the
-- old 4-arg function is dropped first; same SECURITY INVOKER + grants.
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS public.filter_contacts_by_tags(UUID[], TEXT, INT, INT);

CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0,
  p_allow_campaign BOOLEAN DEFAULT NULL
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE ct.tag_id = ANY(p_tag_ids)
      AND (p_allow_campaign IS NULL OR c.allow_campaign = p_allow_campaign)
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, BOOLEAN) TO authenticated;
