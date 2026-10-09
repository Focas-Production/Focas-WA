import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const walletMocks = vi.hoisted(() => ({
  getTemplateCharge: vi.fn(),
  chargeTemplateSend: vi.fn(),
}));
vi.mock('@/lib/wallet/wallet', () => ({
  ...walletMocks,
  stampChargeReference: vi.fn(),
  refundTemplateCharge: vi.fn(),
  WalletError: class extends Error {},
}));
const metaMocks = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.1' })),
}));
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  ...metaMocks,
}));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }));
vi.mock('@/lib/flows/admin-client', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'update', 'eq']) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => void) => resolve({ error: null });
  return { supabaseAdmin: () => chain };
});
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('requires a valid interactive payload for interactive messages', async () => {
    // Missing payload entirely.
    await expectSendError(
      { ...base, messageType: 'interactive' },
      400,
      /payload is required/
    );
    // Too many buttons.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
      400,
      /at most 3 buttons/
    );
    // Over-long button title.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'a', title: 'x'.repeat(21) }],
        },
      },
      400,
      /20-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

// Minimal chainable Supabase stub: every query resolves to the row
// registered for its table.
function fakeDb(
  rows: Record<string, unknown>,
  writes: Array<{ table: string; op: string; value: unknown }> = []
): SupabaseClient {
  return {
    from(table: string) {
      const result = { data: rows[table] ?? null, error: null };
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) chain[m] = () => chain;
      for (const m of ['update', 'insert']) {
        chain[m] = (value: unknown) => {
          writes.push({ table, op: m, value });
          return chain;
        };
      }
      chain.single = async () => result;
      chain.maybeSingle = async () => result;
      return chain;
    },
  } as unknown as SupabaseClient;
}

describe('sendMessageToConversation — template params (pre-charge)', () => {
  const db = (writes?: Array<{ table: string; op: string; value: unknown }>) =>
    fakeDb({
      conversations: { id: 'cv-1', contact: { id: 'ct-1', phone: '+917305504500' } },
      whatsapp_config: { id: 'cfg-1', phone_number_id: 'pn-1', access_token: 'tok' },
      message_templates: {
        id: 'tpl-1',
        user_id: 'u-1',
        name: 'live_class_removed',
        category: 'Utility',
        language: 'en_US',
        body_text: 'Hi {{name}}, calendar: {{calendar_link}}',
        created_at: '2026-01-01T00:00:00Z',
      },
      messages: { id: 'msg-1' },
    }, writes);

  it('rejects an unknown named variable with 400 before charging the wallet', async () => {
    const err = await sendMessageToConversation(db(), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'live_class_removed',
      templateMessageParams: { name: 'Ravi', calender_link: 'https://x' },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SendMessageError);
    expect(err.code).toBe('invalid_template_params');
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/"calender_link"/);
    expect(walletMocks.chargeTemplateSend).not.toHaveBeenCalled();
  });

  it('rejects an empty named body map with 400 before charging', async () => {
    const err = await sendMessageToConversation(db(), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'live_class_removed',
      templateMessageParams: { body: {} },
    }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Missing value/);
    expect(walletMocks.chargeTemplateSend).not.toHaveBeenCalled();
  });
});

describe('sendMessageToConversation — inbox copy of API template sends', () => {
  it('stores the rendered template body when no content_text is given', async () => {
    walletMocks.getTemplateCharge.mockResolvedValue({ category: 'utility', pricePaise: 0 });
    const writes: Array<{ table: string; op: string; value: unknown }> = [];
    const db = fakeDb(
      {
        conversations: { id: 'cv-1', contact: { id: 'ct-1', phone: '+917305504500' } },
        whatsapp_config: { id: 'cfg-1', phone_number_id: 'pn-1', access_token: 'tok' },
        message_templates: {
          id: 'tpl-1',
          user_id: 'u-1',
          name: 'live_class_removed',
          category: 'Utility',
          language: 'en_US',
          body_text: 'Hi {{name}}, calendar: {{calendar_link}}',
          created_at: '2026-01-01T00:00:00Z',
        },
        messages: { id: 'msg-1' },
      },
      writes
    );

    const result = await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'live_class_removed',
      templateMessageParams: { name: 'Ravi', calendar_link: 'https://x' },
    });

    expect(result).toEqual({ messageId: 'msg-1', whatsappMessageId: 'wamid.1' });
    const insert = writes.find((w) => w.table === 'messages' && w.op === 'insert');
    expect(insert?.value).toMatchObject({
      content_type: 'template',
      content_text: 'Hi Ravi, calendar: https://x',
      template_name: 'live_class_removed',
    });
    const convUpdate = writes.find((w) => w.table === 'conversations' && w.op === 'update');
    expect(convUpdate?.value).toMatchObject({
      last_message_text: 'Hi Ravi, calendar: https://x',
    });
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});
