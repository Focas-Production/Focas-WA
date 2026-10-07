'use client';

import { useMemo, type ReactNode } from 'react';
import {
  CheckCheck,
  Copy,
  ExternalLink,
  FileText,
  ImageIcon,
  List,
  Phone,
  Play,
  Reply,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { TemplateButton } from '@/types';
import { extractVariableKeys } from '@/lib/whatsapp/template-validators';

export interface TemplatePreviewData {
  header_format: 'none' | 'text' | 'image' | 'video' | 'document';
  header_content: string;
  header_media_url: string;
  /** Sample for the header's single variable, if any. */
  header_sample: string;
  body_text: string;
  /** Body samples keyed by variable key ("1" or "first_name"). */
  body_samples: Record<string, string>;
  footer_text: string;
  buttons: TemplateButton[];
}

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Swap filled samples into the text; unfilled placeholders stay as-is. */
function applySamples(text: string, samples: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (match, raw: string) => {
    const key = /^\d+$/.test(raw) ? String(Number(raw)) : raw;
    const value = samples[key]?.trim();
    return value ? value : match;
  });
}

/** Leaf text: highlight any placeholder that still has no sample. */
function renderLeaf(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    out.push(
      <span
        key={`${keyPrefix}-v${start}`}
        className="rounded bg-emerald-500/15 px-0.5 font-medium text-emerald-700 dark:text-emerald-300"
      >
        {m[0]}
      </span>,
    );
    last = start + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// WhatsApp inline formatting: ```mono```, *bold*, _italic_, ~strike~.
// Markers must hug non-space characters, as WhatsApp requires.
const FORMAT = /```([\s\S]+?)```|\*(\S(?:[^*\n]*\S)?)\*|_(\S(?:[^_\n]*\S)?)_|~(\S(?:[^~\n]*\S)?)~/;

/**
 * Parse WhatsApp markup into React nodes. Built from nodes (never
 * innerHTML) so user-typed content can't inject markup.
 */
export function renderWhatsAppText(text: string, keyPrefix = 'f'): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let i = 0;
  while (rest) {
    const m = FORMAT.exec(rest);
    if (!m) {
      out.push(...renderLeaf(rest, `${keyPrefix}-${i}`));
      break;
    }
    if (m.index > 0) out.push(...renderLeaf(rest.slice(0, m.index), `${keyPrefix}-${i}`));
    const k = `${keyPrefix}-${i}-m`;
    if (m[1] !== undefined) {
      out.push(
        <code key={k} className="font-mono text-[0.92em]">
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined) {
      out.push(<strong key={k}>{renderWhatsAppText(m[2], k)}</strong>);
    } else if (m[3] !== undefined) {
      out.push(<em key={k}>{renderWhatsAppText(m[3], k)}</em>);
    } else if (m[4] !== undefined) {
      out.push(<s key={k}>{renderWhatsAppText(m[4], k)}</s>);
    }
    rest = rest.slice(m.index + m[0].length);
    i++;
  }
  return out;
}

/** One-tap OTP buttons show their autofill label on Android. */
function buttonLabel(b: TemplateButton): string {
  return b.type === 'OTP' && b.otp_type === 'ONE_TAP' ? b.autofill_text ?? b.text : b.text;
}

function ButtonIcon({ type }: { type: TemplateButton['type'] }) {
  const cls = 'size-3.5 shrink-0';
  switch (type) {
    case 'URL':
      return <ExternalLink className={cls} />;
    case 'PHONE_NUMBER':
      return <Phone className={cls} />;
    case 'COPY_CODE':
    case 'OTP':
      return <Copy className={cls} />;
    case 'QUICK_REPLY':
      return <Reply className={cls} />;
  }
}

function MediaHeader({
  format,
  url,
}: {
  format: 'image' | 'video' | 'document';
  url: string;
}) {
  if (format === 'image' && url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        className="mb-1 aspect-[1.91/1] w-full rounded-md object-cover"
      />
    );
  }
  const Icon = format === 'image' ? ImageIcon : format === 'video' ? Play : FileText;
  return (
    <div className="mb-1 flex aspect-[1.91/1] w-full items-center justify-center rounded-md bg-black/10 text-black/40 dark:bg-white/10 dark:text-white/40">
      <Icon className="size-10" />
    </div>
  );
}

/**
 * WhatsApp-style chat bubble for a template that's being authored (or
 * an existing one). Purely presentational — callers own the data.
 */
export function TemplatePreview({ data }: { data: TemplatePreviewData }) {
  const t = useTranslations('Settings.templates');

  const time = useMemo(
    () =>
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    [],
  );

  const headerSamples = useMemo(() => {
    const key = extractVariableKeys(data.header_content)[0];
    return key ? { [key]: data.header_sample } : {};
  }, [data.header_content, data.header_sample]);

  const headerText =
    data.header_format === 'text' && data.header_content.trim()
      ? applySamples(data.header_content, headerSamples)
      : '';
  const body = applySamples(data.body_text, data.body_samples);
  const footer = data.footer_text.trim();
  const buttons = data.buttons.filter((b) => buttonLabel(b).trim());
  // WhatsApp shows up to 3 buttons inline, collapsing the rest behind
  // "See all options".
  const visibleButtons = buttons.length > 3 ? buttons.slice(0, 2) : buttons;

  return (
    <div className="overflow-hidden rounded-2xl border border-border shadow-sm">
      <div className="flex items-center gap-2 bg-[#008069] px-3 py-2 text-white dark:bg-[#202c33]">
        <div className="flex size-7 items-center justify-center rounded-full bg-white/20 text-xs font-semibold">
          W
        </div>
        <p className="text-sm font-medium">{t('previewTitle')}</p>
      </div>

      <div className="min-h-64 bg-[#efeae2] p-3 dark:bg-[#0b141a]">
        <div className="max-w-[92%]">
          <div className="rounded-lg rounded-tl-none bg-white p-1.5 text-[13.5px] leading-snug text-[#111b21] shadow-sm dark:bg-[#202c33] dark:text-[#e9edef]">
            {data.header_format !== 'none' && data.header_format !== 'text' && (
              <MediaHeader format={data.header_format} url={data.header_media_url} />
            )}
            <div className="px-1.5 pt-0.5">
              {headerText && (
                <p className="mb-1 font-bold break-words">{renderLeaf(headerText, 'h')}</p>
              )}
              {body.trim() ? (
                <p className="whitespace-pre-wrap break-words">
                  {renderWhatsAppText(body, 'b')}
                </p>
              ) : (
                <p className="italic text-black/40 dark:text-white/40">
                  {t('previewEmptyBody')}
                </p>
              )}
              {footer && (
                <p className="mt-1 text-[12px] text-[#667781] dark:text-[#8696a0] break-words">
                  {footer}
                </p>
              )}
              <div className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-[#667781] dark:text-[#8696a0]">
                {time}
                <CheckCheck className="size-3.5 text-[#53bdeb]" />
              </div>
            </div>
          </div>

          {buttons.length > 0 && (
            <div className="mt-0.5 space-y-0.5">
              {visibleButtons.map((b, i) => (
                <div
                  key={i}
                  className="flex items-center justify-center gap-1.5 rounded-lg bg-white px-2 py-2 text-[13px] font-medium text-[#027eb5] shadow-sm dark:bg-[#202c33] dark:text-[#53bdeb]"
                >
                  <ButtonIcon type={b.type} />
                  <span className="truncate">{buttonLabel(b)}</span>
                </div>
              ))}
              {buttons.length > 3 && (
                <div className="flex items-center justify-center gap-1.5 rounded-lg bg-white px-2 py-2 text-[13px] font-medium text-[#027eb5] shadow-sm dark:bg-[#202c33] dark:text-[#53bdeb]">
                  <List className="size-3.5" />
                  {t('seeAllOptions')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
