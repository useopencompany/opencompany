"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Clock,
  Hash,
  Loader2,
  type LucideIcon,
  MessagesSquare,
  MoreHorizontal,
  Plus,
  Sparkles,
  SquareKanban,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState, useTransition } from "react";
import { MarkdownGoatBrainEditor } from "@/components/MarkdownGoatBrainEditor";
import type { GoatSkillCatalogItem } from "@/lib/skills";
import { archiveGoatWorkflowAction, updateGoatWorkflowAction } from "@/lib/workflow-actions";
import {
  DEFAULT_GOAT_WORKFLOW_MODEL_TOKEN,
  GOAT_WORKFLOW_MODEL_OPTIONS,
} from "@/lib/workflow-model-options";
import type { GoatWorkflowDetail } from "@/lib/workflows";

const AUTOSAVE_DELAY_MS = 1200;
const MAX_WORKFLOW_STEPS = 20;

type WorkflowStatus = GoatWorkflowDetail["status"];
type WorkflowTrigger = GoatWorkflowDetail["trigger"];
type WorkflowStep = GoatWorkflowDetail["steps"][number];
type WorkflowDraft = Pick<
  GoatWorkflowDetail,
  "name" | "description" | "status" | "trigger" | "steps"
>;
type SaveState = "saved" | "saving" | "error";

type TriggerOption = {
  id: WorkflowTrigger;
  label: string;
  hint: string;
  icon: LucideIcon;
  available: boolean;
};

const MANUAL_TRIGGER: TriggerOption = {
  id: "manual",
  label: "Manual",
  hint: "Fire with # in chat",
  icon: Hash,
  available: true,
};

const TRIGGER_OPTIONS: TriggerOption[] = [
  MANUAL_TRIGGER,
  {
    id: "slack",
    label: "New Slack message",
    hint: "When a message matches",
    icon: MessagesSquare,
    available: false,
  },
  {
    id: "linear",
    label: "New Linear issue",
    hint: "When an issue is created",
    icon: SquareKanban,
    available: false,
  },
  {
    id: "schedule",
    label: "On a schedule",
    hint: "Run on a recurring cadence",
    icon: Clock,
    available: false,
  },
];

const DEFAULT_MODEL_LABEL =
  GOAT_WORKFLOW_MODEL_OPTIONS.find((option) => option.token === DEFAULT_GOAT_WORKFLOW_MODEL_TOKEN)
    ?.label ?? "Default";

export function GoatWorkflowEditor({
  workflow,
  canEdit,
  skillCatalog,
}: {
  workflow: GoatWorkflowDetail;
  canEdit: boolean;
  skillCatalog: GoatSkillCatalogItem[];
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<WorkflowDraft>(() => workflowDraft(workflow));
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isArchiving, startArchiving] = useTransition();
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const mountedRef = useRef(true);
  const autosaveRef = useRef({
    savedValue: serializeWorkflowDraft(draft),
    failedValue: null as string | null,
    inFlight: false,
    sequence: 0,
  });
  const saveLatestRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  saveLatestRef.current = async () => {
    const autosave = autosaveRef.current;
    const snapshot = draftRef.current;
    const value = serializeWorkflowDraft(snapshot);
    if (value === autosave.savedValue || value === autosave.failedValue) return;
    if (autosave.inFlight) return;

    autosave.inFlight = true;
    const sequence = ++autosave.sequence;
    setSaveState("saving");
    setSaveError(null);

    let result: Awaited<ReturnType<typeof updateGoatWorkflowAction>>;
    try {
      result = await updateGoatWorkflowAction({
        slug: workflow.id,
        name: snapshot.name,
        description: snapshot.description,
        trigger: snapshot.trigger,
        steps: snapshot.steps,
        status: snapshot.status,
      });
    } catch {
      result = { ok: false, message: "The workflow could not be saved. Try again." };
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
      void saveLatestRef.current();
      return;
    }
    if (latestValue === autosave.savedValue) {
      setSaveState("saved");
      setSaveError(null);
    }
  };

  useEffect(() => {
    if (!canEdit) return;
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
      void saveLatestRef.current();
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [canEdit, draft]);

  const patch = (partial: Partial<WorkflowDraft>) => {
    if (!canEdit) return;
    setDraft((current) => ({ ...current, ...partial }));
  };

  const updateStep = (id: string, partial: Partial<WorkflowStep>) => {
    if (!canEdit) return;
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.id === id ? { ...step, ...partial } : step)),
    }));
  };

  const addStep = () => {
    if (!canEdit) return;
    setDraft((current) => {
      if (current.steps.length >= MAX_WORKFLOW_STEPS) return current;
      return {
        ...current,
        steps: [
          ...current.steps,
          { id: newWorkflowStepId(), title: "", model: "", instructions: "" },
        ],
      };
    });
  };

  const removeStep = (id: string) => {
    if (!canEdit) return;
    setDraft((current) =>
      current.steps.length > 1
        ? { ...current, steps: current.steps.filter((step) => step.id !== id) }
        : current,
    );
  };

  const archive = () => {
    if (!canEdit) return;
    setSaveError(null);
    startArchiving(async () => {
      const result = await archiveGoatWorkflowAction({ slug: workflow.id });
      if (result.ok) {
        router.push("/workflows");
        return;
      }
      setSaveError(result.message);
    });
  };

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[760px] flex-col gap-7 pb-28 pt-10 sm:pt-14">
          <div className="flex items-center justify-between gap-4">
            <BackLink />
            <div className="flex min-w-0 items-center gap-2">
              {saveError ? (
                <span className="max-w-[320px] truncate text-[12px] text-warning" role="alert">
                  {saveError}
                </span>
              ) : null}
              <SaveIndicator state={saveState} canEdit={canEdit} />
              {canEdit ? <EditorMoreMenu onArchive={archive} isArchiving={isArchiving} /> : null}
            </div>
          </div>

          <header className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
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
            <div className="shrink-0 pt-1">
              <StatusPicker
                value={draft.status}
                onChange={(status) => patch({ status })}
                disabled={!canEdit}
              />
            </div>
          </header>

          <TriggerCard
            value={draft.trigger}
            onChange={(trigger) => patch({ trigger })}
            disabled={!canEdit}
          />

          <div className="flex flex-col gap-3">
            <SectionLabel>Steps</SectionLabel>
            {draft.steps.map((step, index) => (
              <StepCard
                key={step.id}
                index={index}
                step={step}
                canEdit={canEdit}
                canRemove={canEdit && draft.steps.length > 1}
                skillCatalog={skillCatalog}
                onChange={(partial) => updateStep(step.id, partial)}
                onRemove={() => removeStep(step.id)}
              />
            ))}
            {canEdit ? (
              <button
                type="button"
                onClick={addStep}
                disabled={draft.steps.length >= MAX_WORKFLOW_STEPS}
                className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1.5 text-[13px] font-medium text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus size={14} strokeWidth={2} />
                Add step
              </button>
            ) : (
              <p className="text-[12.5px] leading-5 text-ink-subtle">
                Only workspace admins can edit workflows.
              </p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function BackLink() {
  return (
    <Link
      href="/workflows"
      prefetch
      className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <ArrowLeft size={14} strokeWidth={2} />
      Workflows
    </Link>
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
  onChange,
  disabled,
}: {
  value: WorkflowStatus;
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
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[176px] border-border bg-surface p-1 text-ink shadow-[0_12px_32px_rgba(15,15,15,0.14)]"
      >
        {(["draft", "active"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              onChange(option);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink transition-colors duration-150 hover:bg-surface-hover"
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

function TriggerCard({
  value,
  onChange,
  disabled,
}: {
  value: WorkflowTrigger;
  onChange: (value: WorkflowTrigger) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = TRIGGER_OPTIONS.find((option) => option.id === value) ?? MANUAL_TRIGGER;
  const SelectedIcon = selected.icon;

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Trigger</SectionLabel>
      <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
        <PopoverTrigger
          type="button"
          disabled={disabled}
          className="flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-surface px-3.5 py-3 text-left transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-default disabled:hover:bg-surface data-[popup-open]:bg-surface-hover"
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink-subtle">
              <SelectedIcon size={14} strokeWidth={1.9} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium leading-4 text-ink">
                {selected.label}
              </span>
              <span className="truncate text-[12px] leading-4 text-ink-subtle">
                {selected.hint}
              </span>
            </span>
          </span>
          {disabled ? null : (
            <ChevronDown size={14} strokeWidth={2} className="shrink-0 text-ink-subtle" />
          )}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-[320px] max-w-[calc(100vw-1.5rem)] border-border bg-surface p-1 text-ink shadow-[0_12px_32px_rgba(15,15,15,0.14)]"
        >
          {TRIGGER_OPTIONS.map((option) => {
            const OptionIcon = option.icon;
            return (
              <button
                key={option.id}
                type="button"
                disabled={!option.available}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-150 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-transparent"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink-subtle">
                  <OptionIcon size={14} strokeWidth={1.9} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium leading-4 text-ink">
                    {option.label}
                  </span>
                  <span className="block truncate text-[11.5px] leading-4 text-ink-subtle">
                    {option.hint}
                  </span>
                </span>
                {option.available ? (
                  value === option.id ? (
                    <Check size={13} strokeWidth={2} className="shrink-0 text-ink" />
                  ) : null
                ) : (
                  <span className="shrink-0 rounded-full bg-surface-muted px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.04em] text-ink-subtle">
                    Soon
                  </span>
                )}
              </button>
            );
          })}
        </PopoverContent>
      </Popover>
    </section>
  );
}

function StepCard({
  index,
  step,
  canEdit,
  canRemove,
  skillCatalog,
  onChange,
  onRemove,
}: {
  index: number;
  step: WorkflowStep;
  canEdit: boolean;
  canRemove: boolean;
  skillCatalog: GoatSkillCatalogItem[];
  onChange: (partial: Partial<WorkflowStep>) => void;
  onRemove: () => void;
}) {
  return (
    <section className="group rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-surface-muted px-1 text-[11px] font-medium text-ink-subtle">
          {index + 1}
        </span>
        <input
          value={step.title}
          readOnly={!canEdit}
          maxLength={120}
          aria-label={`Step ${index + 1} name`}
          onChange={(event) => onChange({ title: event.target.value })}
          placeholder="Step name"
          className="min-w-0 flex-1 bg-transparent text-[13.5px] font-medium text-ink outline-none placeholder:text-ink-faint read-only:cursor-default"
        />
        <StepModelPicker
          value={step.model}
          onChange={(model) => onChange({ model })}
          disabled={!canEdit}
        />
        {canRemove ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove step ${index + 1}`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-subtle opacity-0 transition-all duration-150 hover:bg-surface-hover hover:text-danger focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 group-hover:opacity-100"
          >
            <Trash2 size={14} strokeWidth={1.9} />
          </button>
        ) : null}
      </div>
      <div className="px-3.5 py-3">
        <MarkdownGoatBrainEditor
          content={step.instructions}
          onChange={(instructions) => onChange({ instructions })}
          readOnly={!canEdit}
          compact
          placeholder="Describe what this step should do…"
          skillMentions={skillCatalog}
        />
      </div>
    </section>
  );
}

function StepModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selectedOption = GOAT_WORKFLOW_MODEL_OPTIONS.find((option) => option.token === value);
  const selectedLabel = selectedOption?.label ?? DEFAULT_MODEL_LABEL;

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger
        type="button"
        disabled={disabled}
        aria-label={`Model: ${selectedLabel}`}
        className="flex h-7 max-w-[150px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-default disabled:hover:bg-transparent data-[popup-open]:bg-surface-hover data-[popup-open]:text-ink"
      >
        <Sparkles size={12} strokeWidth={1.9} className="shrink-0" />
        <span className="truncate">{selectedLabel}</span>
        {disabled ? null : <ChevronDown size={11} strokeWidth={2} className="shrink-0" />}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[288px] max-w-[calc(100vw-1.5rem)] border-border bg-surface p-1 text-ink shadow-[0_12px_32px_rgba(15,15,15,0.14)]"
      >
        <ModelOption
          label="Default"
          hint={`Uses ${DEFAULT_MODEL_LABEL}`}
          selected={value === ""}
          onSelect={() => {
            onChange("");
            setOpen(false);
          }}
        />
        {GOAT_WORKFLOW_MODEL_OPTIONS.map((option) => (
          <ModelOption
            key={option.token}
            label={option.label}
            hint={option.hint}
            selected={value === option.token}
            onSelect={() => {
              onChange(option.token);
              setOpen(false);
            }}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function ModelOption({
  label,
  hint,
  selected,
  onSelect,
}: {
  label: string;
  hint: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-surface-hover"
    >
      <Check
        size={13}
        strokeWidth={2}
        className={`shrink-0 text-ink ${selected ? "opacity-100" : "opacity-0"}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-4 text-ink">{label}</span>
        <span className="block truncate text-[11.5px] leading-4 text-ink-subtle">{hint}</span>
      </span>
    </button>
  );
}

function SaveIndicator({ state, canEdit }: { state: SaveState; canEdit: boolean }) {
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
    return <span className="px-1.5 text-[12px] text-warning">Not saved</span>;
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
}: {
  onArchive: () => void;
  isArchiving: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label="More"
        className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 data-[popup-open]:bg-surface-hover data-[popup-open]:text-ink"
      >
        <MoreHorizontal size={16} strokeWidth={2} />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[180px] border-border bg-surface p-1 text-ink shadow-[0_12px_32px_rgba(15,15,15,0.14)]"
      >
        <button
          type="button"
          disabled={isArchiving}
          onClick={() => {
            setOpen(false);
            onArchive();
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-danger transition-colors duration-150 hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isArchiving ? (
            <Loader2 size={13} strokeWidth={1.9} className="animate-spin" />
          ) : (
            <Trash2 size={13} strokeWidth={1.9} />
          )}
          Archive workflow
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

function workflowDraft(workflow: GoatWorkflowDetail): WorkflowDraft {
  return {
    name: workflow.name,
    description: workflow.description,
    status: workflow.status,
    trigger: workflow.trigger,
    steps: workflow.steps,
  };
}

function serializeWorkflowDraft(draft: WorkflowDraft) {
  return JSON.stringify(draft);
}

function newWorkflowStepId() {
  return `step-${globalThis.crypto.randomUUID()}`;
}
