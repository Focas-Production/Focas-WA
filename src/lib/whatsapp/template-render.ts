import { extractVariableKeys } from './template-validators';

/**
 * Fill a template body's placeholders — `{{1}}` or `{{name}}` — with
 * values aligned to the canonical key order (see extractVariableKeys):
 * the text the recipient actually sees. Used for the inbox copy of a
 * sent template (composer and campaigns alike). A missing value leaves
 * its placeholder visible rather than an empty gap.
 */
export function renderTemplateBody(body: string, params: ReadonlyArray<string | undefined>): string {
  const keys = extractVariableKeys(body);
  const byKey = new Map(keys.map((k, i) => [k, params[i]]));
  return body.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (match, raw: string) => {
    const key = /^\d+$/.test(raw) ? String(Number(raw)) : raw;
    return byKey.get(key) ?? match;
  });
}
