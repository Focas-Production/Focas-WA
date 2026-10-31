import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  GraphApiError,
  interactiveToQuickReplies,
  isOutsideWindowError,
  sendSocialMessage,
} from './graph-api'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('interactiveToQuickReplies', () => {
  it('maps buttons to quick replies and folds header/footer into the text', () => {
    const out = interactiveToQuickReplies({
      kind: 'buttons',
      header: 'Hi!',
      body: 'Pick one',
      footer: 'Reply anytime',
      buttons: [
        { id: 'sales', title: 'Talk to sales' },
        { id: 'support', title: 'A very long support button title' },
      ],
    })
    expect(out.text).toBe('Hi!\n\nPick one\n\nReply anytime')
    expect(out.quick_replies).toEqual([
      { content_type: 'text', title: 'Talk to sales', payload: 'sales' },
      { content_type: 'text', title: 'A very long support ', payload: 'support' },
    ])
  })

  it('flattens list rows across sections and caps at 13', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` }))
    const out = interactiveToQuickReplies({
      kind: 'list',
      body: 'Menu',
      button_label: 'Open',
      sections: [{ rows }, { rows: rows.map((r) => ({ ...r, id: `${r.id}b` })) }],
    })
    expect(out.text).toBe('Menu')
    expect(out.quick_replies).toHaveLength(13)
    expect(out.quick_replies[10].payload).toBe('r0b')
  })
})

describe('isOutsideWindowError', () => {
  it('recognises Messenger and Instagram window errors', () => {
    expect(isOutsideWindowError(new GraphApiError('x', 400, 10, 2018278))).toBe(true)
    expect(isOutsideWindowError(new GraphApiError('x', 400, 100, 2534022))).toBe(true)
    expect(isOutsideWindowError(new GraphApiError('x', 400, 100))).toBe(false)
    expect(isOutsideWindowError(new Error('x'))).toBe(false)
  })
})

describe('sendSocialMessage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends a RESPONSE message to the Page endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message_id: 'm_1' }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await sendSocialMessage({
      pageId: 'PAGE',
      pageAccessToken: 'TOKEN',
      recipientId: 'PSID',
      message: { kind: 'text', text: 'hello' },
    })

    expect(res).toEqual({ messageId: 'm_1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/PAGE/messages')
    expect(init.headers.Authorization).toBe('Bearer TOKEN')
    expect(JSON.parse(init.body)).toEqual({
      recipient: { id: 'PSID' },
      message: { text: 'hello' },
      messaging_type: 'RESPONSE',
    })
  })

  it('retries with the HUMAN_AGENT tag when the 24h window has closed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'outside window', code: 10, error_subcode: 2018278 } }, 400),
      )
      .mockResolvedValueOnce(jsonResponse({ message_id: 'm_2' }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await sendSocialMessage({
      pageId: 'PAGE',
      pageAccessToken: 'TOKEN',
      recipientId: 'PSID',
      message: { kind: 'media', mediaKind: 'document', url: 'https://x/f.pdf' },
    })

    expect(res.messageId).toBe('m_2')
    const retry = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(retry.messaging_type).toBe('MESSAGE_TAG')
    expect(retry.tag).toBe('HUMAN_AGENT')
    expect(retry.message.attachment).toEqual({
      type: 'file',
      payload: { url: 'https://x/f.pdf', is_reusable: false },
    })
  })

  it('does not retry other errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: 'bad token', code: 190 } }, 401))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      sendSocialMessage({
        pageId: 'PAGE',
        pageAccessToken: 'TOKEN',
        recipientId: 'PSID',
        message: { kind: 'text', text: 'hi' },
      }),
    ).rejects.toThrow('bad token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
