'use client';

import { useState } from 'react';
import { MessageTemplate } from '@/types';
import type { AudienceConfig } from '@/lib/whatsapp/broadcast-launch';
import type { VariableMapping } from '@/lib/whatsapp/variable-resolution';

export type {
  AudienceConfig,
  CustomFieldFilter,
  CustomFieldOperator,
} from '@/lib/whatsapp/broadcast-launch';
export type { VariableMapping } from '@/lib/whatsapp/variable-resolution';

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
   * time for media-header templates — Meta rejects the send without
   * it; the builder falls back to the template's stored URL only when
   * this is empty.
   */
  headerMediaUrl?: string;
  /** ISO timestamp to send at; omitted = send now. */
  scheduledAt?: string;
  /** Draft broadcast row this send resumes — deleted on success. */
  draftId?: string;
}

export interface LaunchedBroadcast {
  broadcastId: string;
  totalRecipients: number;
  /**
   * Set when the audience is larger than the WhatsApp number's
   * 24-hour unique-user messaging limit — sends past it will fail.
   */
  messagingLimit?: number;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<LaunchedBroadcast>;
  isProcessing: boolean;
  progress: number;
}

/**
 * Launches a campaign with ONE request to /api/broadcasts/launch. The
 * server resolves the audience, writes recipients, charges the wallet
 * and sends through its campaign engine — the browser only waits for
 * the campaign to be created, never for the sending, so closing the
 * tab doesn't stop anything. Live progress is on the detail page.
 */
export function useBroadcastSending(): UseBroadcastSendingReturn {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function createAndSendBroadcast(
    payload: BroadcastPayload,
  ): Promise<LaunchedBroadcast> {
    setIsProcessing(true);
    setProgress(30);
    try {
      const res = await fetch('/api/broadcasts/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          audience: payload.audience,
          variables: payload.variables,
          header_media_url: payload.headerMediaUrl?.trim() || null,
          scheduled_at: payload.scheduledAt ?? null,
          draft_id: payload.draftId ?? null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? 'Failed to launch the broadcast.');
      }
      setProgress(100);
      return {
        broadcastId: data.broadcast_id,
        totalRecipients: data.total_recipients,
        messagingLimit: data.messaging_limit,
      };
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
