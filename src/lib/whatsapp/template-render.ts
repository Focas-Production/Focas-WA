/**
 * Fill a template body's {{1}}, {{2}}… placeholders with positional
 * values — the text the recipient actually sees. Used for the inbox
 * copy of a sent template (composer and campaigns alike). A missing
 * value leaves its placeholder visible rather than an empty gap.
 */
export function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    return params[idx] ?? `{{${raw}}}`;
  });
}
