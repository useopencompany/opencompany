"use client";

import {
  type AgentSchedulePreset,
  cronForSchedulePreset,
  SUPPORTED_HOUR_INTERVALS,
  schedulePresetFromCron,
  scheduleSummary,
} from "@opencompany/agent-runtime";
import { workflowActivationDisabledReason } from "@opencompany/core/workflows";
import type { PluginEventFilterDefinitionDto } from "@opencompany/protocol";
import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Trash2,
  UserRound,
  Webhook,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Markdown } from "@/components/Markdown";
import { MarkdownBrainEditor } from "@/components/MarkdownBrainEditor";
import {
  StepCloudRuntimeControls,
  StepRuntimePicker,
  type WorkflowStepPatch,
} from "@/components/WorkflowModelControls";
import {
  archiveHeadlessWorkflow,
  runHeadlessWorkflowNow,
  updateHeadlessWorkflow,
} from "@/lib/headless-automation-commands";
import type { WorkflowDetail } from "@/lib/headless-automation-types";
import type { SkillCatalogItem } from "@/lib/skills";
import { supportedTimezones, timezoneLabel } from "@/lib/timezones";
import {
  loadWorkflowEventFilterOptions,
  type WorkflowEventFilterOptionsResult,
} from "@/lib/workflow-event-filters";
import type { WorkflowEventProviderOption } from "@/lib/workflow-event-triggers";
import { workflowEventProvidersReady } from "@/lib/workflow-event-triggers";
import {
  isWorkflowCloudRuntime,
  normalizeWorkflowReasoningEffort,
  normalizeWorkflowRuntimeModel,
  WORKFLOW_MODEL_OPTIONS,
} from "@/lib/workflow-model-options";
import {
  DEFAULT_WORKFLOW_SCHEDULE_CRON,
  DEFAULT_WORKFLOW_SCHEDULE_PROMPT,
  DEFAULT_WORKFLOW_SCHEDULE_TIMEZONE,
} from "@/lib/workflow-schedule-defaults";

const AUTOSAVE_DELAY_MS = 1200;
// Stable identity so the autosave effect is not re-run — and its error banner cleared — on every
// render of a workflow whose providers were never passed.
const NO_EVENT_PROVIDERS: WorkflowEventProviderOption[] = [];

type WorkflowStatus = WorkflowDetail["status"];
type WorkflowStep = WorkflowDetail["steps"][number];
type WorkflowTriggerDraft =
  | {
      id: string;
      type: "event";
      provider: string;
      event: string;
      integrationId: string;
      filters: Record<
        string,
        { id: string; name: string; key?: string; metadata?: Record<string, string> }
      >;
      prompt: string;
    }
  | {
      id: string;
      type: "schedule";
      cron: string;
      timezone: string;
      prompt: string;
      enabled: boolean;
    };
type WorkflowEventTriggerDraft = Extract<WorkflowTriggerDraft, { type: "event" }>;
type WorkflowDraft = Pick<WorkflowDetail, "name" | "description" | "status" | "steps"> & {
  triggers: WorkflowTriggerDraft[];
};
type SaveState = "saved" | "saving" | "error";

export function WorkflowEditor({
  workflow,
  workspaceId,
  canEdit,
  skillCatalog,
  eventProviders = NO_EVENT_PROVIDERS,
  owner,
}: {
  workflow: WorkflowDetail;
  workspaceId: string;
  canEdit: boolean;
  skillCatalog: SkillCatalogItem[];
  eventProviders?: WorkflowEventProviderOption[];
  owner: { name: string; avatarUrl: string | null };
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<WorkflowDraft>(() => workflowDraft(workflow));
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isRunning, startRunning] = useTransition();
  const [isArchiving, startArchiving] = useTransition();
  const draftRef = useRef(draft);
  const versionRef = useRef(workflow.version);
  const mountedRef = useRef(true);
  const autosaveRef = useRef({
    savedValue: serializeWorkflowDraft(draft),
    failedValue: null as string | null,
    inFlight: false,
    sequence: 0,
  });

  const eventProvidersRef = useRef(eventProviders);
  useEffect(() => {
    draftRef.current = draft;
    eventProvidersRef.current = eventProviders;
  }, [draft, eventProviders]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const saveLatest = useCallback(
    async function saveLatestDraft() {
      const autosave = autosaveRef.current;
      const snapshot = draftRef.current;
      if (!workflowDraftReadyToSave(snapshot, eventProvidersRef.current)) return;
      const value = serializeWorkflowDraft(snapshot);
      if (value === autosave.savedValue) return;
      if (autosave.inFlight) return;

      autosave.inFlight = true;
      const sequence = ++autosave.sequence;
      setSaveState("saving");
      setSaveError(null);

      let result: { ok: true } | { ok: false; message: string };
      try {
        const saved = await updateHeadlessWorkflow(workflow.id, {
          expectedVersion: versionRef.current,
          name: snapshot.name,
          description: snapshot.description,
          steps: snapshot.steps,
          status: snapshot.status,
          trigger: legacyWorkflowTrigger(snapshot.triggers[0]),
          triggers: snapshot.triggers.map(workflowTriggerInput),
        });
        versionRef.current = saved.version;
        result = { ok: true };
      } catch (error) {
        result = { ok: false, message: workflowCommandError(error, "saved") };
      }

      if (!mountedRef.current || sequence !== autosave.sequence) return;
      autosave.inFlight = false;
      const latestValue = serializeWorkflowDraft(draftRef.current);
      if (result.ok) {
        autosave.savedValue = value;
        autosave.failedValue = null;
        router.refresh();
      } else {
        autosave.failedValue = value;
        if (latestValue === value) {
          setSaveState("error");
          setSaveError(result.message);
        }
      }

      const shouldSaveLatest =
        latestValue !== autosave.savedValue && latestValue !== autosave.failedValue;
      if (shouldSaveLatest) {
        setSaveState("saving");
        void saveLatestDraft();
        return;
      }
      if (latestValue === autosave.savedValue) {
        setSaveState("saved");
        setSaveError(null);
      }
    },
    [router, workflow.id],
  );

  useEffect(() => {
    if (!canEdit) return;
    if (!workflowDraftReadyToSave(draft, eventProvidersRef.current)) {
      setSaveState("saved");
      setSaveError(null);
      return;
    }
    const value = serializeWorkflowDraft(draft);
    const autosave = autosaveRef.current;
    if (value === autosave.savedValue) {
      setSaveState("saved");
      setSaveError(null);
      return;
    }
    if (value === autosave.failedValue) return;

    setSaveState("saving");
    setSaveError(null);
    const timer = setTimeout(() => {
      void saveLatest();
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [canEdit, draft, saveLatest]);

  const patch = (partial: Partial<WorkflowDraft>) => {
    if (!canEdit) return;
    setDraft((current) => workflowDraftWithStatus({ ...current, ...partial }));
  };

  const updateStep = (id: string, partial: WorkflowStepPatch) => {
    if (!canEdit) return;
    setDraft((current) =>
      workflowDraftWithStatus({
        ...current,
        steps: current.steps.map((step) =>
          step.id === id ? workflowStepWithPatch(step, partial) : step,
        ),
      }),
    );
  };

  const archive = () => {
    if (!canEdit || isRunning) return;
    setSaveError(null);
    startArchiving(async () => {
      try {
        await archiveHeadlessWorkflow(workflow.id, { expectedVersion: versionRef.current });
        router.push("/workflows");
      } catch (error) {
        setSaveError(workflowCommandError(error, "archived"));
      }
    });
  };

  const runNow = () => {
    setSaveError(null);
    startRunning(async () => {
      try {
        const result = await runHeadlessWorkflowNow(workflow.id, { scopeKey: workspaceId });
        router.push(`/tasks/${encodeURIComponent(result.task.displayId)}`);
      } catch (error) {
        setSaveError(workflowCommandError(error, "run"));
      }
    });
  };

  const activationDisabledReason = workflowActivationDisabledReason(draft.steps);
  const runDisabledReason = workflowRunDisabledReason({
    canEdit,
    draft,
    saveState,
  });
  const runActionDisabledReason = isArchiving
    ? "Wait for the archive action to finish before running."
    : runDisabledReason;

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
          <Link
            href="/workflows"
            prefetch
            className="shrink-0 rounded-md px-1.5 py-1 text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            Workflows
          </Link>
          <ChevronRight size={13} className="shrink-0 text-ink-faint" />
          <span className="truncate font-medium text-ink">{draft.name || "Untitled workflow"}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SaveIndicator state={saveState} canEdit={canEdit} onRetry={saveLatest} />
          {canEdit ? (
            <button
              type="button"
              disabled={isRunning || runActionDisabledReason !== null}
              title={runActionDisabledReason ?? "Test this workflow"}
              onClick={runNow}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink shadow-sm transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRunning ? (
                <Loader2 size={13} strokeWidth={2} className="animate-spin" />
              ) : (
                <Play size={13} strokeWidth={2} />
              )}
              {isRunning ? "Starting…" : "Test"}
            </button>
          ) : null}
          {canEdit ? (
            <EditorMoreMenu
              onArchive={archive}
              isArchiving={isArchiving}
              saveInProgress={saveState === "saving" || isRunning}
            />
          ) : null}
        </div>
      </div>
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[780px] flex-col gap-8 pb-28 pt-10 sm:pt-14">
          {saveError ? (
            <p className="text-[12px] text-warning" role="alert">
              {saveError}
            </p>
          ) : null}

          <header className="flex flex-col gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <InlineTitle
                value={draft.name}
                onChange={(name) => patch({ name })}
                readOnly={!canEdit}
              />
              <InlineSummary
                value={draft.description}
                onChange={(description) => patch({ description })}
                readOnly={!canEdit}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPicker
                value={draft.status}
                activationDisabledReason={activationDisabledReason}
                onChange={(status) => patch({ status })}
                disabled={!canEdit}
              />
              <span className="text-ink-faint">·</span>
              <span className="inline-flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-subtle">
                <UserRound size={14} strokeWidth={1.8} />
                Owner
                <span className="truncate font-medium text-ink">{owner.name}</span>
              </span>
            </div>
          </header>

          <TriggerSection
            triggers={draft.triggers}
            canEdit={canEdit}
            eventProviders={eventProviders}
            onChange={(triggers) => patch({ triggers })}
          />

          <div className="flex flex-col gap-5">
            {draft.steps.map((step, index) => (
              <StepCard
                key={step.id}
                index={index}
                step={step}
                canEdit={canEdit}
                skillCatalog={skillCatalog}
                onChange={(partial) => updateStep(step.id, partial)}
              />
            ))}
            {!canEdit ? (
              <p className="text-[12.5px] leading-5 text-ink-subtle">
                Only workspace admins can edit workflows.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}

function InlineTitle({
  value,
  onChange,
  readOnly,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (readOnly) {
    return (
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-ink">
        {value.trim() || "Untitled workflow"}
      </h1>
    );
  }
  if (editing) {
    return (
      // biome-ignore lint/a11y/noAutofocus: focus the title when it flips to edit
      <input
        autoFocus
        value={value}
        maxLength={120}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            setEditing(false);
          }
        }}
        placeholder="Untitled workflow"
        className="-mx-1 w-full rounded-md bg-transparent px-1 text-[28px] font-semibold leading-tight tracking-tight text-ink outline-none placeholder:text-ink-faint"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="-mx-1 w-fit max-w-full rounded-md px-1 text-left text-[28px] font-semibold leading-tight tracking-tight text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      {value.trim() ? value : <span className="text-ink-faint">Untitled workflow</span>}
    </button>
  );
}

function InlineSummary({
  value,
  onChange,
  readOnly,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
}) {
  if (readOnly) {
    return value.trim() ? <p className="text-[14.5px] leading-6 text-ink-subtle">{value}</p> : null;
  }
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="Add a short summary..."
      className="-mx-1 w-full rounded-md bg-transparent px-1 text-[14.5px] leading-6 text-ink-subtle outline-none placeholder:text-ink-faint"
    />
  );
}

function StatusPicker({
  value,
  activationDisabledReason,
  onChange,
  disabled,
}: {
  value: WorkflowStatus;
  activationDisabledReason: string | null;
  onChange: (value: WorkflowStatus) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger
        type="button"
        disabled={disabled}
        aria-label={`Status: ${value === "active" ? "Active" : "Draft"}`}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-default disabled:hover:bg-surface data-[popup-open]:bg-surface-hover"
      >
        <StatusDot status={value} />
        {value === "active" ? "Active" : "Draft"}
        {disabled ? null : <ChevronDown size={12} strokeWidth={2} className="text-ink-subtle" />}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-[176px] bg-surface p-1 text-ink">
        {(["draft", "active"] as const).map((option) => (
          <button
            key={option}
            type="button"
            disabled={option === "active" && activationDisabledReason !== null}
            onClick={() => {
              onChange(option);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink transition-colors duration-150 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <StatusDot status={option} />
            <span className="flex-1">{option === "active" ? "Active" : "Draft"}</span>
            {value === option ? <Check size={13} strokeWidth={2} className="text-ink" /> : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function StatusDot({ status }: { status: WorkflowStatus }) {
  return (
    <span
      aria-hidden="true"
      className={`h-1.5 w-1.5 rounded-full ${status === "active" ? "bg-success" : "bg-ink-faint"}`}
    />
  );
}

function TriggerSection({
  triggers,
  canEdit,
  eventProviders,
  onChange,
}: {
  triggers: WorkflowTriggerDraft[];
  canEdit: boolean;
  eventProviders: WorkflowEventProviderOption[];
  onChange: (triggers: WorkflowTriggerDraft[]) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Triggers</SectionLabel>
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        {triggers.length === 0 ? (
          <div className="flex items-center gap-3 px-4 py-4 text-[13px] text-ink-subtle">
            <Clock size={16} strokeWidth={1.8} />
            This workflow only runs when you test it manually.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {triggers.map((trigger) => (
              <WorkflowTriggerRow
                key={trigger.id}
                trigger={trigger}
                canEdit={canEdit}
                eventProviders={eventProviders}
                onChange={(next) =>
                  onChange(
                    triggers.map((candidate) => (candidate.id === next.id ? next : candidate)),
                  )
                }
                onRemove={() =>
                  onChange(triggers.filter((candidate) => candidate.id !== trigger.id))
                }
              />
            ))}
          </div>
        )}
        {canEdit ? (
          <div className="border-t border-border px-3 py-2.5">
            <AddTriggerMenu
              eventProviders={eventProviders}
              onAdd={(trigger) => onChange([...triggers, trigger])}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function WorkflowTriggerRow({
  trigger,
  canEdit,
  eventProviders,
  onChange,
  onRemove,
}: {
  trigger: WorkflowTriggerDraft;
  canEdit: boolean;
  eventProviders: WorkflowEventProviderOption[];
  onChange: (trigger: WorkflowTriggerDraft) => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(trigger.type === "event");
  const provider =
    trigger.type === "event"
      ? eventProviders.find((candidate) => candidate.provider === trigger.provider)
      : null;
  const event =
    trigger.type === "event"
      ? provider?.events.find((candidate) => candidate.id === trigger.event)
      : null;
  const summary =
    trigger.type === "schedule"
      ? scheduleSummary({ cron: trigger.cron, timezone: trigger.timezone })
      : `${provider?.label ?? trigger.provider} · ${event?.label ?? trigger.event}`;

  return (
    <div>
      <div className="group flex items-center gap-3 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-canvas text-ink-subtle">
          {trigger.type === "schedule" ? (
            <CalendarClock size={15} strokeWidth={1.8} />
          ) : (
            <Webhook size={15} strokeWidth={1.8} />
          )}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 flex-col items-start rounded-md text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <span className="text-[13px] font-medium text-ink">
            {trigger.type === "schedule" ? "On a schedule" : "When an event happens"}
          </span>
          <span className="truncate text-[12px] text-ink-subtle">{summary}</span>
        </button>
        <ChevronDown
          size={14}
          className={`shrink-0 text-ink-faint transition-transform ${expanded ? "rotate-180" : ""}`}
        />
        {canEdit ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${trigger.type} trigger`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-subtle opacity-0 transition-all hover:bg-danger/10 hover:text-danger focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 group-hover:opacity-100"
          >
            <Trash2 size={14} strokeWidth={1.8} />
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div className="border-t border-border bg-canvas/40 px-4 pb-4 pt-3">
          {trigger.type === "schedule" ? (
            <ScheduleFrequencyBuilder
              cron={trigger.cron}
              timezone={trigger.timezone}
              canEdit={canEdit}
              onCronChange={(cron) => onChange({ ...trigger, cron })}
              onTimezoneChange={(timezone) => onChange({ ...trigger, timezone })}
            />
          ) : (
            <EventTriggerEditor
              trigger={trigger}
              providers={eventProviders}
              canEdit={canEdit}
              onChange={onChange}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

function AddTriggerMenu({
  eventProviders,
  onAdd,
}: {
  eventProviders: WorkflowEventProviderOption[];
  onAdd: (trigger: WorkflowTriggerDraft) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const provider = eventProviders.find((candidate) => candidate.provider === selectedProvider);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredProviders = eventProviders.filter(
    (candidate) =>
      !normalizedQuery ||
      candidate.label.toLowerCase().includes(normalizedQuery) ||
      candidate.events.some((event) => event.label.toLowerCase().includes(normalizedQuery)),
  );
  const close = () => {
    setOpen(false);
    setQuery("");
    setSelectedProvider(null);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <Plus size={14} strokeWidth={2} />
        Add trigger
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-[340px] bg-surface p-0 text-ink">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          {provider ? (
            <button
              type="button"
              onClick={() => setSelectedProvider(null)}
              aria-label="Back to trigger types"
              className="rounded-md p-1 text-ink-subtle hover:bg-surface-hover hover:text-ink"
            >
              <ChevronRight size={14} className="rotate-180" />
            </button>
          ) : (
            <Search size={14} className="text-ink-faint" />
          )}
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={provider ? `Search ${provider.label} events` : "Search triggers"}
            aria-label="Search triggers"
            className="h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-faint"
          />
        </div>
        <div className="max-h-[320px] overflow-y-auto p-1.5">
          {provider ? (
            <TriggerEventOptions
              provider={provider}
              query={normalizedQuery}
              onSelect={(eventId, integrationId) => {
                onAdd({
                  id: newWorkflowTriggerId(),
                  type: "event",
                  provider: provider.provider,
                  event: eventId,
                  integrationId,
                  filters: {},
                  prompt: DEFAULT_WORKFLOW_SCHEDULE_PROMPT,
                });
                close();
              }}
            />
          ) : (
            <TriggerTypeOptions
              providers={filteredProviders}
              query={normalizedQuery}
              onSchedule={() => {
                onAdd({
                  id: newWorkflowTriggerId(),
                  type: "schedule",
                  cron: DEFAULT_WORKFLOW_SCHEDULE_CRON,
                  timezone: DEFAULT_WORKFLOW_SCHEDULE_TIMEZONE,
                  prompt: DEFAULT_WORKFLOW_SCHEDULE_PROMPT,
                  enabled: true,
                });
                close();
              }}
              onProvider={(providerName) => {
                setSelectedProvider(providerName);
                setQuery("");
              }}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TriggerTypeOptions({
  providers,
  query,
  onSchedule,
  onProvider,
}: {
  providers: WorkflowEventProviderOption[];
  query: string;
  onSchedule: () => void;
  onProvider: (provider: string) => void;
}) {
  return (
    <>
      {!query || "scheduled".includes(query) ? (
        <button
          type="button"
          onClick={onSchedule}
          className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-hover"
        >
          <CalendarClock size={15} className="text-ink-subtle" />
          <span className="flex-1 text-[13px] font-medium">Scheduled</span>
          <ChevronRight size={14} className="text-ink-faint" />
        </button>
      ) : null}
      {providers.map((provider) => (
        <button
          key={provider.provider}
          type="button"
          onClick={() => onProvider(provider.provider)}
          className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-hover"
        >
          <Webhook size={15} className="text-ink-subtle" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{provider.label}</span>
          <ChevronRight size={14} className="text-ink-faint" />
        </button>
      ))}
      {!workflowEventProvidersReady(providers) && !query ? (
        <EventTriggerZeroState providers={providers} />
      ) : null}
    </>
  );
}

function TriggerEventOptions({
  provider,
  query,
  onSelect,
}: {
  provider: WorkflowEventProviderOption;
  query: string;
  onSelect: (eventId: string, integrationId: string) => void;
}) {
  const account = provider.accounts[0];
  return provider.events
    .filter((event) => !query || event.label.toLowerCase().includes(query))
    .map((event) => (
      <button
        key={event.id}
        type="button"
        disabled={!account}
        onClick={() => account && onSelect(event.id, account.integrationId)}
        className="flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Webhook size={15} className="mt-0.5 shrink-0 text-ink-subtle" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">{event.label}</span>
          <span className="block text-[11.5px] text-ink-subtle">
            {account ? event.description : `Connect ${provider.label} first`}
          </span>
        </span>
      </button>
    ));
}

// Nothing to trigger on yet. Point at the nearest missing step rather than a generic "connect an
// integration": a provider with events switched on but no account needs a different link than one
// that is connected with every event still off.
function EventTriggerZeroState({ providers }: { providers: WorkflowEventProviderOption[] }) {
  const connectable = providers.find((provider) => provider.accounts.length === 0);
  return (
    <p className="mt-3 text-[12px] text-ink-subtle">
      {connectable ? (
        <>
          <Link
            href={connectable.accountHref}
            className="underline underline-offset-2 hover:text-ink"
          >
            {connectable.accountLabel}
          </Link>{" "}
          to trigger workflows from {connectable.label} activity.
        </>
      ) : (
        <>
          Turn on an event in{" "}
          <Link href="/settings/plugins" className="underline underline-offset-2 hover:text-ink">
            plugin settings
          </Link>{" "}
          to trigger workflows from your connected tools.
        </>
      )}
    </p>
  );
}

function EventTriggerEditor({
  trigger,
  providers,
  canEdit,
  onChange,
}: {
  trigger: WorkflowEventTriggerDraft;
  providers: WorkflowEventProviderOption[];
  canEdit: boolean;
  onChange: (trigger: WorkflowTriggerDraft) => void;
}) {
  const provider = providers.find((candidate) => candidate.provider === trigger.provider);
  const selectedEvent = provider?.events.find((event) => event.id === trigger.event);
  // A workflow can outlive the event it subscribed to: the plugin can be updated, the event
  // switched back off, or its account disconnected. Keep the selection visible and editable
  // instead of silently retargeting it, but never offer a choice that cannot be bound.
  const accounts = provider?.accounts ?? [];
  const accountOptions = accounts.some((account) => account.integrationId === trigger.integrationId)
    ? accounts
    : [
        {
          integrationId: trigger.integrationId,
          label: `Disconnected ${provider?.label ?? trigger.provider} account`,
        },
        ...accounts,
      ];

  return (
    <div className="mt-3 flex flex-col gap-3">
      <p className="text-[12px] leading-5 text-ink-subtle">
        {selectedEvent?.description ??
          "This workflow uses an event that is no longer available. Pick another one to keep it running."}
      </p>
      {accounts.length === 0 ? (
        <p className="text-[12px] text-warning">
          This {provider?.label ?? trigger.provider} account is disconnected.{" "}
          <Link
            href={provider?.accountHref ?? "/settings/plugins"}
            className="underline underline-offset-2"
          >
            {provider?.accountLabel ?? "Connect an account"}
          </Link>
          .
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-subtle">Plugin</span>
          <select
            aria-label="Plugin"
            value={trigger.provider}
            disabled={!canEdit}
            onChange={(changed) => {
              const next = providers.find(
                (candidate) => candidate.provider === changed.target.value,
              );
              if (!next?.events[0] || !next.accounts[0]) return;
              onChange({
                ...trigger,
                provider: next.provider,
                event: next.events[0].id,
                integrationId: next.accounts[0].integrationId,
                filters: {},
              });
            }}
            className="h-8 rounded-lg border border-border bg-canvas px-2.5 text-[12.5px] text-ink outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-70"
          >
            {provider ? null : (
              <option value={trigger.provider}>{trigger.provider} (unavailable)</option>
            )}
            {providers.map((candidate) => (
              <option
                key={candidate.provider}
                value={candidate.provider}
                disabled={candidate.accounts.length === 0}
              >
                {candidate.label}
                {candidate.accounts.length ? "" : " · Connect account"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-subtle">Event</span>
          <select
            aria-label="Event"
            value={trigger.event}
            disabled={!canEdit}
            onChange={(changed) =>
              onChange({ ...trigger, event: changed.target.value, filters: {} })
            }
            className="h-8 rounded-lg border border-border bg-canvas px-2.5 text-[12.5px] text-ink outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-70"
          >
            {selectedEvent ? null : (
              <option value={trigger.event}>{unavailableEventLabel(trigger.event)}</option>
            )}
            {(provider?.events ?? []).map((event) => (
              <option key={event.id} value={event.id}>
                {event.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-subtle">
            {provider?.label ?? "Provider"} account
          </span>
          <select
            aria-label="Event account"
            value={trigger.integrationId}
            disabled={!canEdit}
            onChange={(changed) =>
              onChange({ ...trigger, integrationId: changed.target.value, filters: {} })
            }
            className="h-8 rounded-lg border border-border bg-canvas px-2.5 text-[12.5px] text-ink outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-70"
          >
            {accountOptions.map((account) => (
              <option key={account.integrationId} value={account.integrationId}>
                {account.label}
              </option>
            ))}
          </select>
        </label>
        {(selectedEvent?.filters ?? []).map((filter: PluginEventFilterDefinitionDto) => (
          <EventFilterPicker
            key={filter.id}
            filter={filter}
            trigger={trigger}
            provider={provider ?? null}
            canEdit={canEdit}
            onChange={onChange}
          />
        ))}
      </div>
      <WorkflowRunContext
        prompt={trigger.prompt}
        canEdit={canEdit}
        onChange={(prompt) => onChange({ ...trigger, prompt })}
      />
    </div>
  );
}

function EventFilterPicker({
  filter,
  trigger,
  provider: providerOption,
  canEdit,
  onChange,
}: {
  filter: PluginEventFilterDefinitionDto;
  trigger: WorkflowEventTriggerDraft;
  provider: WorkflowEventProviderOption | null;
  canEdit: boolean;
  onChange: (trigger: WorkflowTriggerDraft) => void;
}) {
  const { provider, event, integrationId } = trigger;
  const [state, setState] = useState<{
    key: string;
    result: WorkflowEventFilterOptionsResult;
  } | null>(null);
  const resourceType = filter.kind === "integration_resource" ? filter.resourceType : null;
  const key = `${provider}:${event}:${integrationId}:${resourceType}`;

  useEffect(() => {
    if (!resourceType) return;
    let cancelled = false;
    void loadWorkflowEventFilterOptions({
      provider,
      resourceType,
      integrationId,
      event,
    })
      .then((result) => {
        if (!cancelled) setState({ key, result });
      })
      .catch(() => {
        if (!cancelled)
          setState({
            key,
            result: { ok: false, error: "Could not load event filters. Try again." },
          });
      });
    return () => {
      cancelled = true;
    };
  }, [event, resourceType, integrationId, key, provider]);

  const result: WorkflowEventFilterOptionsResult | null =
    filter.kind === "choice"
      ? { ok: true, options: filter.options }
      : state?.key === key
        ? state.result
        : null;
  const selected = trigger.filters[filter.id] ?? null;
  // Keep a saved value selectable while options load, and after it disappears from the provider.
  const options =
    result?.ok && (!selected || result.options.some((option) => option.id === selected.id))
      ? result.options
      : result?.ok
        ? [selected as NonNullable<typeof selected>, ...result.options]
        : selected
          ? [selected]
          : [];

  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[12px] font-medium text-ink-subtle">{filter.label}</span>
      <select
        aria-label={filter.label}
        value={selected?.id ?? ""}
        disabled={!canEdit || !result?.ok}
        onChange={(changed) => {
          const next = options.find((option) => option.id === changed.target.value);
          if (!next) {
            onChange({
              ...trigger,
              filters: Object.fromEntries(
                Object.entries(trigger.filters).filter(([id]) => id !== filter.id),
              ),
            });
            return;
          }
          onChange({
            ...trigger,
            filters: {
              ...trigger.filters,
              [filter.id]: {
                id: next.id,
                name: next.name,
                ...(next.key ? { key: next.key } : {}),
                ...(next.metadata ? { metadata: next.metadata } : {}),
              },
            },
          });
        }}
        className="h-8 rounded-lg border border-border bg-canvas px-2.5 text-[12.5px] text-ink outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-70"
      >
        <option value="">
          {filter.required ? `Select a ${filter.label.toLowerCase()}…` : "Any"}
        </option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.key ? `${option.key} · ` : ""}
            {option.name}
          </option>
        ))}
      </select>
      {result && !result.ok ? (
        // The provider rejected the read — most often a revoked token — so send the author to the
        // account rather than leaving them with an error they cannot act on.
        <span className="text-[11.5px] text-warning">
          {result.error}{" "}
          <Link
            href={providerOption?.accountHref ?? "/settings/plugins"}
            className="underline underline-offset-2"
          >
            {providerOption ? `Open ${providerOption.label} settings` : "Open plugin settings"}
          </Link>
          .
        </span>
      ) : null}
      {result?.ok && result.partial ? (
        <span className="text-[11.5px] text-warning">
          Some {filter.label.toLowerCase()} details could not be loaded. Refresh to try again.
        </span>
      ) : null}
      {result?.ok && result.options.length === 0 ? (
        <span className="text-[11.5px] text-warning">
          No {filter.label.toLowerCase()} options are available for this account.
        </span>
      ) : null}
    </label>
  );
}

function unavailableEventLabel(event: string) {
  return event === "issue_enters_triage"
    ? "Issue enters triage (legacy)"
    : `${event} (unavailable)`;
}

function WorkflowRunContext({
  prompt,
  canEdit,
  onChange,
}: {
  prompt: string;
  canEdit: boolean;
  onChange: (prompt: string) => void;
}) {
  const value = prompt === DEFAULT_WORKFLOW_SCHEDULE_PROMPT ? "" : prompt;
  const [open, setOpen] = useState(() => Boolean(value.trim()));
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] leading-5 text-ink-subtle">
        Each run follows the instructions in your steps.
      </p>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-fit items-center gap-1.5 rounded-md text-[12px] text-ink-subtle hover:text-ink focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <ChevronDown size={12} className={open ? "rotate-180" : ""} />
        Additional run context (optional)
      </button>
      {open ? (
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-subtle">Run context</span>
          <textarea
            value={value}
            readOnly={!canEdit}
            onChange={(event) => onChange(event.target.value)}
            rows={3}
            placeholder="Extra context shared across steps, such as a region or reporting period."
            className="min-h-20 resize-y rounded-lg border border-border bg-canvas px-2.5 py-2 text-[13px] leading-5 text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:ring-1 focus-visible:ring-ink/20 read-only:opacity-70"
          />
        </label>
      ) : null}
    </div>
  );
}

type ScheduleFrequency = AgentSchedulePreset["kind"] | "custom";

const SCHEDULE_FREQUENCY_OPTIONS: { value: ScheduleFrequency; label: string }[] = [
  { value: "minutes", label: "Every few minutes" },
  { value: "hours", label: "Every few hours" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every weekday (Mon–Fri)" },
  { value: "weekly", label: "Every week" },
  { value: "custom", label: "Custom (cron expression)" },
];

const SCHEDULE_WEEKDAY_OPTIONS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

function ScheduleFrequencyBuilder({
  cron,
  timezone,
  canEdit,
  onCronChange,
  onTimezoneChange,
}: {
  cron: string;
  timezone: string;
  canEdit: boolean;
  onCronChange: (cron: string) => void;
  onTimezoneChange: (timezone: string) => void;
}) {
  const preset = schedulePresetFromCron(cron);
  const [customOverride, setCustomOverride] = useState(false);
  const frequency: ScheduleFrequency = customOverride ? "custom" : (preset?.kind ?? "custom");

  const applyFrequency = (next: ScheduleFrequency) => {
    if (next === "custom") {
      setCustomOverride(true);
      return;
    }
    setCustomOverride(false);
    onCronChange(cronForSchedulePreset(defaultSchedulePreset(next, preset)));
  };

  const hour = preset && "hour" in preset ? preset.hour : 9;
  const minute = preset && "minute" in preset ? preset.minute : 0;
  const dayOfWeek = preset?.kind === "weekly" ? preset.dayOfWeek : 1;
  const interval =
    preset?.kind === "minutes"
      ? preset.interval
      : preset?.kind === "hours"
        ? preset.interval
        : null;

  const setTime = (value: string) => {
    if (!preset || preset.kind === "minutes" || preset.kind === "hours") return;
    const [nextHour, nextMinute] = parseTimeValue(value);
    onCronChange(
      cronForSchedulePreset(
        preset.kind === "weekly"
          ? { kind: "weekly", dayOfWeek: preset.dayOfWeek, hour: nextHour, minute: nextMinute }
          : { kind: preset.kind, hour: nextHour, minute: nextMinute },
      ),
    );
  };

  const setDayOfWeek = (value: number) => {
    onCronChange(cronForSchedulePreset({ kind: "weekly", dayOfWeek: value, hour, minute }));
  };

  const setInterval = (value: number) => {
    if (frequency !== "minutes" && frequency !== "hours") return;
    onCronChange(cronForSchedulePreset({ kind: frequency, interval: value }));
  };

  const summaryText = scheduleSummary({ cron, timezone });

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-subtle">Frequency</span>
          <select
            value={frequency}
            disabled={!canEdit}
            onChange={(event) => applyFrequency(event.target.value as ScheduleFrequency)}
            className="h-8 rounded-lg border border-border bg-canvas px-2.5 text-[12.5px] text-ink outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-70"
          >
            {SCHEDULE_FREQUENCY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-subtle">Timezone</span>
          <select
            value={timezone}
            disabled={!canEdit}
            onChange={(event) => onTimezoneChange(event.target.value)}
            className="h-8 rounded-lg border border-border bg-canvas px-2.5 text-[12.5px] text-ink outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-70"
          >
            {timezoneOptions(timezone).map((option) => (
              <option key={option} value={option}>
                {timezoneLabel(option)}
              </option>
            ))}
          </select>
        </label>

        {frequency === "minutes" || frequency === "hours" ? (
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-subtle">Every</span>
            {frequency === "hours" ? (
              <select
                value={interval ?? 1}
                disabled={!canEdit}
                onChange={(event) => setInterval(Number.parseInt(event.target.value, 10))}
                className="h-8 rounded-lg border border-border bg-canvas px-2.5 text-[12.5px] text-ink outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-70"
              >
                {SUPPORTED_HOUR_INTERVALS.map((value) => (
                  <option key={value} value={value}>
                    {value} {value === 1 ? "hour" : "hours"}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="number"
                min={1}
                max={59}
                value={interval ?? 15}
                readOnly={!canEdit}
                onChange={(event) => setInterval(Number.parseInt(event.target.value, 10) || 1)}
                className="h-8 rounded-lg border border-border bg-canvas px-2.5 text-[12.5px] text-ink outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ink/20 read-only:opacity-70"
              />
            )}
          </label>
        ) : null}

        {frequency === "weekly" ? (
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-subtle">Day</span>
            <select
              value={dayOfWeek}
              disabled={!canEdit}
              onChange={(event) => setDayOfWeek(Number.parseInt(event.target.value, 10))}
              className="h-8 rounded-lg border border-border bg-canvas px-2.5 text-[12.5px] text-ink outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-70"
            >
              {SCHEDULE_WEEKDAY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {frequency === "daily" || frequency === "weekdays" || frequency === "weekly" ? (
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-subtle">At</span>
            <input
              type="time"
              value={formatTimeValue(hour, minute)}
              readOnly={!canEdit}
              onChange={(event) => setTime(event.target.value)}
              className="h-8 rounded-lg border border-border bg-canvas px-2.5 text-[12.5px] text-ink outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ink/20 read-only:opacity-70"
            />
          </label>
        ) : null}

        {frequency === "custom" ? (
          <label className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
            <span className="text-[12px] font-medium text-ink-subtle">Cron</span>
            <input
              value={cron}
              readOnly={!canEdit}
              onChange={(event) => onCronChange(event.target.value)}
              placeholder={DEFAULT_WORKFLOW_SCHEDULE_CRON}
              className="h-8 rounded-lg border border-border bg-canvas px-2.5 font-mono text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:ring-1 focus-visible:ring-ink/20 read-only:opacity-70"
            />
          </label>
        ) : null}
      </div>

      <p className="text-[12px] text-ink-subtle">
        {summaryText === "Unsupported schedule"
          ? `Enter a 5-field cron expression, e.g. "${DEFAULT_WORKFLOW_SCHEDULE_CRON}".`
          : `Runs ${summaryText.toLowerCase()} · ${timezone}`}
      </p>
    </div>
  );
}

function timezoneOptions(current: string) {
  const options = supportedTimezones();
  return options.includes(current) ? options : [current, ...options];
}

function formatTimeValue(hour: number, minute: number) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseTimeValue(value: string): [number, number] {
  const [hour, minute] = value.split(":").map((part) => Number.parseInt(part, 10));
  return [Number.isFinite(hour) ? hour! : 9, Number.isFinite(minute) ? minute! : 0];
}

function defaultSchedulePreset(
  kind: Exclude<ScheduleFrequency, "custom">,
  previous: AgentSchedulePreset | null,
): AgentSchedulePreset {
  const hour = previous && "hour" in previous ? previous.hour : 9;
  const minute = previous && "minute" in previous ? previous.minute : 0;
  const dayOfWeek = previous?.kind === "weekly" ? previous.dayOfWeek : 1;

  if (kind === "minutes") {
    return { kind, interval: previous?.kind === "minutes" ? previous.interval : 15 };
  }
  if (kind === "hours") {
    return { kind, interval: previous?.kind === "hours" ? previous.interval : 1 };
  }
  if (kind === "weekly") return { kind, hour, minute, dayOfWeek };
  return { kind, hour, minute };
}

function StepCard({
  index,
  step,
  canEdit,
  skillCatalog,
  onChange,
}: {
  index: number;
  step: WorkflowStep;
  canEdit: boolean;
  skillCatalog: SkillCatalogItem[];
  onChange: (partial: WorkflowStepPatch) => void;
}) {
  const selectedRuntime = WORKFLOW_MODEL_OPTIONS.find((option) => option.token === step.model);
  const cloudRuntime =
    selectedRuntime && isWorkflowCloudRuntime(selectedRuntime.engine)
      ? selectedRuntime.engine
      : null;

  const updateRuntime = (model: string) => {
    const option = WORKFLOW_MODEL_OPTIONS.find((candidate) => candidate.token === model);
    if (!option || !isWorkflowCloudRuntime(option.engine)) {
      onChange({ model, runtimeModel: undefined, reasoningEffort: undefined });
      return;
    }
    const runtimeModel = normalizeWorkflowRuntimeModel(option.engine, step.runtimeModel);
    onChange({
      model,
      runtimeModel,
      reasoningEffort: normalizeWorkflowReasoningEffort(
        option.engine,
        runtimeModel,
        step.reasoningEffort,
      ),
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>Agent instructions{index > 0 ? ` ${index + 1}` : ""}</SectionLabel>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <span className="mr-1 text-[12px] font-medium text-ink-subtle">Model</span>
          <StepRuntimePicker value={step.model} onChange={updateRuntime} disabled={!canEdit} />
          {cloudRuntime ? (
            <StepCloudRuntimeControls
              compact
              engine={cloudRuntime}
              step={step}
              disabled={!canEdit}
              onChange={onChange}
            />
          ) : null}
        </div>
      </div>
      <section className="rounded-xl border border-border bg-surface px-3.5 py-3">
        {canEdit ? (
          <MarkdownBrainEditor
            content={step.instructions}
            onChange={(instructions) => onChange({ instructions })}
            compact
            placeholder="Describe what this step should do..."
            skillMentions={skillCatalog}
          />
        ) : step.instructions.trim() ? (
          <Markdown content={step.instructions} className="text-[13.5px] leading-6 text-ink" />
        ) : (
          <p className="text-[13.5px] leading-6 text-ink-subtle/70">No content yet.</p>
        )}
      </section>
    </div>
  );
}

function SaveIndicator({
  state,
  canEdit,
  onRetry,
}: {
  state: SaveState;
  canEdit: boolean;
  onRetry: () => Promise<void>;
}) {
  if (!canEdit) {
    return <span className="px-1.5 text-[12px] text-ink-subtle">Read only</span>;
  }
  if (state === "saving") {
    return (
      <span className="flex items-center gap-1.5 px-1.5 text-[12px] text-ink-subtle">
        <Loader2 size={12} strokeWidth={2} className="animate-spin" />
        Saving…
      </span>
    );
  }
  if (state === "error") {
    return (
      <button
        type="button"
        onClick={() => void onRetry()}
        className="rounded-md px-1.5 py-1 text-[12px] font-medium text-warning transition-colors hover:bg-warning-bg focus:outline-none focus-visible:ring-1 focus-visible:ring-warning/30"
      >
        Retry save
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1.5 px-1.5 text-[12px] text-ink-subtle">
      <Check size={12} strokeWidth={2} className="text-success" />
      Saved
    </span>
  );
}

function EditorMoreMenu({
  onArchive,
  isArchiving,
  saveInProgress,
}: {
  onArchive: () => void;
  isArchiving: boolean;
  saveInProgress: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label="More"
        className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 data-[popup-open]:bg-surface-hover data-[popup-open]:text-ink"
      >
        <MoreHorizontal size={16} strokeWidth={2} />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-[180px] bg-surface p-1 text-ink">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(window.location.href).then(
              () => {
                setCopyState("copied");
                setTimeout(() => setCopyState("idle"), 1_500);
              },
              () => setCopyState("error"),
            );
            setOpen(false);
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-surface-hover"
        >
          {copyState === "copied" ? (
            <Check size={13} strokeWidth={1.9} />
          ) : (
            <Copy size={13} strokeWidth={1.9} />
          )}
          {copyState === "copied"
            ? "Copied link"
            : copyState === "error"
              ? "Copy failed"
              : "Copy link"}
        </button>
        <button
          type="button"
          disabled={isArchiving || saveInProgress}
          onClick={() => {
            setOpen(false);
            if (window.confirm("Delete this workflow? This can’t be undone.")) onArchive();
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-danger transition-colors duration-150 hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isArchiving ? (
            <Loader2 size={13} strokeWidth={1.9} className="animate-spin" />
          ) : (
            <Trash2 size={13} strokeWidth={1.9} />
          )}
          Delete workflow
        </button>
      </PopoverContent>
    </Popover>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
      {children}
    </span>
  );
}

function workflowDraft(workflow: WorkflowDetail): WorkflowDraft {
  const triggers: WorkflowTriggerDraft[] = workflow.triggers?.length
    ? workflow.triggers.map((trigger) =>
        trigger.type === "schedule"
          ? {
              id: trigger.id,
              type: "schedule",
              cron: trigger.cron,
              timezone: trigger.timezone,
              prompt: trigger.prompt,
              enabled: trigger.enabled,
            }
          : { ...trigger },
      )
    : workflow.trigger.type === "schedule"
      ? [
          {
            id: `trigger-${workflow.id}`,
            type: "schedule",
            cron: workflow.trigger.cron,
            timezone: workflow.trigger.timezone,
            prompt: workflow.trigger.prompt,
            enabled: workflow.trigger.enabled,
          },
        ]
      : workflow.trigger.type === "event"
        ? [{ id: `trigger-${workflow.id}`, ...workflow.trigger }]
        : [];
  return {
    name: workflow.name,
    description: workflow.description,
    status: workflow.status,
    steps: workflow.steps,
    triggers,
  };
}

function workflowTriggerInput(trigger: WorkflowTriggerDraft) {
  return trigger.type === "schedule"
    ? {
        id: trigger.id,
        type: "schedule" as const,
        cron: trigger.cron,
        timezone: trigger.timezone,
        prompt: trigger.prompt,
        enabled: trigger.enabled,
      }
    : { ...trigger };
}

function legacyWorkflowTrigger(trigger: WorkflowTriggerDraft | undefined) {
  if (!trigger) return { type: "manual" as const };
  if (trigger.type === "schedule") {
    return {
      type: "schedule" as const,
      cron: trigger.cron,
      timezone: trigger.timezone,
      prompt: trigger.prompt,
      enabled: trigger.enabled,
    };
  }
  return {
    type: "event" as const,
    provider: trigger.provider,
    event: trigger.event,
    integrationId: trigger.integrationId,
    filters: trigger.filters,
    prompt: trigger.prompt,
  };
}

function workflowDraftWithStatus(draft: WorkflowDraft): WorkflowDraft {
  return draft.status === "active" && workflowActivationDisabledReason(draft.steps)
    ? { ...draft, status: "draft" }
    : draft;
}

function workflowStepWithPatch(step: WorkflowStep, patch: WorkflowStepPatch): WorkflowStep {
  const next = { ...step, ...patch };
  return {
    id: next.id,
    title: next.title,
    model: next.model,
    instructions: next.instructions,
    ...(next.runtimeModel ? { runtimeModel: next.runtimeModel } : {}),
    ...(next.reasoningEffort ? { reasoningEffort: next.reasoningEffort } : {}),
  };
}

function serializeWorkflowDraft(draft: WorkflowDraft) {
  return JSON.stringify(draft);
}

// An event trigger is only worth saving once it can pass server-side validation: an account, and
// a value for every filter the declaration marks required. An event that declares no filters — or
// one the plugin no longer declares — is ready as soon as an account is picked.
function workflowDraftReadyToSave(
  draft: WorkflowDraft,
  eventProviders: readonly WorkflowEventProviderOption[],
) {
  return draft.triggers.every((trigger) => {
    if (trigger.type !== "event") return true;
    const { provider, event, integrationId, filters } = trigger;
    if (!integrationId) return false;
    if (Object.values(filters).some((filter) => !filter.id || !filter.name)) return false;
    const declaration = eventProviders
      .find((candidate) => candidate.provider === provider)
      ?.events.find((candidate) => candidate.id === event);
    // The plugin no longer declares this event, so there is nothing to check the filters against.
    // Let the save through: a server-side rejection is a visible error, silence is not.
    if (!declaration) return true;
    return declaration.filters.every(
      (filter: PluginEventFilterDefinitionDto) =>
        !filter.required || Boolean(filters[filter.id]?.id),
    );
  });
}

function newWorkflowTriggerId() {
  return `trigger-${globalThis.crypto.randomUUID()}`;
}

function workflowRunDisabledReason({
  canEdit,
  draft,
  saveState,
}: {
  canEdit: boolean;
  draft: WorkflowDraft;
  saveState: SaveState;
}) {
  if (!canEdit) return "Only workspace admins can run workflows.";
  if (draft.steps.length === 0 || draft.steps.some((step) => !step.instructions.trim())) {
    return "Add instructions to every step before running the workflow.";
  }
  if (saveState === "saving") return "Wait for the latest changes to save before running.";
  if (saveState === "error") return "Save the latest changes before running.";
  return null;
}

function workflowCommandError(error: unknown, operation: "saved" | "archived" | "run") {
  const fallback =
    operation === "run"
      ? "The workflow could not be run. Try again."
      : `The workflow could not be ${operation}. Try again.`;
  return error instanceof Error ? error.message : fallback;
}
