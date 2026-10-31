import type { ConversationChannel } from "@/types";
import { cn } from "@/lib/utils";

// Brand glyphs for the three conversation channels. lucide-react v1
// dropped brand icons, so these are small inline SVGs (24×24 viewBox,
// `currentColor`) that size with the usual `h-* w-*` classes.

function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 2a10 10 0 0 0-8.66 15l-1.3 4.76 4.88-1.28A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-2.9.76.78-2.83-.2-.31A8.2 8.2 0 1 1 12 20.2Zm4.5-6.14c-.25-.12-1.46-.72-1.69-.8-.22-.08-.39-.12-.55.13-.16.25-.63.8-.78.96-.14.17-.29.19-.53.06a6.7 6.7 0 0 1-3.3-2.89c-.25-.43.25-.4.71-1.33.08-.16.04-.3-.02-.43-.06-.12-.55-1.33-.76-1.82-.2-.48-.4-.41-.55-.42h-.47a.9.9 0 0 0-.65.3 2.74 2.74 0 0 0-.86 2.04 4.76 4.76 0 0 0 1 2.53 10.9 10.9 0 0 0 4.17 3.68c1.55.67 2.16.73 2.93.61.47-.07 1.46-.6 1.66-1.17.2-.58.2-1.07.15-1.17-.06-.11-.22-.17-.47-.29Z" />
    </svg>
  );
}

function InstagramGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="0.6" fill="currentColor" />
    </svg>
  );
}

function MessengerGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 2C6.36 2 2 6.13 2 11.7c0 2.91 1.19 5.43 3.14 7.17.16.15.26.35.27.57l.05 1.78a.8.8 0 0 0 1.12.71l1.98-.88a.8.8 0 0 1 .54-.04c.91.25 1.87.38 2.9.38 5.64 0 10-4.13 10-9.7S17.64 2 12 2Zm6 7.46-2.94 4.66a1.5 1.5 0 0 1-2.17.4l-2.34-1.75a.6.6 0 0 0-.72 0l-3.16 2.4c-.42.32-.97-.18-.69-.63l2.94-4.66a1.5 1.5 0 0 1 2.17-.4l2.34 1.75a.6.6 0 0 0 .72 0l3.16-2.4c.42-.32.97.18.69.63Z" />
    </svg>
  );
}

export const CHANNEL_LABEL: Record<ConversationChannel, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
};

const BADGE_STYLES: Record<ConversationChannel, string> = {
  whatsapp: "bg-[#25D366] text-white",
  instagram: "bg-gradient-to-tr from-[#F58529] via-[#DD2A7B] to-[#8134AF] text-white",
  messenger: "bg-gradient-to-tr from-[#0866FF] to-[#A033FF] text-white",
};

/** The bare brand glyph for a channel. */
export function ChannelGlyph({
  channel,
  className,
}: {
  channel: ConversationChannel;
  className?: string;
}) {
  if (channel === "instagram") return <InstagramGlyph className={className} />;
  if (channel === "messenger") return <MessengerGlyph className={className} />;
  return <WhatsAppGlyph className={className} />;
}

/**
 * A small round brand-coloured badge — overlaid on avatars in the
 * conversation list and shown next to names in the thread header.
 */
export function ChannelBadge({
  channel,
  className,
}: {
  channel: ConversationChannel;
  className?: string;
}) {
  return (
    <span
      title={CHANNEL_LABEL[channel]}
      className={cn(
        "inline-flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-card",
        BADGE_STYLES[channel],
        className,
      )}
    >
      <ChannelGlyph channel={channel} className="h-2.5 w-2.5" />
      <span className="sr-only">{CHANNEL_LABEL[channel]}</span>
    </span>
  );
}
