import {
  Briefcase,
  CircleSlash,
  Clock,
  FileText,
  GitBranch,
  Hourglass,
  List,
  MessageSquare,
  MessageSquarePlus,
  MousePointerClick,
  PencilLine,
  Sparkles,
  Tag,
  TagIcon,
  TextSearch,
  UserCheck,
  UserPlus,
  Webhook,
  type LucideIcon,
} from 'lucide-react'

import type { AutomationStepType, AutomationTriggerType } from '@/types'

// One source of truth for how triggers and steps look in the builder and
// the automations list: icon + tinted icon box. Labels and hints live in
// messages/*.json (Automations.builder.steps / stepHints / triggers).

export type StepGroup = 'messages' | 'contact' | 'conversation' | 'flow' | 'advanced'

export interface StepMeta {
  icon: LucideIcon
  group: StepGroup
}

export const STEP_META: Record<AutomationStepType, StepMeta> = {
  send_message: { icon: MessageSquare, group: 'messages' },
  send_buttons: { icon: MousePointerClick, group: 'messages' },
  send_list: { icon: List, group: 'messages' },
  send_template: { icon: FileText, group: 'messages' },
  add_tag: { icon: Tag, group: 'contact' },
  remove_tag: { icon: TagIcon, group: 'contact' },
  update_contact_field: { icon: PencilLine, group: 'contact' },
  create_deal: { icon: Briefcase, group: 'contact' },
  assign_conversation: { icon: UserCheck, group: 'conversation' },
  close_conversation: { icon: CircleSlash, group: 'conversation' },
  wait: { icon: Hourglass, group: 'flow' },
  condition: { icon: GitBranch, group: 'flow' },
  send_webhook: { icon: Webhook, group: 'advanced' },
}

/** Order of groups (and steps within them) in the "add action" picker. */
export const STEP_GROUPS: { key: StepGroup; steps: AutomationStepType[] }[] = [
  { key: 'messages', steps: ['send_message', 'send_template', 'send_buttons', 'send_list'] },
  { key: 'contact', steps: ['add_tag', 'remove_tag', 'update_contact_field', 'create_deal'] },
  { key: 'conversation', steps: ['assign_conversation', 'close_conversation'] },
  { key: 'flow', steps: ['wait', 'condition'] },
  { key: 'advanced', steps: ['send_webhook'] },
]

/** Tailwind classes for the tinted icon box, per group. */
export const GROUP_ICON_CLASS: Record<StepGroup, string> = {
  messages: 'bg-emerald-500/10 text-emerald-500',
  contact: 'bg-amber-500/10 text-amber-500',
  conversation: 'bg-sky-500/10 text-sky-500',
  flow: 'bg-violet-500/10 text-violet-500',
  advanced: 'bg-slate-500/10 text-slate-500',
}

export function stepIconClass(type: AutomationStepType): string {
  return GROUP_ICON_CLASS[STEP_META[type]?.group ?? 'advanced']
}

/** Display order of triggers in the "When" picker. */
export const TRIGGER_ORDER: AutomationTriggerType[] = [
  'new_message_received',
  'keyword_match',
  'first_inbound_message',
  'interactive_reply',
  'new_contact_created',
  'conversation_assigned',
  'tag_added',
  'time_based',
]

export const TRIGGER_ICON: Record<AutomationTriggerType, LucideIcon> = {
  new_message_received: MessageSquarePlus,
  first_inbound_message: Sparkles,
  keyword_match: TextSearch,
  interactive_reply: MousePointerClick,
  new_contact_created: UserPlus,
  conversation_assigned: UserCheck,
  tag_added: Tag,
  time_based: Clock,
}

export const TRIGGER_ICON_CLASS = 'bg-blue-500/10 text-blue-500'
