import { describe, expect, it } from 'vitest';
import type { MessageTemplate, OtpTemplateButton } from '@/types';
import { buildMetaTemplatePayload } from './template-components';
import { buildSendComponents } from './template-send-builder';
import {
  normalizeAuthPayload,
  validateButtons,
  validateTemplatePayload,
  type TemplatePayload,
} from './template-validators';

const copyCode: OtpTemplateButton = {
  type: 'OTP',
  otp_type: 'COPY_CODE',
  text: 'Copy code',
  add_security_recommendation: true,
  code_expiration_minutes: 10,
};

const auth = (overrides: Partial<TemplatePayload> = {}): TemplatePayload => ({
  name: 'login_otp',
  category: 'Authentication',
  language: 'en_US',
  body_text: 'ignored',
  buttons: [copyCode],
  ...overrides,
});

describe('authentication templates — validation', () => {
  it('accepts a copy-code template', () => {
    expect(validateTemplatePayload(auth())).toEqual({ bodyVarCount: 1, headerVarCount: 0 });
  });
  it('requires exactly one OTP button', () => {
    expect(() => validateTemplatePayload(auth({ buttons: [] }))).toThrow(/exactly one OTP/);
    expect(() =>
      validateTemplatePayload(auth({ buttons: [{ type: 'QUICK_REPLY', text: 'Hi' }] })),
    ).toThrow(/exactly one OTP/);
  });
  it('rejects a header', () => {
    expect(() =>
      validateTemplatePayload(auth({ header_type: 'text', header_content: 'Hi' })),
    ).toThrow(/cannot have a header/);
  });
  it('bounds the expiry to 1–90 minutes', () => {
    expect(() =>
      validateTemplatePayload(auth({ buttons: [{ ...copyCode, code_expiration_minutes: 91 }] })),
    ).toThrow(/between 1 and 90/);
    expect(() =>
      validateTemplatePayload(auth({ buttons: [{ ...copyCode, code_expiration_minutes: 0 }] })),
    ).toThrow(/between 1 and 90/);
  });
  it('requires a valid app for one-tap', () => {
    const oneTap: OtpTemplateButton = {
      ...copyCode,
      otp_type: 'ONE_TAP',
      autofill_text: 'Autofill',
      supported_apps: [{ package_name: 'myapp', signature_hash: 'short' }],
    };
    expect(() => validateTemplatePayload(auth({ buttons: [oneTap] }))).toThrow(/package name/);
    expect(() =>
      validateTemplatePayload(
        auth({
          buttons: [
            { ...oneTap, supported_apps: [{ package_name: 'com.example.app', signature_hash: 'K8a/AINcGX7' }] },
          ],
        }),
      ),
    ).not.toThrow();
  });
  it('rejects OTP buttons on non-auth templates', () => {
    expect(() => validateButtons([copyCode])).toThrow(/only be used in Authentication/);
  });
  it('normalizes text fields to Meta wording', () => {
    const p = normalizeAuthPayload(auth({ body_text: 'tampered', footer_text: 'x' }));
    expect(p.body_text).toBe(
      '*{{1}}* is your verification code. For your security, do not share this code.',
    );
    expect(p.footer_text).toBe('This code expires in 10 minutes.');
  });
});

describe('authentication templates — Meta create payload', () => {
  it('builds BODY / FOOTER / OTP BUTTONS components', () => {
    expect(buildMetaTemplatePayload(auth())).toEqual({
      name: 'login_otp',
      category: 'AUTHENTICATION',
      language: 'en_US',
      components: [
        { type: 'BODY', add_security_recommendation: true },
        { type: 'FOOTER', code_expiration_minutes: 10 },
        {
          type: 'BUTTONS',
          buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }],
        },
      ],
    });
  });
  it('omits the footer without expiry and adds supported_apps for one-tap', () => {
    const payload = buildMetaTemplatePayload(
      auth({
        buttons: [
          {
            type: 'OTP',
            otp_type: 'ONE_TAP',
            text: 'Copy code',
            autofill_text: 'Autofill',
            supported_apps: [{ package_name: 'com.example.app', signature_hash: 'K8a/AINcGX7' }],
          },
        ],
      }),
    );
    expect(payload.components).toEqual([
      { type: 'BODY', add_security_recommendation: false },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'OTP',
            otp_type: 'ONE_TAP',
            text: 'Copy code',
            autofill_text: 'Autofill',
            supported_apps: [{ package_name: 'com.example.app', signature_hash: 'K8a/AINcGX7' }],
          },
        ],
      },
    ]);
  });
});

describe('authentication templates — send', () => {
  const row: MessageTemplate = {
    id: 'r1',
    user_id: 'u1',
    name: 'login_otp',
    category: 'Authentication',
    language: 'en_US',
    body_text: '*{{1}}* is your verification code.',
    buttons: [copyCode],
    created_at: '2026-01-01T00:00:00Z',
  };
  it('puts the code on both the body and the OTP button', () => {
    expect(buildSendComponents(row, { body: ['482913'] })).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: '482913' }],
      },
    ]);
  });
  it('rejects codes longer than 15 characters', () => {
    expect(() => buildSendComponents(row, { body: ['1234567890123456'] })).toThrow(/15/);
  });
});
