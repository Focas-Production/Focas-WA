/**
 * Pure validators for message templates, run BEFORE the Meta submit
 * call so a misconfigured template fails at save time (with a specific
 * field-level error) rather than at the Meta API boundary (where the
 * error is a generic 400 + opaque rejection_reason hours later).
 *
 * Every validator throws `Error(message)` — callers catch and surface
 * to the UI. Caps follow Meta's published limits for the Cloud API
 * template surface (v21.0):
 *   https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
 *
 * Per-element button validation lives here rather than as a JSONB CHECK
 * because Postgres CHECK constraints can't contain subqueries, and
 * generic CHECK violations don't give users an actionable error
 * ("button #3 has no `text`" beats "constraint violated").
 */

import type {
  MessageTemplate,
  TemplateButton,
  TemplateSampleValues,
} from '@/types';

export const TEMPLATE_LIMITS = {
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
  buttonTextMaxLength: 25,
  maxButtonsTotal: 10,
  maxUrlButtons: 2,
  maxPhoneButtons: 1,
  maxCopyCodeButtons: 1,
  /** Meta: lowercase a-z, digits, underscore. Up to 512 chars. */
  nameRegex: /^[a-z0-9_]{1,512}$/,
} as const;

export interface TemplatePayload {
  name: string;
  category: MessageTemplate['category'];
  language: string;
  header_type?: MessageTemplate['header_type'];
  header_content?: string;
  header_media_url?: string;
  header_handle?: string;
  body_text: string;
  footer_text?: string;
  buttons?: TemplateButton[];
  sample_values?: TemplateSampleValues;
}

export function validateTemplateName(name: string): void {
  if (!name) throw new Error('Template name is required.');
  if (!TEMPLATE_LIMITS.nameRegex.test(name)) {
    throw new Error(
      'Template name must use only lowercase letters, digits, and underscores (1-512 chars).',
    );
  }
}

/**
 * Extract sorted, deduplicated {{N}} indices from a string. Returns
 * `[1, 2, 4]` for `"Hi {{1}} {{2}}, item {{4}}"`.
 */
export function extractVariableIndices(text: string): number[] {
  const matches = text.matchAll(/\{\{(\d+)\}\}/g);
  const set = new Set<number>();
  for (const m of matches) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Meta supports two placeholder styles per template:
 *   - POSITIONAL: `{{1}}`, `{{2}}` …
 *   - NAMED:      `{{first_name}}`, `{{order_id}}` … (lowercase,
 *                 digits, underscores; sent with `parameter_format:
 *                 "NAMED"` and matched by `parameter_name` at send).
 * A single template can't mix the two.
 */
export type ParameterFormat = 'POSITIONAL' | 'NAMED';

/** Meta's rule for named parameter names. */
export const NAMED_PARAM_REGEX = /^[a-z][a-z0-9_]*$/;

const ANY_PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Raw placeholder tokens (trimmed inner text) in order of appearance. */
function rawPlaceholders(text: string): string[] {
  return [...text.matchAll(ANY_PLACEHOLDER)].map((m) => m[1]);
}

/**
 * Canonical ordering for variable keys. Positional keys sort
 * numerically; named keys alphabetically. Must match the order that
 * `resolveVariables` emits values in, since send-time values travel as
 * a plain `string[]` aligned to this order.
 */
export function compareVariableKeys(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return a.localeCompare(b);
}

/**
 * Sorted, deduplicated variable keys — `["1","2"]` for positional,
 * `["first_name","order_id"]` for named. Malformed tokens (empty,
 * uppercase, spaces) are ignored here; `validateVariableTokens`
 * reports them.
 */
export function extractVariableKeys(text: string): string[] {
  const set = new Set<string>();
  for (const raw of rawPlaceholders(text)) {
    if (/^\d+$/.test(raw)) {
      if (Number(raw) >= 1) set.add(String(Number(raw)));
    } else if (NAMED_PARAM_REGEX.test(raw)) {
      set.add(raw);
    }
  }
  return [...set].sort(compareVariableKeys);
}

/** NAMED when any key is non-numeric; POSITIONAL otherwise. */
export function detectParameterFormat(
  ...texts: Array<string | null | undefined>
): ParameterFormat {
  for (const t of texts) {
    if (!t) continue;
    if (extractVariableKeys(t).some((k) => !/^\d+$/.test(k))) return 'NAMED';
  }
  return 'POSITIONAL';
}

/**
 * Reject placeholders Meta would refuse: malformed names and a mix of
 * positional + named within the same field.
 */
function validateVariableTokens(text: string, where: string): void {
  let sawNumeric = false;
  let sawNamed = false;
  for (const raw of rawPlaceholders(text)) {
    if (/^\d+$/.test(raw)) {
      sawNumeric = true;
      continue;
    }
    if (!NAMED_PARAM_REGEX.test(raw)) {
      const suggestion = raw
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^[^a-z]+/, '')
        .replace(/_+$/, '');
      throw new Error(
        `${where} variable {{${raw}}} is invalid — use lowercase letters, digits and underscores, starting with a letter${
          suggestion ? ` (e.g. {{${suggestion}}})` : ''
        }.`,
      );
    }
    sawNamed = true;
  }
  if (sawNumeric && sawNamed) {
    throw new Error(
      `${where} mixes numbered ({{1}}) and named ({{name}}) variables — use one style.`,
    );
  }
}

/**
 * Meta requires contiguous, 1-indexed variables. `{{1}} {{3}}` is
 * invalid — it must be `{{1}} {{2}}`.
 */
function assertContiguous(indices: number[], where: string): void {
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] !== i + 1) {
      throw new Error(
        `${where} variables must be contiguous starting at {{1}} — found ${indices
          .map((n) => `{{${n}}}`)
          .join(', ')}.`,
      );
    }
  }
}

/**
 * Returns the body's variable keys (canonical order). Positional keys
 * must be contiguous; Meta also rejects bodies that start or end with
 * a variable, so we catch that before the review round-trip.
 */
export function validateBody(bodyText: string): string[] {
  if (!bodyText.trim()) throw new Error('Body text is required.');
  if (bodyText.length > TEMPLATE_LIMITS.bodyMaxLength) {
    throw new Error(
      `Body text exceeds ${TEMPLATE_LIMITS.bodyMaxLength} chars (got ${bodyText.length}).`,
    );
  }
  validateVariableTokens(bodyText, 'Body');
  const keys = extractVariableKeys(bodyText);
  if (detectParameterFormat(bodyText) === 'POSITIONAL') {
    assertContiguous(keys.map(Number), 'Body');
  }
  if (keys.length > 0) {
    const trimmed = bodyText.trim();
    if (/^\{\{[^{}]*\}\}/.test(trimmed) || /\{\{[^{}]*\}\}$/.test(trimmed)) {
      throw new Error(
        'Body cannot start or end with a variable (Meta rule) — add text before/after it.',
      );
    }
  }
  return keys;
}

export function validateFooter(footerText: string | undefined): void {
  if (!footerText) return;
  if (footerText.length > TEMPLATE_LIMITS.footerMaxLength) {
    throw new Error(
      `Footer text exceeds ${TEMPLATE_LIMITS.footerMaxLength} chars (got ${footerText.length}).`,
    );
  }
  if (rawPlaceholders(footerText).length > 0) {
    throw new Error('Footer text cannot contain variables (Meta rule).');
  }
}

export interface HeaderValidationResult {
  /** number of {{N}} placeholders in a TEXT header — 0 or 1. */
  variableCount: number;
}

export function validateHeader(
  payload: Pick<
    TemplatePayload,
    'header_type' | 'header_content' | 'header_media_url' | 'header_handle'
  >,
): HeaderValidationResult {
  const { header_type, header_content, header_media_url, header_handle } = payload;
  if (!header_type) return { variableCount: 0 };

  if (header_type === 'text') {
    if (!header_content || !header_content.trim()) {
      throw new Error('Text header requires header_content.');
    }
    if (header_content.length > TEMPLATE_LIMITS.headerTextMaxLength) {
      throw new Error(
        `Header text exceeds ${TEMPLATE_LIMITS.headerTextMaxLength} chars (got ${header_content.length}).`,
      );
    }
    validateVariableTokens(header_content, 'Header');
    const keys = extractVariableKeys(header_content);
    if (keys.length > 1) {
      throw new Error(
        `Text header supports at most one variable — found ${keys.length} (Meta rule).`,
      );
    }
    if (keys.length === 1 && /^\d+$/.test(keys[0]) && keys[0] !== '1') {
      throw new Error('Text header variable must be {{1}} (Meta rule).');
    }
    return { variableCount: keys.length };
  }

  // image / video / document need either a public URL or a Resumable
  // Upload handle. Either one — Meta accepts both example forms.
  if (!header_media_url && !header_handle) {
    throw new Error(
      `${header_type} header requires either a public sample URL (header_media_url) or a Resumable Upload handle (header_handle).`,
    );
  }
  if (header_media_url) {
    try {
      const u = new URL(header_media_url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        throw new Error('header_media_url must use http(s) scheme.');
      }
    } catch {
      throw new Error('header_media_url must be a valid URL.');
    }
  }
  return { variableCount: 0 };
}

/** Placeholder suffix for a dynamic URL button — Meta's only allowed form. */
export const DYNAMIC_URL_SUFFIX = '{{1}}';

/** True when the URL ends in `{{1}}` (a dynamic URL button). */
export function isDynamicUrl(url: string): boolean {
  return /\{\{\s*1\s*\}\}$/.test(url.trim());
}

function countButtonsByType(
  buttons: TemplateButton[],
): Record<TemplateButton['type'], number> {
  const counts: Record<TemplateButton['type'], number> = {
    QUICK_REPLY: 0,
    URL: 0,
    PHONE_NUMBER: 0,
    COPY_CODE: 0,
    OTP: 0,
  };
  for (const b of buttons) counts[b.type]++;
  return counts;
}

export function validateButtons(buttons: TemplateButton[] | undefined): void {
  if (!buttons || buttons.length === 0) return;
  if (buttons.length > TEMPLATE_LIMITS.maxButtonsTotal) {
    throw new Error(
      `Templates can have at most ${TEMPLATE_LIMITS.maxButtonsTotal} buttons (got ${buttons.length}).`,
    );
  }

  const counts = countButtonsByType(buttons);
  if (counts.OTP > 0) {
    throw new Error('OTP buttons can only be used in Authentication templates.');
  }
  if (counts.URL > TEMPLATE_LIMITS.maxUrlButtons) {
    throw new Error(
      `At most ${TEMPLATE_LIMITS.maxUrlButtons} URL buttons allowed (got ${counts.URL}).`,
    );
  }
  if (counts.PHONE_NUMBER > TEMPLATE_LIMITS.maxPhoneButtons) {
    throw new Error(
      `At most ${TEMPLATE_LIMITS.maxPhoneButtons} PHONE_NUMBER button allowed (got ${counts.PHONE_NUMBER}).`,
    );
  }
  if (counts.COPY_CODE > TEMPLATE_LIMITS.maxCopyCodeButtons) {
    throw new Error(
      `At most ${TEMPLATE_LIMITS.maxCopyCodeButtons} COPY_CODE button allowed (got ${counts.COPY_CODE}).`,
    );
  }

  // Meta rule: QUICK_REPLY buttons must be contiguous — they can't be
  // interleaved with CTA buttons. Easiest check: walk the array; once
  // we leave the QUICK_REPLY block, we must not see another.
  let sawNonQR = false;
  for (const b of buttons) {
    if (b.type === 'QUICK_REPLY') {
      if (sawNonQR) {
        throw new Error(
          'QUICK_REPLY buttons cannot be interleaved with URL / PHONE_NUMBER / COPY_CODE buttons — group them at the start.',
        );
      }
    } else {
      sawNonQR = true;
    }
  }

  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i];
    if (!b.text?.trim()) {
      throw new Error(`Button #${i + 1} (${b.type}) is missing text.`);
    }
    if (b.text.length > TEMPLATE_LIMITS.buttonTextMaxLength) {
      throw new Error(
        `Button #${i + 1} text exceeds ${TEMPLATE_LIMITS.buttonTextMaxLength} chars.`,
      );
    }
    switch (b.type) {
      case 'URL': {
        if (!b.url?.trim()) {
          throw new Error(`URL button #${i + 1} is missing url.`);
        }
        try {
          new URL(b.url);
        } catch {
          throw new Error(`URL button #${i + 1} has an invalid url.`);
        }
        const tokens = rawPlaceholders(b.url);
        if (tokens.length > 1) {
          throw new Error(
            `URL button #${i + 1} can have at most one variable (Meta rule).`,
          );
        }
        if (tokens.length === 1) {
          if (tokens[0] !== '1') {
            throw new Error(
              `URL button #${i + 1}: {{${tokens[0]}}} isn't allowed — URL buttons only support a single {{1}} at the end (use a Dynamic URL).`,
            );
          }
          if (!isDynamicUrl(b.url)) {
            throw new Error(
              `URL button #${i + 1}: {{1}} must be at the very end of the URL (Meta rule).`,
            );
          }
          if (!b.example?.trim()) {
            throw new Error(
              `URL button #${i + 1} uses {{1}} — Meta requires an example value.`,
            );
          }
        }
        break;
      }
      case 'PHONE_NUMBER':
        if (!b.phone_number?.trim()) {
          throw new Error(
            `PHONE_NUMBER button #${i + 1} is missing phone_number.`,
          );
        }
        break;
      case 'COPY_CODE':
        if (!b.example?.trim()) {
          throw new Error(
            `COPY_CODE button #${i + 1} is missing example value.`,
          );
        }
        break;
    }
  }
}

/**
 * Sample values must be supplied 1:1 with the variables in the body
 * (and header, if it has one). Meta uses these for human review.
 */
export function validateSampleValues(
  payload: TemplatePayload,
  bodyVarCount: number,
  headerVarCount: number,
): void {
  const samples = payload.sample_values ?? {};
  const body = samples.body ?? [];
  const header = samples.header ?? [];

  if (body.length !== bodyVarCount) {
    throw new Error(
      `Body has ${bodyVarCount} variable(s) — supply exactly ${bodyVarCount} sample value(s) (got ${body.length}).`,
    );
  }
  if (header.length !== headerVarCount) {
    throw new Error(
      `Header has ${headerVarCount} variable(s) — supply exactly ${headerVarCount} sample value(s) (got ${header.length}).`,
    );
  }
  for (let i = 0; i < body.length; i++) {
    if (!body[i] || !body[i].trim()) {
      throw new Error(`Body sample value #${i + 1} is empty.`);
    }
  }
  for (let i = 0; i < header.length; i++) {
    if (!header[i] || !header[i].trim()) {
      throw new Error(`Header sample value #${i + 1} is empty.`);
    }
  }
}

export const AUTH_LIMITS = {
  minExpiryMinutes: 1,
  maxExpiryMinutes: 90,
  /** Meta caps a delivered one-time code at 15 characters. */
  maxCodeLength: 15,
  /** Android package name, e.g. com.example.app */
  packageNameRegex: /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/,
  /** App signing-key hash: exactly 11 chars (base64 alphabet). */
  signatureHashRegex: /^[A-Za-z0-9+/]{11}$/,
} as const;

/**
 * AUTHENTICATION templates have Meta-fixed wording: no custom header,
 * body text, or extra buttons — only one OTP button plus the optional
 * security note and expiry, which we carry on that button.
 */
export function validateAuthTemplate(payload: TemplatePayload): void {
  if (payload.header_type) {
    throw new Error('Authentication templates cannot have a header.');
  }
  const buttons = payload.buttons ?? [];
  const otp = buttons[0];
  if (buttons.length !== 1 || !otp || otp.type !== 'OTP') {
    throw new Error('Authentication templates need exactly one OTP button.');
  }
  if (otp.otp_type !== 'COPY_CODE' && otp.otp_type !== 'ONE_TAP') {
    throw new Error('OTP button must be Copy code or One-tap autofill.');
  }
  if (!otp.text?.trim()) {
    throw new Error('OTP button text is required.');
  }
  if (otp.text.length > TEMPLATE_LIMITS.buttonTextMaxLength) {
    throw new Error(
      `OTP button text exceeds ${TEMPLATE_LIMITS.buttonTextMaxLength} chars.`,
    );
  }
  if (otp.otp_type === 'ONE_TAP') {
    if (!otp.autofill_text?.trim()) {
      throw new Error('One-tap autofill button text is required.');
    }
    if (otp.autofill_text.length > TEMPLATE_LIMITS.buttonTextMaxLength) {
      throw new Error(
        `Autofill button text exceeds ${TEMPLATE_LIMITS.buttonTextMaxLength} chars.`,
      );
    }
    const apps = otp.supported_apps ?? [];
    if (apps.length === 0) {
      throw new Error('One-tap autofill needs your Android app package name and signature hash.');
    }
    if (apps.length > 5) {
      throw new Error('One-tap autofill supports at most 5 apps.');
    }
    apps.forEach((app, i) => {
      if (!AUTH_LIMITS.packageNameRegex.test(app.package_name?.trim() ?? '')) {
        throw new Error(
          `App #${i + 1}: package name must look like com.example.app.`,
        );
      }
      if (!AUTH_LIMITS.signatureHashRegex.test(app.signature_hash?.trim() ?? '')) {
        throw new Error(
          `App #${i + 1}: signature hash must be exactly 11 characters.`,
        );
      }
    });
  }
  const mins = otp.code_expiration_minutes;
  if (
    mins !== undefined &&
    (!Number.isInteger(mins) ||
      mins < AUTH_LIMITS.minExpiryMinutes ||
      mins > AUTH_LIMITS.maxExpiryMinutes)
  ) {
    throw new Error(
      `Code expiry must be a whole number of minutes between ${AUTH_LIMITS.minExpiryMinutes} and ${AUTH_LIMITS.maxExpiryMinutes}.`,
    );
  }
}

/** The OTP button of an authentication template, if any. */
export function getOtpButton(
  buttons: TemplateButton[] | null | undefined,
): Extract<TemplateButton, { type: 'OTP' }> | null {
  const b = buttons?.find((x) => x.type === 'OTP');
  return b && b.type === 'OTP' ? b : null;
}

/**
 * Local copy of Meta's fixed English wording, so previews and the
 * inbox show something sensible before a sync pulls Meta's localized
 * text.
 */
export function authBodyText(addSecurityRecommendation: boolean): string {
  return addSecurityRecommendation
    ? '*{{1}}* is your verification code. For your security, do not share this code.'
    : '*{{1}}* is your verification code.';
}

export function authFooterText(minutes: number | undefined): string | undefined {
  return minutes ? `This code expires in ${minutes} minutes.` : undefined;
}

/**
 * Server-side: overwrite an authentication payload's text fields with
 * Meta's fixed wording, so the stored row never drifts from what Meta
 * actually sends no matter what the client posted.
 */
export function normalizeAuthPayload(payload: TemplatePayload): TemplatePayload {
  if (payload.category !== 'Authentication') return payload;
  const otp = getOtpButton(payload.buttons);
  return {
    ...payload,
    header_type: undefined,
    header_content: undefined,
    header_media_url: undefined,
    header_handle: undefined,
    body_text: authBodyText(!!otp?.add_security_recommendation),
    footer_text: authFooterText(otp?.code_expiration_minutes),
    sample_values: undefined,
  };
}

/**
 * Run every validator. Throws on the first failure with a specific,
 * field-level message. Returns the variable counts so callers can
 * reuse them when building the Meta components payload.
 */
export function validateTemplatePayload(payload: TemplatePayload): {
  bodyVarCount: number;
  headerVarCount: number;
} {
  validateTemplateName(payload.name);
  if (!payload.language?.trim()) {
    throw new Error('Language is required.');
  }
  if (payload.category === 'Authentication') {
    validateAuthTemplate(payload);
    // Meta's fixed body always has exactly one variable: the code.
    return { bodyVarCount: 1, headerVarCount: 0 };
  }
  const bodyVars = validateBody(payload.body_text);
  validateFooter(payload.footer_text);
  const headerResult = validateHeader(payload);
  if (payload.header_type === 'text' && payload.header_content) {
    const headerFormat = extractVariableKeys(payload.header_content).length
      ? detectParameterFormat(payload.header_content)
      : null;
    const bodyFormat = bodyVars.length ? detectParameterFormat(payload.body_text) : null;
    if (headerFormat && bodyFormat && headerFormat !== bodyFormat) {
      throw new Error(
        'Header and body must use the same variable style — all numbered ({{1}}) or all named ({{name}}).',
      );
    }
  }
  validateButtons(payload.buttons);
  validateSampleValues(payload, bodyVars.length, headerResult.variableCount);
  return {
    bodyVarCount: bodyVars.length,
    headerVarCount: headerResult.variableCount,
  };
}
