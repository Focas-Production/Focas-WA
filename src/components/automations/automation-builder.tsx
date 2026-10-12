"use client"

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type {
  AccountMember,
  AutomationStepType,
  AutomationTriggerType,
  CustomField,
  InteractiveMessagePayload,
  KeywordMatchTriggerConfig,
  MessageTemplate,
  Tag as TagRecord,
} from "@/types"
import {
  InteractiveBuilder,
  blankButtonsPayload,
  blankListPayload,
} from "@/components/interactive/interactive-builder"
import { interactivePayloadPreviewText } from "@/lib/whatsapp/interactive"
import { createClient } from "@/lib/supabase/client"
import {
  STEP_GROUPS,
  STEP_META,
  TRIGGER_ICON,
  TRIGGER_ICON_CLASS,
  TRIGGER_ORDER,
  stepIconClass,
} from "@/lib/automations/step-meta"
import { cn } from "@/lib/utils"

// ------------------------------------------------------------
// Types (builder-local — mirror the flattened rows we POST)
// ------------------------------------------------------------

export interface BuilderStep {
  /** Client id; the API assigns real UUIDs server-side. */
  cid: string
  step_type: AutomationStepType
  step_config: Record<string, unknown>
  branches?: { yes: BuilderStep[]; no: BuilderStep[] }
}

export interface BuilderInitial {
  id?: string
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: Record<string, unknown>
  is_active: boolean
  steps: BuilderStep[]
}

/** expandedId sentinel for the "When" (trigger) card. */
const TRIGGER_CARD_ID = "__trigger__"

function cid(): string {
  return (
    "c_" +
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36))
  )
}

// The send_buttons / send_list step_config IS an InteractiveMessagePayload,
// but step_config is typed generically as Record<string, unknown>. These two
// helpers hold the single unavoidable structural cast in one place so a
// payload-shape change has one seam to update instead of four scattered
// `as unknown as` sites.
function toStepConfig(p: InteractiveMessagePayload): Record<string, unknown> {
  return p as unknown as Record<string, unknown>
}
function asInteractive(cfg: Record<string, unknown>): InteractiveMessagePayload {
  return cfg as unknown as InteractiveMessagePayload
}

function blankConfig(type: AutomationStepType): Record<string, unknown> {
  switch (type) {
    case "send_message":
      return { text: "" }
    case "send_buttons":
      return toStepConfig(blankButtonsPayload())
    case "send_list":
      return toStepConfig(blankListPayload())
    case "send_template":
      return { template_name: "", language: "en_US" }
    case "add_tag":
    case "remove_tag":
      return { tag_id: "" }
    case "assign_conversation":
      return { mode: "round_robin" }
    case "update_contact_field":
      return { field: "name", value: "" }
    case "create_deal":
      return { pipeline_id: "", stage_id: "", title: "", value: 0 }
    case "wait":
      return { amount: 1, unit: "hours" }
    case "condition":
      return { subject: "tag_presence", operand: "", value: "" }
    case "send_webhook":
      return { url: "", headers: {}, body_template: "" }
    case "close_conversation":
      return {}
    default:
      return {}
  }
}

// ------------------------------------------------------------
// Account resources (tags, members, approved templates, pipelines)
//
// Loaded once at the builder root and shared via context so the
// tag / agent / template pickers below can offer existing resources
// by name instead of asking the user to paste raw UUIDs. Every picker
// falls back to a raw input when its list is empty (fresh account or
// an older deployment), so an automation is always authorable.
// ------------------------------------------------------------

interface AutomationResources {
  tags: TagRecord[]
  members: AccountMember[]
  templates: MessageTemplate[]
  customFields: CustomField[]
  pipelines: PipelineOption[]
  stages: PipelineStageOption[]
}

interface PipelineOption {
  id: string
  name: string
}

interface PipelineStageOption {
  id: string
  name: string
  pipeline_id: string
  position: number
}

const ResourcesContext = createContext<AutomationResources>({
  tags: [],
  members: [],
  templates: [],
  customFields: [],
  pipelines: [],
  stages: [],
})

function useResources(): AutomationResources {
  return useContext(ResourcesContext)
}

function ResourcesProvider({ children }: { children: ReactNode }) {
  const [tags, setTags] = useState<TagRecord[]>([])
  const [members, setMembers] = useState<AccountMember[]>([])
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [customFields, setCustomFields] = useState<CustomField[]>([])
  const [pipelines, setPipelines] = useState<PipelineOption[]>([])
  const [stages, setStages] = useState<PipelineStageOption[]>([])

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()

    // Tags, templates and custom fields come straight from the DB — RLS
    // scopes them to the caller's account. Only APPROVED templates can
    // actually be sent (anything else 400s at send time), matching the
    // broadcast picker.
    void (async () => {
      const [tagsRes, templatesRes, customFieldsRes, pipelinesRes, stagesRes] =
        await Promise.all([
          supabase.from("tags").select("*").order("name"),
          supabase
            .from("message_templates")
            .select("*")
            .eq("status", "APPROVED")
            .order("name"),
          supabase.from("custom_fields").select("*").order("field_name"),
          supabase.from("pipelines").select("id, name").order("name"),
          supabase
            .from("pipeline_stages")
            .select("id, name, pipeline_id, position")
            .order("position"),
        ])
      if (cancelled) return
      setTags((tagsRes.data as TagRecord[] | null) ?? [])
      setTemplates((templatesRes.data as MessageTemplate[] | null) ?? [])
      setCustomFields((customFieldsRes.data as CustomField[] | null) ?? [])
      setPipelines((pipelinesRes.data as PipelineOption[] | null) ?? [])
      setStages((stagesRes.data as PipelineStageOption[] | null) ?? [])
    })()

    // Members go through the API so we inherit its email-visibility
    // rules (agents/viewers don't see emails). Unreachable on older
    // deployments → pickers fall back to a raw agent-id input.
    void (async () => {
      try {
        const res = await fetch("/api/account/members", { cache: "no-store" })
        if (!res.ok) return
        const json = (await res.json()) as { members?: AccountMember[] }
        if (!cancelled) setMembers(json.members ?? [])
      } catch {
        // Members endpoint absent — caller falls back to raw input.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <ResourcesContext.Provider
      value={{ tags, members, templates, customFields, pipelines, stages }}
    >
      {children}
    </ResourcesContext.Provider>
  )
}

const SELECT_CLASS =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"

/** Tag dropdown by name + color, storing the tag's id. Falls back to a
 *  raw id input when no tags exist yet. */
function TagSelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { tags } = useResources()
  if (tags.length === 0) {
    return (
      <Input
        placeholder={t("tags.placeholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = tags.find((t) => t.id === value)
  return (
    <div className="flex items-center gap-2">
      <span
        className="h-3 w-3 shrink-0 rounded-full border border-border"
        style={{ backgroundColor: selected?.color ?? "transparent" }}
        aria-hidden
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">{t("tags.select")}</option>
        {tags.map((tg) => (
          <option key={tg.id} value={tg.id}>
            {tg.name}
          </option>
        ))}
        {/* Preserve a saved tag that's since been deleted so editing an
            existing automation doesn't silently drop it. */}
        {value && !selected && (
          <option value={value}>{t("tags.unknown", { id: value })}</option>
        )}
      </select>
    </div>
  )
}

/** Contact-field dropdown for "Update Contact Field": built-in columns plus
 *  any account custom fields (stored as `custom:<id>`). A saved custom field
 *  that's since been deleted is preserved as a labelled option so editing an
 *  existing automation doesn't silently drop it. */
function ContactFieldSelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { customFields } = useResources()
  const customValue = value.startsWith("custom:") ? value : ""
  const knownCustom =
    customValue && customFields.some((f) => `custom:${f.id}` === customValue)
  return (
    <select
      value={value || "name"}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="name">{t("fields.name")}</option>
      <option value="email">{t("fields.email")}</option>
      <option value="company">{t("fields.company")}</option>
      {customFields.length > 0 && (
        <optgroup label={t("fields.customFields")}>
          {customFields.map((f) => (
            <option key={f.id} value={`custom:${f.id}`}>
              {f.field_name}
            </option>
          ))}
        </optgroup>
      )}
      {customValue && !knownCustom && (
        <option value={customValue}>{t("fields.unknown", { id: customValue })}</option>
      )}
    </select>
  )
}

/** Agent dropdown by name, storing the member's user_id. Falls back to
 *  a raw id input when the member list is unavailable. */
function AgentSelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { members } = useResources()
  if (members.length === 0) {
    return (
      <Input
        placeholder={t("agents.placeholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = members.find((m) => m.user_id === value)
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="">{t("agents.select")}</option>
      {members.map((m) => (
        <option key={m.user_id} value={m.user_id}>
          {m.full_name || m.email || m.user_id}
        </option>
      ))}
      {value && !selected && (
        <option value={value}>{t("agents.unknown", { id: value })}</option>
      )}
    </select>
  )
}

/** Pipeline + stage picker for Create Deal. The automation stores ids because
 *  the engine writes directly to deals, but authors should choose by name. */
function DealPipelineFields({
  pipelineId,
  stageId,
  onChange,
  t,
}: {
  pipelineId: string
  stageId: string
  onChange: (patch: { pipeline_id: string; stage_id: string }) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { pipelines, stages } = useResources()

  if (pipelines.length === 0) {
    return (
      <>
        <FieldBlock label={t("pipelines.pipelineIdLabel")}>
          <Input
            value={pipelineId}
            onChange={(e) =>
              onChange({ pipeline_id: e.target.value, stage_id: stageId })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <FieldBlock label={t("pipelines.stageIdLabel")}>
          <Input
            value={stageId}
            onChange={(e) =>
              onChange({ pipeline_id: pipelineId, stage_id: e.target.value })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      </>
    )
  }

  const selectedPipeline = pipelines.find((p) => p.id === pipelineId)
  const stageOptions = stages.filter((s) => s.pipeline_id === pipelineId)
  const selectedStage = stageOptions.find((s) => s.id === stageId)

  return (
    <>
      <FieldBlock label={t("pipelines.pipelineLabel")}>
        <select
          value={pipelineId}
          onChange={(e) => {
            const nextPipelineId = e.target.value
            const firstStage = stages.find(
              (s) => s.pipeline_id === nextPipelineId
            )
            onChange({
              pipeline_id: nextPipelineId,
              stage_id: firstStage?.id ?? "",
            })
          }}
          className={SELECT_CLASS}
        >
          <option value="">{t("pipelines.selectPipeline")}</option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {pipelineId && !selectedPipeline && (
            <option value={pipelineId}>{t("pipelines.unknownPipeline", { id: pipelineId })}</option>
          )}
        </select>
      </FieldBlock>
      <FieldBlock label={t("pipelines.stageLabel")}>
        <select
          value={stageId}
          onChange={(e) =>
            onChange({ pipeline_id: pipelineId, stage_id: e.target.value })
          }
          className={SELECT_CLASS}
          disabled={!pipelineId || stageOptions.length === 0}
        >
          <option value="">
            {pipelineId ? t("pipelines.selectStage") : t("pipelines.selectPipelineFirst")}
          </option>
          {stageOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          {stageId && pipelineId && !selectedStage && (
            <option value={stageId}>{t("pipelines.unknownStage", { id: stageId })}</option>
          )}
        </select>
      </FieldBlock>
    </>
  )
}

/** Template dropdown showing approved templates by name + language,
 *  storing both template_name and language. Falls back to manual name +
 *  language inputs when no approved templates are synced yet. */
function SendTemplateFields({
  templateName,
  language,
  onChange,
  t,
}: {
  templateName: string
  language: string
  onChange: (patch: { template_name: string; language: string }) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { templates } = useResources()

  if (templates.length === 0) {
    return (
      <>
        <FieldBlock label={t("templates.templateNameLabel")}>
          <Input
            value={templateName}
            onChange={(e) =>
              onChange({ template_name: e.target.value, language })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <FieldBlock label={t("templates.languageLabel")}>
          <Input
            value={language}
            onChange={(e) =>
              onChange({ template_name: templateName, language: e.target.value })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      </>
    )
  }

  // Encode name + language in the option value so two templates that
  // share a name across languages stay distinct.
  const toValue = (name: string, lang: string) => `${name}::${lang}`
  const current = templateName ? toValue(templateName, language) : ""
  const hasMatch = templates.some(
    (t) => toValue(t.name, t.language ?? "en_US") === current,
  )

  return (
    <FieldBlock label={t("templates.templateLabel")}>
      <select
        value={current}
        onChange={(e) => {
          const [name, lang] = e.target.value.split("::")
          onChange({ template_name: name ?? "", language: lang ?? "" })
        }}
        className={SELECT_CLASS}
      >
        <option value="">{t("templates.select")}</option>
        {templates.map((tmpl) => {
          const lang = tmpl.language ?? "en_US"
          return (
            <option key={tmpl.id} value={toValue(tmpl.name, lang)}>
              {tmpl.name} ({lang})
            </option>
          )
        })}
        {current && !hasMatch && (
          <option value={current}>
            {t("templates.unknown", { name: templateName, lang: language || t("templates.unknownLang") })}
          </option>
        )}
      </select>
    </FieldBlock>
  )
}

// ------------------------------------------------------------
// Main builder component
//
// Layout follows a plain "When → Then" rule reading top to bottom: one
// card for the trigger, one numbered card per action. Collapsed cards
// summarise their settings in words (tag names, message text, …) so the
// whole automation can be read without opening anything; clicking a card
// opens its settings inline. Actions are added from a picker dialog that
// groups them by purpose and explains each one.
// ------------------------------------------------------------

type T = ReturnType<typeof useTranslations>

export function AutomationBuilder({ initial }: { initial: BuilderInitial }) {
  const router = useRouter()
  const t = useTranslations("Automations.builder")
  const isEditing = !!initial.id
  const [state, setState] = useState<BuilderInitial>(initial)
  const [saving, setSaving] = useState(false)
  // A blank new automation opens on the trigger so the first decision
  // ("what starts this?") is right in front of the user.
  const [expandedId, setExpandedId] = useState<string | null>(
    !initial.id && initial.steps.length === 0 ? TRIGGER_CARD_ID : null,
  )
  const [pickerTarget, setPickerTarget] = useState<
    { parent: ParentScope; index: number } | null
  >(null)

  function patchTop<K extends keyof BuilderInitial>(key: K, value: BuilderInitial[K]) {
    setState((s) => ({ ...s, [key]: value }))
  }

  // --- Step tree mutations (immutable) ---

  function updateStep(path: StepPath, updater: (s: BuilderStep) => BuilderStep) {
    setState((s) => ({ ...s, steps: mapAtPath(s.steps, path, updater) }))
  }

  function addStepAt(parent: ParentScope, index: number, type: AutomationStepType) {
    const node: BuilderStep = {
      cid: cid(),
      step_type: type,
      step_config: blankConfig(type),
      branches: type === "condition" ? { yes: [], no: [] } : undefined,
    }
    setState((s) => ({ ...s, steps: insertAt(s.steps, parent, index, node) }))
    setExpandedId(node.cid)
  }

  function deleteStepAt(path: StepPath) {
    setState((s) => ({ ...s, steps: removeAt(s.steps, path) }))
  }

  function moveStepAt(path: StepPath, direction: -1 | 1) {
    setState((s) => ({ ...s, steps: moveAt(s.steps, path, direction) }))
  }

  async function save() {
    setSaving(true)
    try {
      const payload = {
        name: state.name || "Untitled automation",
        description: state.description || null,
        trigger_type: state.trigger_type,
        trigger_config: state.trigger_config,
        is_active: state.is_active,
        steps: toApiSteps(state.steps),
      }

      const res = isEditing
        ? await fetch(`/api/automations/${initial.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/automations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // If the server blocked activation with validation issues,
        // surface the first concrete problem so the user can fix it
        // without opening DevTools for the full array.
        const firstIssue: { path?: string; message?: string } | undefined =
          body?.issues?.[0]
        if (firstIssue?.message) {
          toast.error(firstIssue.message, {
            description: firstIssue.path ? `at ${firstIssue.path}` : undefined,
          })
        } else {
          toast.error(body?.error ?? t("toasts.saveFailed"))
        }
        return
      }
      toast.success(isEditing ? t("toasts.saved") : t("toasts.created"))
      if (!isEditing && body?.automation?.id) {
        router.replace(`/automations/${body.automation.id}/edit`)
      }
    } finally {
      setSaving(false)
    }
  }

  const listProps: Omit<StepListProps, "steps" | "parentPath"> = {
    expandedId,
    setExpandedId,
    updateStep,
    requestAdd: (parent, index) => setPickerTarget({ parent, index }),
    deleteStepAt,
    moveStepAt,
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      {/* Top bar. At sub-sm widths the "Active" label is hidden so the
          name input gets maximum width. */}
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-card/80 px-3 py-3 sm:gap-3 sm:px-4">
        <button
          type="button"
          onClick={() => router.push("/automations")}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("backToAutomations")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={state.name}
          onChange={(e) => patchTop("name", e.target.value)}
          placeholder={t("untitled")}
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:bg-muted focus:outline-none sm:text-base"
        />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn("hidden sm:inline", state.is_active && "font-medium text-primary")}>
            {state.is_active ? t("on") : t("off")}
          </span>
          <Switch
            checked={state.is_active}
            onCheckedChange={(v) => patchTop("is_active", !!v)}
            aria-label={t("activeAria")}
          />
        </div>
        <Button
          onClick={save}
          disabled={saving}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {isEditing ? t("save") : t("saveDraft")}
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto bg-muted/30">
        <div className="mx-auto flex max-w-3xl flex-col px-4 py-8">
          <ResourcesProvider>
            <p className="mb-4 text-center text-xs text-muted-foreground">{t("intro")}</p>
            <TriggerCard
              type={state.trigger_type}
              config={state.trigger_config}
              expanded={expandedId === TRIGGER_CARD_ID}
              onToggle={() =>
                setExpandedId(expandedId === TRIGGER_CARD_ID ? null : TRIGGER_CARD_ID)
              }
              onTypeChange={(tVal) => patchTop("trigger_type", tVal)}
              onConfigChange={(c) => patchTop("trigger_config", c)}
              t={t}
            />
            <StepList steps={state.steps} parentPath={[]} {...listProps} />
          </ResourcesProvider>
        </div>
      </div>

      <ActionPicker
        open={!!pickerTarget}
        onOpenChange={(v) => !v && setPickerTarget(null)}
        onPick={(type) => {
          if (pickerTarget) addStepAt(pickerTarget.parent, pickerTarget.index, type)
          setPickerTarget(null)
        }}
        t={t}
      />
    </div>
  )
}

// ------------------------------------------------------------
// Shared card chrome
// ------------------------------------------------------------

function FlowCard({
  eyebrow,
  icon: Icon,
  iconClass,
  title,
  summary,
  expanded,
  onToggle,
  children,
  t,
}: {
  eyebrow: string
  icon: LucideIcon
  iconClass: string
  title: string
  summary?: ReactNode
  expanded: boolean
  onToggle: () => void
  children?: ReactNode
  t: T
}) {
  return (
    <div
      className={cn(
        "relative z-10 w-full rounded-xl border bg-card shadow-sm transition-shadow",
        expanded ? "border-primary/50 shadow-md ring-1 ring-primary/20" : "border-border hover:shadow-md",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-3 p-4 text-left"
      >
        <div
          className={cn("flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg", iconClass)}
          aria-hidden
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-muted-foreground">{eyebrow}</div>
          <div className="text-sm font-semibold text-foreground">{title}</div>
          {summary && (
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {summary}
            </div>
          )}
        </div>
        <span className="mt-0.5 inline-flex flex-shrink-0 items-center gap-1 text-xs font-medium text-primary">
          {expanded ? (
            <>
              <Check className="h-3.5 w-3.5" />
              {t("done")}
            </>
          ) : (
            <>
              <Pencil className="h-3.5 w-3.5" />
              {t("edit")}
            </>
          )}
        </span>
      </button>
      {expanded && <div className="border-t border-border px-4 py-4">{children}</div>}
    </div>
  )
}

/** Small highlighted token inside a card summary (a tag, a keyword, …). */
function Chip({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 font-medium text-primary">
      {color && (
        <span
          className="h-2 w-2 flex-shrink-0 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden
        />
      )}
      <span className="truncate">{children}</span>
    </span>
  )
}

/** Shown in a summary when a required setting is still empty. */
function MissingChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400">
      <AlertCircle className="h-3 w-3" />
      {children}
    </span>
  )
}

function Connector() {
  return <div className="mx-auto h-5 w-px bg-border" aria-hidden />
}

/** Small "+" on the line between two cards — inserts at that position. */
function InsertButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <div className="flex flex-col items-center">
      <div className="h-3 w-px bg-border" aria-hidden />
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        className="flex h-6 w-6 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <div className="h-3 w-px bg-border" aria-hidden />
    </div>
  )
}

/** Full-width "Add action" button at the end of a list. */
function AddActionButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-background/60 px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:border-primary hover:bg-primary/5 hover:text-primary"
    >
      <Plus className="h-4 w-4" />
      {label}
    </button>
  )
}

// ------------------------------------------------------------
// Trigger card ("When")
// ------------------------------------------------------------

function TriggerCard({
  type,
  config,
  expanded,
  onToggle,
  onTypeChange,
  onConfigChange,
  t,
}: {
  type: AutomationTriggerType
  config: Record<string, unknown>
  expanded: boolean
  onToggle: () => void
  onTypeChange: (t: AutomationTriggerType) => void
  onConfigChange: (c: Record<string, unknown>) => void
  t: T
}) {
  return (
    <FlowCard
      eyebrow={t("when")}
      icon={TRIGGER_ICON[type] ?? TRIGGER_ICON.new_message_received}
      iconClass={TRIGGER_ICON_CLASS}
      title={t(`triggers.${type}.label`)}
      summary={<TriggerSummary type={type} config={config} t={t} />}
      expanded={expanded}
      onToggle={onToggle}
      t={t}
    >
      <div className="space-y-4">
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">{t("triggerQuestion")}</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {TRIGGER_ORDER.map((value) => {
              const Icon = TRIGGER_ICON[value]
              const selected = value === type
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => onTypeChange(value)}
                  aria-pressed={selected}
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
                    selected
                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                      : "border-border hover:border-primary/40 hover:bg-muted/50",
                  )}
                >
                  <Icon
                    className={cn("mt-0.5 h-4 w-4 flex-shrink-0", selected ? "text-primary" : "text-muted-foreground")}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">
                      {t(`triggers.${value}.label`)}
                    </span>
                    <span className="block text-[11px] leading-snug text-muted-foreground">
                      {t(`triggers.${value}.hint`)}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {type === "keyword_match" && (
          <KeywordMatchConfig
            config={config as unknown as KeywordMatchTriggerConfig}
            onChange={onConfigChange}
            t={t}
          />
        )}
        {type === "interactive_reply" && (
          <InteractiveReplyConfig config={config} onChange={onConfigChange} t={t} />
        )}
        {type === "tag_added" && (
          <FieldBlock label={t("config.tagLabel")}>
            <TagSelect
              value={(config.tag_id as string) ?? ""}
              onChange={(v) => onConfigChange({ ...config, tag_id: v })}
              t={t}
            />
          </FieldBlock>
        )}
        {type === "time_based" && (
          <FieldBlock label={t("schedule")}>
            <Input
              placeholder="0 9 * * 1-5"
              value={(config.schedule as string) ?? ""}
              onChange={(e) => onConfigChange({ ...config, schedule: e.target.value })}
              className="bg-muted text-foreground"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">{t("scheduleHint")}</p>
          </FieldBlock>
        )}
      </div>
    </FlowCard>
  )
}

function TriggerSummary({
  type,
  config,
  t,
}: {
  type: AutomationTriggerType
  config: Record<string, unknown>
  t: T
}) {
  const { tags } = useResources()
  switch (type) {
    case "keyword_match": {
      const cfg = config as unknown as Partial<KeywordMatchTriggerConfig>
      const keywords = cfg.keywords ?? []
      if (keywords.length === 0) return <MissingChip>{t("summary.addKeywords")}</MissingChip>
      return (
        <>
          <span>{cfg.match_type === "exact" ? t("summary.messageIs") : t("summary.messageContains")}</span>
          {keywords.map((k, i) => (
            <span key={k + i} className="inline-flex items-center gap-1.5">
              {i > 0 && <span>{t("summary.or")}</span>}
              <Chip>{k}</Chip>
            </span>
          ))}
        </>
      )
    }
    case "interactive_reply": {
      const ids = (config.reply_ids as string[] | undefined) ?? []
      if (ids.length === 0) return <MissingChip>{t("summary.addReplyIds")}</MissingChip>
      return (
        <>
          <span>{t("summary.contactTaps")}</span>
          {ids.map((id) => (
            <Chip key={id}>{id}</Chip>
          ))}
        </>
      )
    }
    case "tag_added": {
      const tagId = (config.tag_id as string) ?? ""
      if (!tagId) return <MissingChip>{t("summary.pickTag")}</MissingChip>
      const tag = tags.find((tg) => tg.id === tagId)
      return (
        <>
          <span>{t("summary.tag")}</span>
          <Chip color={tag?.color}>{tag?.name ?? tagId}</Chip>
        </>
      )
    }
    case "time_based": {
      const schedule = (config.schedule as string) ?? ""
      if (!schedule) return <MissingChip>{t("summary.setSchedule")}</MissingChip>
      return (
        <>
          <span>{t("summary.schedule")}</span>
          <Chip>{schedule}</Chip>
        </>
      )
    }
    default:
      return <span>{t(`triggers.${type}.hint`)}</span>
  }
}

function KeywordMatchConfig({
  config,
  onChange,
  t,
}: {
  config: KeywordMatchTriggerConfig
  onChange: (c: Record<string, unknown>) => void
  t: T
}) {
  const keywords = config?.keywords ?? []
  // Keep a local draft string so the comma and trailing space aren't
  // stripped on every keystroke (which made multi-word, comma-separated
  // entry like "SEO, search engine optimization" impossible to type).
  // We only parse into the keywords array on blur, then re-display the
  // cleaned, rejoined form. Seeded once on mount; this component remounts
  // when the trigger type changes, so the seed stays in sync.
  const [draft, setDraft] = useState(keywords.join(", "))

  // Persist the default the <select> displays. The dropdown falls back to
  // "contains" for display, but leaving it untouched would otherwise omit
  // match_type from the saved config — and activation validation then
  // rejected it (trigger.match_type). Seed once on mount; the component
  // remounts when the trigger type changes, matching the keywords draft.
  useEffect(() => {
    if (config?.match_type == null) {
      onChange({ ...config, match_type: "contains" })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function commit() {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    setDraft(parsed.join(", "))
    onChange({ ...config, keywords: parsed })
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px]">
      <FieldBlock label={t("keywords")}>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            }
          }}
          placeholder={t("keywordsHint")}
          className="bg-muted text-foreground"
        />
      </FieldBlock>
      <FieldBlock label={t("config.matchType")}>
        <select
          value={config?.match_type ?? "contains"}
          onChange={(e) => onChange({ ...config, match_type: e.target.value as "exact" | "contains" })}
          className={SELECT_CLASS}
        >
          <option value="contains">{t("config.matchContains")}</option>
          <option value="exact">{t("config.matchExact")}</option>
        </select>
      </FieldBlock>
    </div>
  )
}

function InteractiveReplyConfig({
  config,
  onChange,
  t,
}: {
  config: Record<string, unknown>
  onChange: (c: Record<string, unknown>) => void
  t: T
}) {
  const ids = (config?.reply_ids as string[] | undefined) ?? []
  // Same local-draft-then-commit pattern as KeywordMatchConfig so
  // commas + spaces survive keystrokes.
  const [draft, setDraft] = useState(ids.join(", "))

  function commit() {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    setDraft(parsed.join(", "))
    onChange({ ...config, reply_ids: parsed })
  }

  return (
    <FieldBlock label={t("replyIds")}>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          }
        }}
        placeholder={t("replyIdsHint")}
        className="bg-muted font-mono text-foreground"
      />
      <p className="mt-1 text-[11px] text-muted-foreground">{t("replyIdsHelp")}</p>
    </FieldBlock>
  )
}

// ------------------------------------------------------------
// Action picker dialog
// ------------------------------------------------------------

function ActionPicker({
  open,
  onOpenChange,
  onPick,
  t,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onPick: (type: AutomationStepType) => void
  t: T
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("picker.title")}</DialogTitle>
          <DialogDescription>{t("picker.desc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {STEP_GROUPS.map((group) => (
            <section key={group.key}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t(`picker.groups.${group.key}`)}
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {group.steps.map((type) => {
                  const Icon = STEP_META[type].icon
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => onPick(type)}
                      className="flex items-start gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
                    >
                      <span
                        className={cn(
                          "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md",
                          stepIconClass(type),
                        )}
                        aria-hidden
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-foreground">
                          {t(`steps.${type}`)}
                        </span>
                        <span className="block text-[11px] leading-snug text-muted-foreground">
                          {t(`stepHints.${type}`)}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ------------------------------------------------------------
// Step list + cards ("Then")
// ------------------------------------------------------------

type ParentScope =
  | { kind: "root" }
  | { kind: "branch"; parentCid: string; branch: "yes" | "no" }

type StepPath = (
  | { kind: "root"; index: number }
  | { kind: "branch"; parentCid: string; branch: "yes" | "no"; index: number }
)[]

interface StepListProps {
  steps: BuilderStep[]
  parentPath: StepPath
  expandedId: string | null
  setExpandedId: (id: string | null) => void
  updateStep: (path: StepPath, updater: (s: BuilderStep) => BuilderStep) => void
  /** Opens the action picker; the pick is inserted at (parent, index). */
  requestAdd: (parent: ParentScope, index: number) => void
  deleteStepAt: (path: StepPath) => void
  moveStepAt: (path: StepPath, direction: -1 | 1) => void
}

function StepList(props: StepListProps) {
  const t = useTranslations("Automations.builder")
  const { steps, parentPath, ...rest } = props
  const isRoot = parentPath.length === 0
  const parentScope: ParentScope = isRoot
    ? { kind: "root" }
    : (() => {
        const last = parentPath[parentPath.length - 1]
        if (last.kind !== "branch") return { kind: "root" } as const
        return { kind: "branch", parentCid: last.parentCid, branch: last.branch } as const
      })()
  const lastIsCondition = steps[steps.length - 1]?.step_type === "condition"

  return (
    <div className="flex w-full flex-col">
      {steps.map((step, idx) => (
        <StepRenderer
          key={step.cid}
          step={step}
          index={idx}
          total={steps.length}
          parentScope={parentScope}
          parentPath={parentPath}
          {...rest}
        />
      ))}

      {/* A condition branches into Yes/No, so it has no linear "continue"
          path — a trailing add button would produce a spurious third
          output. Steps after it belong inside its branches. */}
      {!lastIsCondition && (
        <>
          {isRoot && <Connector />}
          {isRoot && steps.length === 0 && (
            <p className="mb-2 text-center text-xs text-muted-foreground">{t("emptySteps")}</p>
          )}
          <AddActionButton
            onClick={() => props.requestAdd(parentScope, steps.length)}
            label={steps.length === 0 && isRoot ? t("addFirstAction") : t("addAction")}
          />
        </>
      )}
    </div>
  )
}

function StepRenderer({
  step,
  index,
  total,
  parentScope,
  parentPath,
  ...props
}: {
  step: BuilderStep
  index: number
  total: number
  parentScope: ParentScope
  parentPath: StepPath
} & Omit<StepListProps, "steps" | "parentPath">) {
  const t = useTranslations("Automations.builder")
  const path: StepPath = [
    ...parentPath,
    parentScope.kind === "root"
      ? { kind: "root", index }
      : { kind: "branch", parentCid: parentScope.parentCid, branch: parentScope.branch, index },
  ]
  const expanded = props.expandedId === step.cid
  const isCondition = step.step_type === "condition"
  const isRoot = parentScope.kind === "root"
  const eyebrow = isCondition
    ? t("checkStep", { n: index + 1 })
    : isRoot && index === 0
      ? t("thenFirst")
      : t("thenStep", { n: index + 1 })

  return (
    <>
      {/* Between the trigger (or the previous step) and this one: a "+"
          that inserts here. Inside branches the first slot is a plain
          gap — the branch header already sits above it. */}
      {isRoot || index > 0 ? (
        <InsertButton
          onClick={() => props.requestAdd(parentScope, index)}
          label={t("insertHere")}
        />
      ) : null}

      <FlowCard
        eyebrow={eyebrow}
        icon={STEP_META[step.step_type]?.icon ?? STEP_META.send_message.icon}
        iconClass={stepIconClass(step.step_type)}
        title={t(`steps.${step.step_type}`)}
        summary={<StepSummary step={step} t={t} />}
        expanded={expanded}
        onToggle={() => props.setExpandedId(expanded ? null : step.cid)}
        t={t}
      >
        <StepEditor step={step} onChange={(next) => props.updateStep(path, () => next)} />
        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              disabled={index === 0}
              aria-label={t("moveUp")}
              title={t("moveUp")}
              onClick={() => props.moveStepAt(path, -1)}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              disabled={index === total - 1}
              aria-label={t("moveDown")}
              title={t("moveDown")}
              onClick={() => props.moveStepAt(path, 1)}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => props.deleteStepAt(path)} className="text-destructive hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
              {t("delete")}
            </Button>
            <Button size="sm" onClick={() => props.setExpandedId(null)}>
              <Check className="h-3.5 w-3.5" />
              {t("done")}
            </Button>
          </div>
        </div>
      </FlowCard>

      {isCondition && <ConditionBranches step={step} parentPath={path} {...props} />}
    </>
  )
}

function ConditionBranches({
  step,
  parentPath,
  ...props
}: {
  step: BuilderStep
  parentPath: StepPath
} & Omit<StepListProps, "steps" | "parentPath">) {
  const t = useTranslations("Automations.builder")
  const yes = step.branches?.yes ?? []
  const no = step.branches?.no ?? []
  // Build the child scope by appending a branch marker. The scope the
  // StepList uses is driven by the LAST element of parentPath, so the
  // tail's `index` doesn't matter — it's replaced per child during walks.
  const yesPath: StepPath = [
    ...parentPath,
    { kind: "branch", parentCid: step.cid, branch: "yes", index: 0 },
  ]
  const noPath: StepPath = [
    ...parentPath,
    { kind: "branch", parentCid: step.cid, branch: "no", index: 0 },
  ]
  return (
    <>
      <Connector />
      {/* Stack Yes/No vertically on mobile — two columns at 375px would
          cram each branch too narrow for the nested cards. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <BranchColumn label={t("branches.ifYes")} tone="yes">
          <StepList {...props} steps={yes} parentPath={yesPath} />
        </BranchColumn>
        <BranchColumn label={t("branches.ifNo")} tone="no">
          <StepList {...props} steps={no} parentPath={noPath} />
        </BranchColumn>
      </div>
    </>
  )
}

function BranchColumn({
  label,
  tone,
  children,
}: {
  label: string
  tone: "yes" | "no"
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-dashed p-3",
        tone === "yes" ? "border-emerald-500/40 bg-emerald-500/5" : "border-rose-500/40 bg-rose-500/5",
      )}
    >
      <span
        className={cn(
          "self-start rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
          tone === "yes"
            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            : "bg-rose-500/15 text-rose-600 dark:text-rose-400",
        )}
      >
        {label}
      </span>
      {children}
    </div>
  )
}

// ------------------------------------------------------------
// Plain-language step summaries (collapsed card body)
// ------------------------------------------------------------

/** Built-in contact columns that have a translated label under `fields.*`. */
const BUILTIN_FIELDS = ["name", "email", "company"]

function truncate(s: string, n = 90): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

function StepSummary({ step, t }: { step: BuilderStep; t: T }) {
  const { tags, members, customFields, pipelines } = useResources()
  const cfg = step.step_config

  const tagChip = (id: string) => {
    if (!id) return <MissingChip>{t("summary.pickTag")}</MissingChip>
    const tag = tags.find((tg) => tg.id === id)
    return <Chip color={tag?.color}>{tag?.name ?? id}</Chip>
  }

  switch (step.step_type) {
    case "send_message": {
      const text = ((cfg.text as string) ?? "").trim()
      return text ? <span className="italic">“{truncate(text)}”</span> : <MissingChip>{t("summary.writeMessage")}</MissingChip>
    }
    case "send_buttons":
    case "send_list": {
      const text = interactivePayloadPreviewText(asInteractive(cfg))
      return text ? <span className="italic">“{truncate(text)}”</span> : <MissingChip>{t("summary.writeMessage")}</MissingChip>
    }
    case "send_template": {
      const name = (cfg.template_name as string) ?? ""
      if (!name) return <MissingChip>{t("summary.pickTemplate")}</MissingChip>
      return <Chip>{cfg.language ? `${name} (${cfg.language as string})` : name}</Chip>
    }
    case "add_tag":
    case "remove_tag":
      return tagChip((cfg.tag_id as string) ?? "")
    case "assign_conversation": {
      if (cfg.mode !== "specific") return <span>{t("summary.roundRobin")}</span>
      const id = (cfg.agent_id as string) ?? ""
      if (!id) return <MissingChip>{t("summary.pickAgent")}</MissingChip>
      const m = members.find((x) => x.user_id === id)
      return (
        <>
          <span>{t("summary.to")}</span>
          <Chip>{m?.full_name || m?.email || id}</Chip>
        </>
      )
    }
    case "update_contact_field": {
      const field = (cfg.field as string) || "name"
      const label = field.startsWith("custom:")
        ? customFields.find((f) => `custom:${f.id}` === field)?.field_name ?? field
        : BUILTIN_FIELDS.includes(field)
          ? t(`fields.${field}`)
          : field
      const value = (cfg.value as string) ?? ""
      return (
        <>
          <Chip>{label}</Chip>
          <span>→</span>
          {value ? <span className="italic">“{truncate(value, 60)}”</span> : <MissingChip>{t("summary.setValue")}</MissingChip>}
        </>
      )
    }
    case "create_deal": {
      const title = (cfg.title as string) ?? ""
      const pipeline = pipelines.find((p) => p.id === cfg.pipeline_id)
      if (!cfg.pipeline_id) return <MissingChip>{t("summary.pickPipeline")}</MissingChip>
      return (
        <>
          {title && <span className="italic">“{truncate(title, 60)}”</span>}
          <span>{t("summary.in")}</span>
          <Chip>{pipeline?.name ?? (cfg.pipeline_id as string)}</Chip>
        </>
      )
    }
    case "wait":
      return (
        <Chip>
          {(cfg.amount as number) ?? 1} {t(`config.units.${(cfg.unit as string) ?? "hours"}`)}
        </Chip>
      )
    case "condition":
      return <ConditionSummary cfg={cfg} tagChip={tagChip} t={t} />
    case "send_webhook": {
      const url = (cfg.url as string) ?? ""
      return url ? <Chip>{truncate(url, 60)}</Chip> : <MissingChip>{t("summary.setUrl")}</MissingChip>
    }
    case "close_conversation":
      return <span>{t("summary.closes")}</span>
    default:
      return null
  }
}

function ConditionSummary({
  cfg,
  tagChip,
  t,
}: {
  cfg: Record<string, unknown>
  tagChip: (id: string) => ReactNode
  t: T
}) {
  const operand = (cfg.operand as string) ?? ""
  const value = (cfg.value as string) ?? ""
  switch (cfg.subject) {
    case "tag_presence":
      return (
        <>
          <span>{t("summary.contactHasTag")}</span>
          {tagChip(operand)}
        </>
      )
    case "contact_field":
      if (!operand) return <MissingChip>{t("summary.pickField")}</MissingChip>
      return (
        <>
          <Chip>{BUILTIN_FIELDS.includes(operand) ? t(`fields.${operand}`) : operand}</Chip>
          <span>{t("summary.is")}</span>
          {value ? <Chip>{value}</Chip> : <MissingChip>{t("summary.setValue")}</MissingChip>}
        </>
      )
    case "message_content":
      return (
        <>
          <span>{t("summary.messageContains")}</span>
          {value ? <Chip>{value}</Chip> : <MissingChip>{t("summary.setValue")}</MissingChip>}
        </>
      )
    case "time_of_day": {
      const [from, to] = operand.split("-")
      if (!from || !to) return <MissingChip>{t("summary.setTimes")}</MissingChip>
      return (
        <>
          <span>{t("summary.timeBetween")}</span>
          <Chip>{from}</Chip>
          <span>–</span>
          <Chip>{to}</Chip>
          {cfg.timezone ? <span>({cfg.timezone as string})</span> : <MissingChip>{t("summary.pickTimezone")}</MissingChip>}
        </>
      )
    }
    default:
      return null
  }
}

// ------------------------------------------------------------
// Per-step config editor
// ------------------------------------------------------------

function StepEditor({
  step,
  onChange,
}: {
  step: BuilderStep
  onChange: (s: BuilderStep) => void
}) {
  const t = useTranslations("Automations.builder")
  const cfg = step.step_config
  const set = (patch: Record<string, unknown>) =>
    onChange({ ...step, step_config: { ...cfg, ...patch } })

  switch (step.step_type) {
    case "send_message":
      return (
        <FieldBlock label={t("config.messageText")}>
          <Textarea
            value={(cfg.text as string) ?? ""}
            onChange={(e) => set({ text: e.target.value })}
            placeholder={t("config.placeholderMessageText")}
            className="min-h-24 bg-muted text-foreground"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">{t("config.messageTextHint")}</p>
        </FieldBlock>
      )
    case "send_buttons":
    case "send_list":
      // The whole step_config IS the interactive payload; the shared
      // builder edits it in place (and enforces Meta's limits + preview).
      return (
        <InteractiveBuilder
          value={asInteractive(cfg)}
          onChange={(payload) =>
            onChange({ ...step, step_config: toStepConfig(payload) })
          }
        />
      )
    case "send_template":
      return (
        <SendTemplateFields
          templateName={(cfg.template_name as string) ?? ""}
          language={(cfg.language as string) ?? ""}
          onChange={(patch) => set(patch)}
          t={t}
        />
      )
    case "add_tag":
    case "remove_tag":
      return (
        <FieldBlock label={t("config.tagLabel")}>
          <TagSelect
            value={(cfg.tag_id as string) ?? ""}
            onChange={(v) => set({ tag_id: v })}
            t={t}
          />
        </FieldBlock>
      )
    case "assign_conversation":
      return (
        <>
          <FieldBlock label={t("config.modeLabel")}>
            <select
              value={(cfg.mode as string) ?? "round_robin"}
              onChange={(e) => set({ mode: e.target.value })}
              className={SELECT_CLASS}
            >
              <option value="round_robin">{t("config.modes.round_robin")}</option>
              <option value="specific">{t("config.modes.specific")}</option>
            </select>
          </FieldBlock>
          {cfg.mode === "specific" && (
            <FieldBlock label={t("config.agentLabel")}>
              <AgentSelect
                value={(cfg.agent_id as string) ?? ""}
                onChange={(v) => set({ agent_id: v })}
                t={t}
              />
            </FieldBlock>
          )}
        </>
      )
    case "update_contact_field":
      return (
        <>
          <FieldBlock label={t("config.fieldLabel")}>
            <ContactFieldSelect
              value={(cfg.field as string) ?? "name"}
              onChange={(v) => set({ field: v })}
              t={t}
            />
          </FieldBlock>
          <FieldBlock label={t("config.valueLabel")}>
            <Input
              value={(cfg.value as string) ?? ""}
              onChange={(e) => set({ value: e.target.value })}
              placeholder={t("config.placeholderValue")}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "create_deal":
      return (
        <>
          <DealPipelineFields
            pipelineId={(cfg.pipeline_id as string) ?? ""}
            stageId={(cfg.stage_id as string) ?? ""}
            onChange={(patch) => set(patch)}
            t={t}
          />
          <FieldBlock label={t("config.titleLabel")}>
            <Input
              value={(cfg.title as string) ?? ""}
              onChange={(e) => set({ title: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.valueLabel")}>
            <Input
              type="number"
              value={(cfg.value as number) ?? 0}
              onChange={(e) => set({ value: Number(e.target.value) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "wait":
      return (
        <>
          <div className="grid grid-cols-2 gap-2">
            <FieldBlock label={t("config.amountLabel")}>
              <Input
                type="number"
                min={1}
                value={(cfg.amount as number) ?? 1}
                onChange={(e) => set({ amount: Math.max(1, Number(e.target.value)) })}
                className="bg-muted text-foreground"
              />
            </FieldBlock>
            <FieldBlock label={t("config.unitLabel")}>
              <select
                value={(cfg.unit as string) ?? "hours"}
                onChange={(e) => set({ unit: e.target.value })}
                className={SELECT_CLASS}
              >
                <option value="minutes">{t("config.units.minutes")}</option>
                <option value="hours">{t("config.units.hours")}</option>
                <option value="days">{t("config.units.days")}</option>
              </select>
            </FieldBlock>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{t("config.waitHint")}</p>
        </>
      )
    case "condition":
      return <ConditionEditor cfg={cfg} set={set} t={t} />
    case "send_webhook":
      return (
        <>
          <FieldBlock label={t("config.urlLabel")}>
            <Input
              value={(cfg.url as string) ?? ""}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://"
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.bodyTemplateLabel")}>
            <Textarea
              value={(cfg.body_template as string) ?? ""}
              onChange={(e) => set({ body_template: e.target.value })}
              placeholder={t("config.placeholderBody")}
              className="min-h-20 bg-muted font-mono text-xs text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "close_conversation":
      return (
        <p className="text-xs text-muted-foreground">{t("config.closeConversationHint")}</p>
      )
    default:
      return null
  }
}

/** The viewer's IANA zone — the default for new time-of-day conditions,
 *  since whoever builds the automation is usually in the business's zone. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

/** All IANA zones the browser knows, keeping a saved value that isn't in
 *  the list so editing never drops it. */
function timeZoneOptions(current: string): string[] {
  let zones: string[] = []
  try {
    zones = Intl.supportedValuesOf("timeZone")
  } catch {
    zones = []
  }
  const browser = browserTimeZone()
  for (const z of [current, browser, "UTC"]) {
    if (z && !zones.includes(z)) zones = [z, ...zones]
  }
  return zones
}

/** If/Else settings. Each subject gets the input that fits it (tag picker,
 *  field picker, time range) instead of one free-text "operand" box; the
 *  stored shape is unchanged: { subject, operand, value }. */
function ConditionEditor({
  cfg,
  set,
  t,
}: {
  cfg: Record<string, unknown>
  set: (patch: Record<string, unknown>) => void
  t: T
}) {
  const subject = (cfg.subject as string) ?? "tag_presence"
  const operand = (cfg.operand as string) ?? ""
  const value = (cfg.value as string) ?? ""
  const timezone = (cfg.timezone as string) ?? ""
  const [from = "", to = ""] = subject === "time_of_day" ? operand.split("-") : []

  return (
    <>
      <FieldBlock label={t("config.conditionQuestion")}>
        <select
          value={subject}
          onChange={(e) => {
            const next = e.target.value
            // Reset the dependent inputs — a tag id makes no sense as a
            // time range. message_content has no operand of its own, but
            // validation requires one, so it gets a fixed marker.
            set({
              subject: next,
              operand: next === "message_content" ? "message_text" : "",
              value: "",
              timezone: next === "time_of_day" ? browserTimeZone() : undefined,
            })
          }}
          className={SELECT_CLASS}
        >
          <option value="tag_presence">{t("config.subjects.tag_presence")}</option>
          <option value="contact_field">{t("config.subjects.contact_field")}</option>
          <option value="message_content">{t("config.subjects.message_content")}</option>
          <option value="time_of_day">{t("config.subjects.time_of_day")}</option>
        </select>
      </FieldBlock>

      {subject === "tag_presence" && (
        <FieldBlock label={t("config.tagLabel")}>
          <TagSelect value={operand} onChange={(v) => set({ operand: v })} t={t} />
        </FieldBlock>
      )}

      {subject === "contact_field" && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <FieldBlock label={t("config.fieldLabel")}>
            <select
              value={operand}
              onChange={(e) => set({ operand: e.target.value })}
              className={SELECT_CLASS}
            >
              <option value="">{t("config.selectField")}</option>
              <option value="name">{t("fields.name")}</option>
              <option value="email">{t("fields.email")}</option>
              <option value="company">{t("fields.company")}</option>
            </select>
          </FieldBlock>
          <FieldBlock label={t("config.equalsLabel")}>
            <Input
              value={value}
              onChange={(e) => set({ value: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </div>
      )}

      {subject === "message_content" && (
        <FieldBlock label={t("config.containsLabel")}>
          <Input
            value={value}
            onChange={(e) => set({ value: e.target.value, operand: "message_text" })}
            placeholder={t("config.placeholderContains")}
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      )}

      {subject === "time_of_day" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <FieldBlock label={t("config.fromLabel")}>
              <Input
                type="time"
                value={from}
                onChange={(e) => set({ operand: `${e.target.value}-${to}` })}
                className="bg-muted text-foreground"
              />
            </FieldBlock>
            <FieldBlock label={t("config.toLabel")}>
              <Input
                type="time"
                value={to}
                onChange={(e) => set({ operand: `${from}-${e.target.value}` })}
                className="bg-muted text-foreground"
              />
            </FieldBlock>
          </div>
          <p className="mb-3 mt-1 text-[11px] text-muted-foreground">{t("config.timeRangeHint")}</p>
          <FieldBlock label={t("config.timezoneLabel")}>
            <select
              value={timezone}
              onChange={(e) => set({ timezone: e.target.value || undefined })}
              className={SELECT_CLASS}
            >
              <option value="">{t("config.timezoneServer")}</option>
              {timeZoneOptions(timezone).map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
            {!timezone && (
              <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                {t("config.timezoneMissing")}
              </p>
            )}
          </FieldBlock>
        </>
      )}

      <p className="mt-3 text-[11px] text-muted-foreground">{t("config.conditionHint")}</p>
    </>
  )
}

function FieldBlock({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="mb-3 last:mb-0">
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

// ------------------------------------------------------------
// Tree mutation helpers
// ------------------------------------------------------------

function insertAt(
  steps: BuilderStep[],
  parent: ParentScope,
  index: number,
  node: BuilderStep,
): BuilderStep[] {
  if (parent.kind === "root") {
    const copy = [...steps]
    copy.splice(index, 0, node)
    return copy
  }
  return steps.map((s) => {
    if (s.cid !== parent.parentCid || !s.branches) return s
    const list = [...s.branches[parent.branch]]
    list.splice(index, 0, node)
    return { ...s, branches: { ...s.branches, [parent.branch]: list } }
  })
}

function mapAtPath(
  steps: BuilderStep[],
  path: StepPath,
  updater: (s: BuilderStep) => BuilderStep,
): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)

  if (head.kind === "root") {
    return steps.map((s, i) => {
      if (i !== head.index) return s
      return rest.length === 0
        ? updater(s)
        : { ...s, branches: walkBranches(s.branches, rest, updater) }
    })
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const updated = bucket.map((child, i) => {
      if (i !== head.index) return child
      return rest.length === 0
        ? updater(child)
        : { ...child, branches: walkBranches(child.branches, rest, updater) }
    })
    return { ...s, branches: { ...s.branches, [head.branch]: updated } }
  })
}

function walkBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
  updater: (s: BuilderStep) => BuilderStep,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const bucket = branches[head.branch]
  const rest = path.slice(1)
  const updated = bucket.map((child, i) => {
    if (i !== head.index) return child
    return rest.length === 0
      ? updater(child)
      : { ...child, branches: walkBranches(child.branches, rest, updater) }
  })
  return { ...branches, [head.branch]: updated }
}

function removeAt(steps: BuilderStep[], path: StepPath): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)
  if (head.kind === "root") {
    if (rest.length === 0) return steps.filter((_, i) => i !== head.index)
    return steps.map((s, i) =>
      i !== head.index ? s : { ...s, branches: removeFromBranches(s.branches, rest) },
    )
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const next =
      rest.length === 0
        ? bucket.filter((_, i) => i !== head.index)
        : bucket.map((child, i) =>
            i !== head.index
              ? child
              : { ...child, branches: removeFromBranches(child.branches, rest) },
          )
    return { ...s, branches: { ...s.branches, [head.branch]: next } }
  })
}

function removeFromBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const rest = path.slice(1)
  const bucket = branches[head.branch]
  const next =
    rest.length === 0
      ? bucket.filter((_, i) => i !== head.index)
      : bucket.map((child, i) =>
          i !== head.index
            ? child
            : { ...child, branches: removeFromBranches(child.branches, rest) },
        )
  return { ...branches, [head.branch]: next }
}

function moveAt(
  steps: BuilderStep[],
  path: StepPath,
  direction: -1 | 1,
): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)
  const swap = <T,>(arr: T[], i: number) => {
    const j = i + direction
    if (j < 0 || j >= arr.length) return arr
    const copy = [...arr]
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    return copy
  }
  if (head.kind === "root") {
    if (rest.length === 0) return swap(steps, head.index)
    return steps.map((s, i) =>
      i !== head.index ? s : { ...s, branches: moveInBranches(s.branches, rest, direction) },
    )
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const next = rest.length === 0 ? swap(bucket, head.index) : bucket
    return { ...s, branches: { ...s.branches, [head.branch]: next } }
  })
}

function moveInBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
  direction: -1 | 1,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const rest = path.slice(1)
  const bucket = branches[head.branch]
  const swap = <T,>(arr: T[], i: number) => {
    const j = i + direction
    if (j < 0 || j >= arr.length) return arr
    const copy = [...arr]
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    return copy
  }
  const next = rest.length === 0 ? swap(bucket, head.index) : bucket
  return { ...branches, [head.branch]: next }
}

// ------------------------------------------------------------
// Serialize builder tree → API payload (flattened shape)
// ------------------------------------------------------------

interface ApiStep {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: ApiStep[]; no?: ApiStep[] }
}

export function toApiSteps(steps: BuilderStep[]): ApiStep[] {
  return steps.map((s) => ({
    step_type: s.step_type,
    step_config: s.step_config,
    branches: s.branches
      ? { yes: toApiSteps(s.branches.yes), no: toApiSteps(s.branches.no) }
      : undefined,
  }))
}

/**
 * Convert server-returned step tree (from loadStepsTree) into the
 * builder-local shape with client ids.
 */
export interface ServerStepNode {
  id: string
  step_type: string
  step_config: Record<string, unknown>
  branches: { yes: ServerStepNode[]; no: ServerStepNode[] }
}

export function fromServerSteps(nodes: ServerStepNode[]): BuilderStep[] {
  return nodes.map((n) => ({
    cid: cid(),
    step_type: n.step_type as AutomationStepType,
    step_config: n.step_config ?? {},
    branches:
      n.step_type === "condition"
        ? {
            yes: fromServerSteps(n.branches?.yes ?? []),
            no: fromServerSteps(n.branches?.no ?? []),
          }
        : undefined,
  }))
}
