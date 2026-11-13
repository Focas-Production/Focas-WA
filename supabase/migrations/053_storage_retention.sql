-- ============================================================
-- 053_storage_retention.sql
--
-- Helpers for the daily maintenance cron (`GET /api/maintenance/cron`)
-- that keeps a free-tier Supabase project inside its limits:
--
--   1. chat_media_expired_objects(cutoff, limit)
--      Lists `chat-media` objects older than `cutoff` that are safe to
--      delete: the file is attached to at least one chat message and
--      is NOT used anywhere else (template header samples, broadcasts,
--      flow / automation steps, quick replies, catalog products,
--      contact avatars). Files that no message points at — staged
--      template headers, avatars, drafts — are never returned.
--      The cron deletes them through the Storage API (never by
--      DELETE on storage.objects) and nulls `messages.media_url`, so
--      the inbox shows "media unavailable" instead of a broken file.
--
--   2. prune_old_logs(log_days, notification_days)
--      Deletes debug/audit rows nobody reads after a few weeks:
--        - automation_logs older than log_days
--        - flow_run_events older than log_days whose run has ended
--        - notifications already read, older than notification_days
--      Billing data (wallet_transactions, ai_usage_log), messages,
--      broadcast_recipients and contacts are never touched.
--
-- Both are SECURITY DEFINER and executable only by service_role.
-- Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.chat_media_expired_objects(
  p_cutoff timestamptz,
  p_limit  integer DEFAULT 500
)
RETURNS TABLE (object_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, storage
AS $$
  WITH msg_media AS (
    -- One pass over messages: the object path after the bucket name
    -- in the public URL (…/object/public/chat-media/<path>).
    SELECT DISTINCT split_part(m.media_url, '/object/public/chat-media/', 2) AS name
    FROM public.messages m
    WHERE m.media_url LIKE '%/object/public/chat-media/%'
  ),
  avatar_media AS (
    SELECT DISTINCT split_part(c.avatar_url, '/object/public/chat-media/', 2) AS name
    FROM public.contacts c
    WHERE c.avatar_url LIKE '%/object/public/chat-media/%'
  )
  SELECT o.name
  FROM storage.objects o
  JOIN msg_media mm ON mm.name = o.name
  WHERE o.bucket_id = 'chat-media'
    AND o.created_at < p_cutoff
    AND NOT EXISTS (SELECT 1 FROM avatar_media a WHERE a.name = o.name)
    -- Small config tables: a whole-row text search covers every
    -- column (header_media_url, JSON payloads, …) without listing them.
    AND NOT EXISTS (SELECT 1 FROM public.message_templates t WHERE strpos(t::text, o.name) > 0)
    AND NOT EXISTS (SELECT 1 FROM public.broadcasts b        WHERE strpos(b::text, o.name) > 0)
    AND NOT EXISTS (SELECT 1 FROM public.flow_nodes f        WHERE strpos(f::text, o.name) > 0)
    AND NOT EXISTS (SELECT 1 FROM public.automation_steps s  WHERE strpos(s::text, o.name) > 0)
    AND NOT EXISTS (SELECT 1 FROM public.quick_replies q     WHERE strpos(q::text, o.name) > 0)
    AND NOT EXISTS (SELECT 1 FROM public.catalog_products p  WHERE strpos(p::text, o.name) > 0)
  ORDER BY o.created_at
  LIMIT GREATEST(p_limit, 0);
$$;

REVOKE ALL ON FUNCTION public.chat_media_expired_objects(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_media_expired_objects(timestamptz, integer) TO service_role;


CREATE OR REPLACE FUNCTION public.prune_old_logs(
  p_log_days          integer DEFAULT 30,
  p_notification_days integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_automation_logs integer := 0;
  v_flow_events     integer := 0;
  v_notifications   integer := 0;
BEGIN
  IF p_log_days > 0 THEN
    DELETE FROM automation_logs
    WHERE created_at < now() - make_interval(days => p_log_days);
    GET DIAGNOSTICS v_automation_logs = ROW_COUNT;

    DELETE FROM flow_run_events e
    USING flow_runs r
    WHERE e.flow_run_id = r.id
      AND r.status <> 'active'
      AND e.created_at < now() - make_interval(days => p_log_days);
    GET DIAGNOSTICS v_flow_events = ROW_COUNT;
  END IF;

  IF p_notification_days > 0 THEN
    DELETE FROM notifications
    WHERE read_at IS NOT NULL
      AND created_at < now() - make_interval(days => p_notification_days);
    GET DIAGNOSTICS v_notifications = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'automation_logs', v_automation_logs,
    'flow_run_events', v_flow_events,
    'notifications',   v_notifications
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prune_old_logs(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_old_logs(integer, integer) TO service_role;
