/**
 * Normalize the caller-supplied template values into the
 * `SendTimeParams` shape that `buildSendComponents` consumes.
 *
 * Accepted input shapes (all validated, all strict):
 *
 *   1. Positional array — values for body {{1}}, {{2}}, … (named
 *      templates: aligned to the alphabetical key order).
 *        ["Ravi", "ORD-42"]
 *
 *   2. Named map — keyed by the template's variable names. Fills body
 *      variables and a TEXT-header variable. Order does not matter.
 *        { "name": "Ravi", "calendar_link": "https://…" }
 *      Positional templates can be addressed the same way: { "1": "Ravi" }.
 *
 *   3. Structured — explicit header/body/button values. `body` may be
 *      an array (positional) or a named map.
 *        { "body": { "name": "Ravi" }, "headerMediaUrl": "https://…",
 *          "buttonParams": { "0": "ORD-42" } }
 *
 * The structured keys (`headerText`, `headerMediaUrl`, `headerMediaId`,
 * `buttonParams`) are camelCase, which Meta never allows in a variable
 * name, so they may also ride alongside a flat named map. `body` is
 * structured only when its value is an array or object — a string
 * `body` is a variable called "body".
 *
 * Unknown or missing variable names throw `TemplateParamsError` with
 * the expected names listed, so a typo fails as a 400 before the
 * wallet is charged instead of as an opaque Meta rejection.
 */

import type { MessageTemplate } from '@/types';
import type { SendTimeParams } from './template-send-builder';
import { extractVariableKeys } from './template-validators';

export class TemplateParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateParamsError';
  }
}

const CAMEL_KEYS = [
  'headerText',
  'headerMediaUrl',
  'headerMediaId',
  'buttonParams',
] as const;

type ParamMap = Record<string, unknown>;

function isPlainObject(v: unknown): v is ParamMap {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Coerce a single value to the text Meta receives. */
function toText(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new TemplateParamsError(
    `${label} must be a string or number, got ${value === null ? 'null' : typeof value}.`
  );
}

function requireNonEmpty(text: string, label: string): string {
  if (!text.trim()) {
    throw new TemplateParamsError(`${label} must not be empty.`);
  }
  return text;
}

function toOptionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return toText(value, label);
}

function parsePositional(values: unknown[], label: string): string[] {
  return values.map((v, i) => toText(v, `${label}[${i}]`));
}

function parseButtonParams(
  value: unknown
): Record<number, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value) && !Array.isArray(value)) {
    throw new TemplateParamsError(
      'buttonParams must be an object keyed by button index, e.g. { "0": "ORD-42" }.'
    );
  }
  const out: Record<number, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue;
    if (!/^\d+$/.test(key)) {
      throw new TemplateParamsError(
        `buttonParams key "${key}" must be a button index (0, 1, …).`
      );
    }
    out[Number(key)] = toText(v, `buttonParams["${key}"]`);
  }
  return out;
}

function templateKeys(template: MessageTemplate) {
  const bodyKeys = extractVariableKeys(template.body_text ?? '');
  const headerKeys =
    template.header_type === 'text'
      ? extractVariableKeys(template.header_content ?? '')
      : [];
  return { bodyKeys, headerKeys };
}

function describeKeys(keys: string[]): string {
  return keys.length ? keys.map((k) => `"${k}"`).join(', ') : '(none)';
}

/**
 * Map named values onto the template's body + header keys. Every
 * template variable must be supplied; every supplied name must exist.
 */
function resolveNamed(
  template: MessageTemplate | null,
  named: ParamMap,
  { includeHeader }: { includeHeader: boolean }
): { body: string[]; headerText?: string } {
  if (!template) {
    throw new TemplateParamsError(
      'Named template params need the template definition, but this template is not synced locally. ' +
        'Run "Sync from Meta" in Settings → Templates, or pass params as an array.'
    );
  }
  const { bodyKeys, headerKeys } = templateKeys(template);
  const allowed = new Set([...bodyKeys, ...(includeHeader ? headerKeys : [])]);

  const unknown = Object.keys(named).filter((k) => !allowed.has(k));
  if (unknown.length) {
    throw new TemplateParamsError(
      `Unknown template variable(s) ${describeKeys(unknown)} for "${template.name}". ` +
        `Expected: ${describeKeys([...allowed])}.`
    );
  }
  const missing = [...allowed].filter(
    (k) => named[k] === undefined || named[k] === null
  );
  if (missing.length) {
    throw new TemplateParamsError(
      `Missing value(s) for template variable(s) ${describeKeys(missing)} in "${template.name}".`
    );
  }

  const valueOf = (k: string) =>
    requireNonEmpty(toText(named[k], `Variable "${k}"`), `Variable "${k}"`);
  return {
    body: bodyKeys.map(valueOf),
    headerText:
      includeHeader && headerKeys.length ? valueOf(headerKeys[0]) : undefined,
  };
}

/**
 * Resolve caller input into `SendTimeParams`.
 *
 * @param template   Local template row, or null if it isn't synced.
 * @param structured The raw `params` value from the request (array,
 *                   named map or structured object). Takes precedence.
 * @param positional Legacy positional body values (internal callers).
 */
export function resolveTemplateSendParams(
  template: MessageTemplate | null,
  structured: unknown,
  positional?: string[] | null
): SendTimeParams {
  const out = resolveShape(template, structured, positional);

  // Meta rejects empty text parameters; catch it here with the variable
  // name. Values past the variable count are dropped by the builder.
  if (template && out.body) {
    const { bodyKeys } = templateKeys(template);
    out.body.slice(0, bodyKeys.length).forEach((v, i) =>
      requireNonEmpty(v, `Value for body variable {{${bodyKeys[i]}}}`)
    );
  }
  return out;
}

function resolveShape(
  template: MessageTemplate | null,
  structured: unknown,
  positional?: string[] | null
): SendTimeParams {
  if (structured === undefined || structured === null) {
    return positional?.length
      ? { body: parsePositional(positional, 'params') }
      : {};
  }

  if (Array.isArray(structured)) {
    return { body: parsePositional(structured, 'params') };
  }

  if (!isPlainObject(structured)) {
    throw new TemplateParamsError(
      'Template params must be an array of values or an object keyed by variable name.'
    );
  }

  const out: SendTimeParams = {};
  const headerText = toOptionalText(structured.headerText, 'headerText');
  const headerMediaUrl = toOptionalText(structured.headerMediaUrl, 'headerMediaUrl');
  const headerMediaId = toOptionalText(structured.headerMediaId, 'headerMediaId');
  const buttonParams = parseButtonParams(structured.buttonParams);
  if (headerMediaUrl !== undefined) out.headerMediaUrl = headerMediaUrl;
  if (headerMediaId !== undefined) out.headerMediaId = headerMediaId;
  if (buttonParams !== undefined) out.buttonParams = buttonParams;

  const rawBody = structured.body;
  const structuredBody = Array.isArray(rawBody) || isPlainObject(rawBody);

  // Everything that isn't a structured key is a named variable.
  const named: ParamMap = {};
  for (const [key, value] of Object.entries(structured)) {
    if ((CAMEL_KEYS as readonly string[]).includes(key)) continue;
    if (key === 'body' && structuredBody) continue;
    named[key] = value;
  }
  const hasNamed = Object.keys(named).length > 0;

  if (structuredBody && hasNamed) {
    throw new TemplateParamsError(
      `Pass template variables either at the top level or under "body", not both ` +
        `(found ${describeKeys(Object.keys(named))} next to "body").`
    );
  }

  if (Array.isArray(rawBody)) {
    out.body = parsePositional(rawBody, 'body');
    if (headerText !== undefined) out.headerText = headerText;
  } else if (isPlainObject(rawBody)) {
    // `body` map fills body variables only; a header var comes from
    // headerText.
    out.body = resolveNamed(template, rawBody, { includeHeader: false }).body;
    if (headerText !== undefined) out.headerText = headerText;
  } else if (hasNamed) {
    // Flat map fills body + header variables by name.
    const headerKeys = template ? templateKeys(template).headerKeys : [];
    if (headerText !== undefined && headerKeys.some((k) => k in named)) {
      throw new TemplateParamsError(
        `Header variable "${headerKeys[0]}" was given both by name and as headerText — pass it once.`
      );
    }
    const resolved = resolveNamed(template, named, {
      includeHeader: headerText === undefined,
    });
    out.body = resolved.body;
    out.headerText = headerText ?? resolved.headerText;
  } else {
    // Only structured keys (or nothing) — fall back to legacy positional.
    if (positional?.length) out.body = parsePositional(positional, 'params');
    if (headerText !== undefined) out.headerText = headerText;
  }

  if (out.headerText === undefined) delete out.headerText;
  return out;
}
