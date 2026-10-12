"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Zap,
  Plus,
  Copy,
  Pencil,
  Trash2,
  FileText,
  MessageCircle,
  Clock,
  Users,
  PhoneCall,
  Loader2,
  Search,
  ChevronRight,
} from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { useCan } from "@/hooks/use-can"
import { useTranslations } from "next-intl"
import type { Automation, AutomationStepType, KeywordMatchTriggerConfig } from "@/types"
import { Button } from "@/components/ui/button"
import { GatedButton } from "@/components/ui/gated-button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AUTOMATION_TEMPLATES, type TemplateSlug } from "@/lib/automations/templates"
import { formatRelative } from "@/lib/automations/trigger-meta"
import {
  STEP_META,
  TRIGGER_ICON,
  TRIGGER_ICON_CLASS,
  stepIconClass,
} from "@/lib/automations/step-meta"
import { cn } from "@/lib/utils"

const TEMPLATE_ORDER: TemplateSlug[] = [
  "welcome_message",
  "out_of_office",
  "lead_qualifier",
  "follow_up_reminder",
]

const TEMPLATE_ICON: Record<TemplateSlug, typeof Zap> = {
  welcome_message: MessageCircle,
  out_of_office: Clock,
  lead_qualifier: Users,
  follow_up_reminder: PhoneCall,
}

/** List row: the automation plus its steps (only what the "Then" column
 *  needs), embedded via the automation_steps FK. */
type AutomationRow = Automation & {
  automation_steps?: {
    step_type: AutomationStepType
    position: number
    parent_step_id: string | null
  }[]
}

type StatusFilter = "all" | "on" | "off"

export default function AutomationsPage() {
  const router = useRouter()
  const canCreate = useCan("send-messages")
  const t = useTranslations("Automations.list")
  const [automations, setAutomations] = useState<AutomationRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<AutomationRow | null>(null)
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [deleting, setDeleting] = useState(false)

  async function load() {
    try {
      const supabase = createClient()
      const { data, error: fetchErr } = await supabase
        .from("automations")
        .select("*, automation_steps(step_type, position, parent_step_id)")
        .order("created_at", { ascending: false })
      if (fetchErr) throw fetchErr
      setAutomations((data ?? []) as AutomationRow[])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load automations")
    }
  }

  useEffect(() => {
    load()
  }, [])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (automations ?? []).filter((a) => {
      if (statusFilter === "on" && !a.is_active) return false
      if (statusFilter === "off" && a.is_active) return false
      if (!q) return true
      return (
        a.name.toLowerCase().includes(q) ||
        (a.description ?? "").toLowerCase().includes(q)
      )
    })
  }, [automations, query, statusFilter])

  async function toggleActive(a: AutomationRow, next: boolean) {
    // Optimistic flip so the switch feels instant.
    setAutomations((prev) =>
      prev?.map((x) => (x.id === a.id ? { ...x, is_active: next } : x)) ?? prev,
    )
    const res = await fetch(`/api/automations/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: next }),
    })
    if (!res.ok) {
      // Roll back on error.
      setAutomations((prev) =>
        prev?.map((x) => (x.id === a.id ? { ...x, is_active: !next } : x)) ?? prev,
      )
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.updateError"))
      return
    }
    toast.success(next ? t("toasts.activated") : t("toasts.paused"))
  }

  async function duplicate(a: AutomationRow) {
    const res = await fetch(`/api/automations/${a.id}/duplicate`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.duplicateError"))
      return
    }
    toast.success(t("toasts.duplicated"))
    load()
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    const res = await fetch(`/api/automations/${pendingDelete.id}`, { method: "DELETE" })
    setDeleting(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.deleteError"))
      return
    }
    toast.success(t("toasts.deleted"))
    setPendingDelete(null)
    load()
  }

  async function startFromTemplate(slug: TemplateSlug) {
    router.push(`/automations/new?template=${slug}`)
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t("retry")}
        </Button>
      </div>
    )
  }

  if (automations === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  const showTemplates = automations.length < 3

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("subtitle")}
          </p>
        </div>
        <GatedButton
          canAct={canCreate}
          gateReason="create automations"
          onClick={() => router.push("/automations/new")}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {t("create")}
        </GatedButton>
      </div>

      {showTemplates && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground">{t("templatesTitle")}</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {TEMPLATE_ORDER.map((slug) => {
              const t = AUTOMATION_TEMPLATES[slug]
              const Icon = TEMPLATE_ICON[slug]
              return (
                <button
                  key={slug}
                  onClick={() => startFromTemplate(slug)}
                  className="group flex flex-col items-start rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-card/80"
                >
                  <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary group-hover:bg-primary/15">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="text-sm font-semibold text-foreground">{t.name}</div>
                  <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {automations.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Zap className="h-6 w-6 text-primary" />
          </div>
          <p className="mt-3 text-sm font-medium text-foreground">{t("emptyTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("emptyDesc")}
          </p>
        </div>
      ) : (
        <section className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("search")}
                className="pl-8"
              />
            </div>
            <div className="inline-flex self-start rounded-lg border border-border bg-card p-0.5 text-xs">
              {(["all", "on", "off"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setStatusFilter(f)}
                  className={cn(
                    "rounded-md px-3 py-1 font-medium transition-colors",
                    statusFilter === f
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f === "all" ? t("filterAll") : f === "on" ? t("filterOn") : t("filterOff")}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[880px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">{t("colName")}</th>
                  <th className="px-4 py-3">{t("colTrigger")}</th>
                  <th className="px-4 py-3">{t("colActions")}</th>
                  <th className="px-4 py-3">{t("colStatus")}</th>
                  <th className="px-4 py-3 text-right">{t("colExecuted")}</th>
                  <th className="px-4 py-3">{t("colLastRun")}</th>
                  <th className="px-4 py-3 text-right">{t("colRowActions")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((a) => (
                  <AutomationRowView
                    key={a.id}
                    automation={a}
                    onToggle={(next) => toggleActive(a, next)}
                    onEdit={() => router.push(`/automations/${a.id}/edit`)}
                    onDuplicate={() => duplicate(a)}
                    onLogs={() => router.push(`/automations/${a.id}/logs`)}
                    onDelete={() => setPendingDelete(a)}
                    t={t}
                  />
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                      {t("noResults")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Dialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteDesc", { name: pendingDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function AutomationRowView({
  automation,
  onToggle,
  onEdit,
  onDuplicate,
  onLogs,
  onDelete,
  t,
}: {
  automation: AutomationRow
  onToggle: (next: boolean) => void
  onEdit: () => void
  onDuplicate: () => void
  onLogs: () => void
  onDelete: () => void
  t: ReturnType<typeof useTranslations>
}) {
  const tb = useTranslations("Automations.builder")
  const TriggerIcon = TRIGGER_ICON[automation.trigger_type] ?? Zap
  const keywords =
    automation.trigger_type === "keyword_match"
      ? ((automation.trigger_config as Partial<KeywordMatchTriggerConfig>).keywords ?? [])
      : []
  // Top-level steps in run order; branch children stay hidden here.
  const steps = (automation.automation_steps ?? [])
    .filter((s) => !s.parent_step_id)
    .sort((x, y) => x.position - y.position)
  const shown = steps.slice(0, 2)
  const more = steps.length - shown.length

  const iconBtn =
    "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"

  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-muted/40">
      <td className="max-w-[240px] px-4 py-3 align-top">
        <button type="button" onClick={onEdit} className="text-left">
          <span className="block truncate font-semibold text-primary hover:underline">
            {automation.name}
          </span>
          {automation.description && (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {automation.description}
            </span>
          )}
        </button>
      </td>
      <td className="max-w-[260px] px-4 py-3 align-top">
        <div className="flex items-start gap-2">
          <span
            className={cn("flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md", TRIGGER_ICON_CLASS)}
            aria-hidden
          >
            <TriggerIcon className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <div className="text-sm text-foreground">
              {tb(`triggers.${automation.trigger_type}.label`)}
            </div>
            {keywords.length > 0 && (
              <div className="truncate text-xs text-muted-foreground">
                {keywords.map((k) => `“${k}”`).join(", ")}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 align-top">
        {steps.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t("noActions")}</span>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {shown.map((s, i) => {
              const Icon = STEP_META[s.step_type]?.icon ?? Zap
              return (
                <span key={i} className="inline-flex items-center gap-1.5">
                  {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 text-xs text-foreground">
                    <span
                      className={cn("flex h-4 w-4 items-center justify-center rounded", stepIconClass(s.step_type))}
                      aria-hidden
                    >
                      <Icon className="h-3 w-3" />
                    </span>
                    {tb(`steps.${s.step_type}`)}
                  </span>
                </span>
              )
            })}
            {more > 0 && (
              <span className="text-xs text-muted-foreground">{t("moreSteps", { count: more })}</span>
            )}
          </div>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        <div className="flex items-center gap-2">
          <Switch
            checked={automation.is_active}
            onCheckedChange={(v) => onToggle(!!v)}
            aria-label={automation.is_active ? t("deactivate") : t("activate")}
          />
          <span
            className={cn(
              "text-xs font-medium",
              automation.is_active ? "text-primary" : "text-muted-foreground",
            )}
          >
            {automation.is_active ? t("on") : t("off")}
          </span>
        </div>
      </td>
      <td className="px-4 py-3 text-right align-top tabular-nums text-foreground">
        {automation.execution_count}
      </td>
      <td className="whitespace-nowrap px-4 py-3 align-top text-xs text-muted-foreground">
        {automation.last_executed_at ? formatRelative(automation.last_executed_at) : t("never")}
      </td>
      <td className="px-4 py-3 align-top">
        <div className="flex items-center justify-end gap-0.5">
          <button type="button" onClick={onEdit} className={iconBtn} title={t("edit")} aria-label={t("edit")}>
            <Pencil className="h-4 w-4" />
          </button>
          <button type="button" onClick={onDuplicate} className={iconBtn} title={t("duplicate")} aria-label={t("duplicate")}>
            <Copy className="h-4 w-4" />
          </button>
          <button type="button" onClick={onLogs} className={iconBtn} title={t("viewLogs")} aria-label={t("viewLogs")}>
            <FileText className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className={cn(iconBtn, "hover:bg-destructive/10 hover:text-destructive")}
            title={t("delete")}
            aria-label={t("delete")}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </td>
    </tr>
  )
}
