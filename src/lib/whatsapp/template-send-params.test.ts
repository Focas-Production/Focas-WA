import { describe, expect, it } from 'vitest';
import type { MessageTemplate } from '@/types';
import { buildSendComponents } from './template-send-builder';
import {
  resolveTemplateSendParams,
  TemplateParamsError,
} from './template-send-params';

function row(overrides: Partial<MessageTemplate> = {}): MessageTemplate {
  return {
    id: 'row-1',
    user_id: 'user-1',
    name: 'live_class_removed',
    category: 'Utility',
    language: 'en_US',
    body_text:
      'Hi {{name}}, you were removed from a class. Calendar: {{calendar_link}}',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const LINK = 'https://app.focasedu.com/student/live-classes?view=calendar';

describe('resolveTemplateSendParams — named map', () => {
  it('maps values by variable name regardless of key order', () => {
    const params = resolveTemplateSendParams(row(), {
      name: 'Ravi',
      calendar_link: LINK,
    });
    // Canonical (alphabetical) order, as buildSendComponents expects.
    expect(params).toEqual({ body: [LINK, 'Ravi'] });
    expect(buildSendComponents(row(), params)).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: LINK, parameter_name: 'calendar_link' },
          { type: 'text', text: 'Ravi', parameter_name: 'name' },
        ],
      },
    ]);
  });

  it('coerces numbers to text', () => {
    const t = row({ body_text: 'Order {{order_id}} total {{amount}}' });
    expect(
      resolveTemplateSendParams(t, { order_id: 1042, amount: 1499.5 })
    ).toEqual({ body: ['1499.5', '1042'] });
  });

  it('fills a TEXT-header variable from the same map', () => {
    const t = row({
      header_type: 'text',
      header_content: 'Update for {{name}}',
      body_text: 'Hi {{name}}, see {{calendar_link}}',
    });
    expect(
      resolveTemplateSendParams(t, { name: 'Ravi', calendar_link: LINK })
    ).toEqual({ body: [LINK, 'Ravi'], headerText: 'Ravi' });
  });

  it('accepts numeric keys for positional templates', () => {
    const t = row({ body_text: 'Hi {{1}}, order {{2}}' });
    expect(resolveTemplateSendParams(t, { '2': 'ORD-1', '1': 'Ravi' })).toEqual(
      { body: ['Ravi', 'ORD-1'] }
    );
  });

  it('rejects unknown names and lists the expected ones', () => {
    expect(() =>
      resolveTemplateSendParams(row(), { name: 'Ravi', calender_link: LINK })
    ).toThrow(
      /Unknown template variable\(s\) "calender_link".*Expected: "calendar_link", "name"/
    );
  });

  it('rejects missing names', () => {
    expect(() => resolveTemplateSendParams(row(), { name: 'Ravi' })).toThrow(
      /Missing value\(s\) for template variable\(s\) "calendar_link"/
    );
  });

  it('rejects empty and non-scalar values', () => {
    expect(() =>
      resolveTemplateSendParams(row(), { name: '  ', calendar_link: LINK })
    ).toThrow(/Variable "name" must not be empty/);
    expect(() =>
      resolveTemplateSendParams(row(), { name: { x: 1 }, calendar_link: LINK })
    ).toThrow(/must be a string or number/);
    expect(() =>
      resolveTemplateSendParams(row(), { name: true, calendar_link: LINK })
    ).toThrow(TemplateParamsError);
  });

  it('needs the template row to resolve names', () => {
    expect(() => resolveTemplateSendParams(null, { name: 'Ravi' })).toThrow(
      /not synced locally/
    );
  });

  it('allows structured camelCase keys next to named variables', () => {
    const t = row({
      header_type: 'image',
      buttons: [{ type: 'URL', text: 'Open', url: 'https://x.com/{{1}}' }],
    });
    expect(
      resolveTemplateSendParams(t, {
        name: 'Ravi',
        calendar_link: LINK,
        headerMediaUrl: 'https://cdn/x.png',
        buttonParams: { '0': 'abc' },
      })
    ).toEqual({
      body: [LINK, 'Ravi'],
      headerMediaUrl: 'https://cdn/x.png',
      buttonParams: { 0: 'abc' },
    });
  });

  it('treats a string "body" as a variable called body', () => {
    const t = row({ body_text: 'Note: {{body}}' });
    expect(resolveTemplateSendParams(t, { body: 'hello' })).toEqual({
      body: ['hello'],
    });
  });

  it('rejects a header var given both by name and as headerText', () => {
    const t = row({
      header_type: 'text',
      header_content: 'For {{name}}',
    });
    expect(() =>
      resolveTemplateSendParams(t, {
        name: 'Ravi',
        calendar_link: LINK,
        headerText: 'Ravi',
      })
    ).toThrow(/both by name and as headerText/);
  });
});

describe('resolveTemplateSendParams — structured', () => {
  it('passes a positional body array through', () => {
    expect(
      resolveTemplateSendParams(row(), {
        body: [LINK, 'Ravi'],
        headerText: 'Hi',
      })
    ).toEqual({ body: [LINK, 'Ravi'], headerText: 'Hi' });
  });

  it('resolves a named body map', () => {
    expect(
      resolveTemplateSendParams(row(), {
        body: { name: 'Ravi', calendar_link: LINK },
      })
    ).toEqual({ body: [LINK, 'Ravi'] });
  });

  it('rejects variables both at top level and under body', () => {
    expect(() =>
      resolveTemplateSendParams(row(), {
        body: { name: 'Ravi' },
        calendar_link: LINK,
      })
    ).toThrow(/either at the top level or under "body"/);
  });

  it('validates buttonParams keys', () => {
    expect(() =>
      resolveTemplateSendParams(row(), {
        body: [LINK, 'Ravi'],
        buttonParams: { first: 'x' },
      })
    ).toThrow(/must be a button index/);
  });

  it('falls back to legacy positional values when body is absent', () => {
    expect(
      resolveTemplateSendParams(row(), { buttonParams: { 0: 'x' } }, [
        LINK,
        'Ravi',
      ])
    ).toEqual({ body: [LINK, 'Ravi'], buttonParams: { 0: 'x' } });
  });
});

describe('resolveTemplateSendParams — positional', () => {
  it('accepts an array and coerces numbers', () => {
    const t = row({ body_text: 'Hi {{1}}, total {{2}}' });
    expect(resolveTemplateSendParams(t, ['Ravi', 1499])).toEqual({
      body: ['Ravi', '1499'],
    });
  });

  it('rejects non-scalar array entries instead of silently dropping them', () => {
    expect(() => resolveTemplateSendParams(row(), ['Ravi', null])).toThrow(
      /params\[1\] must be a string or number/
    );
  });

  it('rejects empty values for template variables', () => {
    const t = row({ body_text: 'Hi {{1}}' });
    expect(() => resolveTemplateSendParams(t, [''])).toThrow(
      /body variable \{\{1\}\} must not be empty/
    );
  });

  it('works without a template row (unsynced template)', () => {
    expect(resolveTemplateSendParams(null, ['a', 'b'])).toEqual({
      body: ['a', 'b'],
    });
    expect(resolveTemplateSendParams(null, undefined, ['a'])).toEqual({
      body: ['a'],
    });
    expect(resolveTemplateSendParams(null, undefined)).toEqual({});
  });

  it('rejects a scalar params value', () => {
    expect(() => resolveTemplateSendParams(row(), 'Ravi')).toThrow(
      /must be an array of values or an object/
    );
  });
});
