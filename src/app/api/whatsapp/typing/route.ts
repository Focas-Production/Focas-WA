import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * POST /api/whatsapp/typing
 *
 * Body: { conversation_id: <internal UUID> }
 *
 * Shows "typing…" on the contact's phone while an agent composes a
 * reply. Resolves the conversation's most recent CUSTOMER message and
 * sends Meta's read + typing_indicator acknowledgment for it (the two
 * are bundled — Meta has no free-standing typing API, so this also
 * turns the contact's ticks blue).
 *
 * Cosmetic endpoint: every soft-failure (no inbound yet, 24h session
 * window closed, Meta rejecting an old wamid) returns 200 with
 * `{ shown: false }` rather than an error — the composer fires this on
 * keystrokes and must never surface a failure to the agent or retry.
 * Hard failures (auth, tenancy, missing body) still get real statuses
 * so a misintegrated client is debuggable.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const limit = checkRateLimit(`typing:${user.id}`, RATE_LIMITS.typing);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    // Resolve the caller's account_id — conversation + whatsapp_config
    // are account-scoped post-multi-user.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      );
    }

    const body = await request.json().catch(() => null);
    const conversationId = body?.conversation_id as string | undefined;
    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required' },
        { status: 400 },
      );
    }

    // Tenancy check: the conversation must belong to this account.
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (convError || !conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 },
      );
    }

    // Latest customer message with a Meta wamid — the acknowledgment
    // target. Agent-initiated threads (template outreach with no reply
    // yet) have none: nothing to acknowledge, soft no-op.
    const { data: lastInbound } = await supabase
      .from('messages')
      .select('message_id, created_at')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .not('message_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!lastInbound?.message_id) {
      return NextResponse.json({ shown: false, reason: 'no_inbound' });
    }

    // Typing acknowledgments are only valid inside the 24h session
    // window. The composer disables free-form input past it anyway;
    // this guard just avoids a guaranteed-to-fail Meta call when the
    // client's window state is stale.
    const ageMs = Date.now() - new Date(lastInbound.created_at).getTime();
    if (ageMs > 24 * 60 * 60 * 1000) {
      return NextResponse.json({ shown: false, reason: 'session_expired' });
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .single();
    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured.' },
        { status: 400 },
      );
    }

    try {
      await sendTypingIndicator({
        phoneNumberId: config.phone_number_id,
        accessToken: decrypt(config.access_token),
        messageId: lastInbound.message_id,
      });
    } catch (err) {
      // Meta rejecting the ack (wamid aged out, number re-registered,
      // transient 5xx) is expected noise for a cosmetic feature — log
      // for diagnosability, report soft-failure, never 5xx.
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[whatsapp/typing] Meta rejected typing ack:', message);
      return NextResponse.json({ shown: false, reason: 'meta_rejected' });
    }

    return NextResponse.json({ shown: true });
  } catch (error) {
    console.error('Error in WhatsApp typing POST:', error);
    return NextResponse.json(
      { error: 'Failed to send typing indicator' },
      { status: 500 },
    );
  }
}
