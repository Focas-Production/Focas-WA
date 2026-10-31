-- ============================================================
-- 051_social_channels — Instagram + Facebook Messenger inboxes
--
-- Adds Instagram Direct and Messenger as conversation channels next
-- to WhatsApp, so the shared inbox (and the bots behind it — flows,
-- automations, AI auto-reply) work across all three, WATI-style.
--
--   1. `social_channels` — one row per connected Messenger Page or
--      Instagram professional account. Holds the (encrypted) Page
--      access token used for both — Instagram messaging goes through
--      the linked Facebook Page.
--   2. `contacts` gains the page-scoped ids Meta identifies people by
--      on these channels (PSID / IGSID) plus the Instagram @handle.
--      A contact that has only ever DM'd on Instagram/Messenger has
--      `phone = ''` (phone stays NOT NULL; the phone dedup index from
--      022 already ignores empty values).
--   3. `conversations.channel` — one thread per (account, contact,
--      channel). The 036 unique index on (account, contact) is
--      widened to include the channel, and the dedup helper is
--      redefined to match so a re-run can never merge threads across
--      channels.
--
-- RLS: `social_channels` is settings-class (mirrors shopify_config):
-- any member may read, admin+ may write. The webhook receiver and
-- send paths use the service-role client.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1) Connected channels -------------------------------------------------
CREATE TABLE IF NOT EXISTS social_channels (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  channel            text NOT NULL CHECK (channel IN ('messenger', 'instagram')),
  -- The id Meta puts in `entry[].id` on webhooks: the Page id for
  -- Messenger, the Instagram professional account id for Instagram.
  external_id        text NOT NULL,
  -- The Facebook Page the channel sends through (same as external_id
  -- for Messenger; the linked Page for Instagram).
  page_id            text NOT NULL,
  name               text,
  username           text,                 -- Instagram @handle (no @)
  picture_url        text,
  page_access_token  text NOT NULL,        -- AES-256-GCM-encrypted
  status             text NOT NULL DEFAULT 'connected'
                       CHECK (status IN ('connected', 'disconnected')),
  last_error         text,
  connected_at       timestamptz DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- A Page / IG account can belong to one account on this instance,
  -- so the webhook's entry.id → account lookup is unambiguous.
  UNIQUE (channel, external_id)
);

CREATE INDEX IF NOT EXISTS idx_social_channels_account ON social_channels(account_id);

ALTER TABLE social_channels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS social_channels_select ON social_channels;
CREATE POLICY social_channels_select ON social_channels FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS social_channels_insert ON social_channels;
CREATE POLICY social_channels_insert ON social_channels FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS social_channels_update ON social_channels;
CREATE POLICY social_channels_update ON social_channels FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS social_channels_delete ON social_channels;
CREATE POLICY social_channels_delete ON social_channels FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON social_channels;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON social_channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 2) Contact identities -------------------------------------------------
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS messenger_psid     text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS instagram_igsid    text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS instagram_username text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_messenger_psid
  ON contacts (account_id, messenger_psid)
  WHERE messenger_psid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_instagram_igsid
  ON contacts (account_id, instagram_igsid)
  WHERE instagram_igsid IS NOT NULL;

-- 3) Conversation channel -----------------------------------------------
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_channel_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_channel_check
      CHECK (channel IN ('whatsapp', 'instagram', 'messenger'));
  END IF;
END $$;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS social_channel_id uuid
  REFERENCES social_channels(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS idx_conversations_account_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_channel
  ON conversations (account_id, contact_id, channel);

CREATE INDEX IF NOT EXISTS idx_conversations_channel
  ON conversations (account_id, channel);

-- Redefine 036's dedup helper so it only ever merges threads that
-- share a channel. Body is otherwise identical to 036.
CREATE OR REPLACE FUNCTION public.merge_duplicate_conversations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group    RECORD;
  v_survivor UUID;
  v_losers   UUID[];
  v_all      UUID[];
  v_merged   INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT account_id,
           contact_id,
           channel,
           array_agg(id ORDER BY created_at ASC, id ASC) AS ids,
           COALESCE(SUM(unread_count), 0)                AS total_unread
    FROM conversations
    GROUP BY account_id, contact_id, channel
    HAVING count(*) > 1
  LOOP
    v_all      := v_group.ids;
    v_survivor := v_all[1];
    v_losers   := v_all[2:array_length(v_all, 1)];

    UPDATE messages          SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE message_reactions SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE deals             SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE flow_runs         SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE notifications     SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE ai_usage_log      SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);

    UPDATE conversations c
    SET unread_count      = v_group.total_unread,
        last_message_text = lm.content_text,
        last_message_at   = lm.created_at,
        updated_at        = NOW()
    FROM (
      SELECT content_text, created_at
      FROM messages
      WHERE conversation_id = v_survivor
      ORDER BY created_at DESC
      LIMIT 1
    ) lm
    WHERE c.id = v_survivor;

    UPDATE conversations
    SET unread_count = v_group.total_unread,
        updated_at   = NOW()
    WHERE id = v_survivor
      AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = v_survivor);

    DELETE FROM conversations WHERE id = ANY(v_losers);

    v_merged := v_merged + COALESCE(array_length(v_losers, 1), 0);
  END LOOP;

  RETURN v_merged;
END;
$$;

ALTER FUNCTION public.merge_duplicate_conversations() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC;
