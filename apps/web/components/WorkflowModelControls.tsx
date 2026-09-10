"use client";
import { CLOUD_CODING_ENGINE_CONFIG } from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import { Check, ChevronDown, Sparkles } from "lucide-react";
import { useState } from "react";
import type { WorkflowStep } from "@/lib/headless-automation-types";
import {
  DEFAULT_WORKFLOW_MODEL_TOKEN,
  DEFAULT_WORKFLOW_REASONING_EFFORT,
  normalizeWorkflowReasoningEffort,
  normalizeWorkflowRuntimeModel,
  WORKFLOW_MODEL_OPTIONS,
  WORKFLOW_REASONING_EFFORT_OPTIONS,
  type WorkflowCloudRuntime,
  workflowCloudModelOptions,
  workflowRuntimeModelSupportsReasoningEffort,
} from "@/lib/workflow-model-options";
export type WorkflowStepPatch = Partial<Omit<WorkflowStep, "runtimeModel" | "reasoningEffort">> & {
  runtimeModel?: WorkflowStep["runtimeModel"] | undefined;
  reasoningEffort?: WorkflowStep["reasoningEffort"] | undefined;
};
const DEFAULT_MODEL_LABEL =
  WORKFLOW_MODEL_OPTIONS.find((option) => option.token === DEFAULT_WORKFLOW_MODEL_TOKEN)?.label ??
  "Default";
export function StepRuntimePicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selectedOption = WORKFLOW_MODEL_OPTIONS.find((option) => option.token === value);
  const selectedLabel = selectedOption?.label ?? DEFAULT_MODEL_LABEL;

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger
        type="button"
        disabled={disabled}
        aria-label={`Runtime: ${selectedLabel}`}
        className="flex h-7 max-w-[150px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-default disabled:hover:bg-transparent data-[popup-open]:bg-surface-hover data-[popup-open]:text-ink"
      >
        <Sparkles size={12} strokeWidth={1.9} className="shrink-0" />
        <span className="truncate">{selectedLabel}</span>
        {disabled ? null : <ChevronDown size={11} strokeWidth={2} className="shrink-0" />}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[288px] max-w-[calc(100vw-1.5rem)] bg-surface p-1 text-ink"
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
        {WORKFLOW_MODEL_OPTIONS.map((option) => (
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

export function StepCloudRuntimeControls({
  compact = false,
  engine,
  step,
  disabled,
  onChange,
}: {
  compact?: boolean;
  engine: WorkflowCloudRuntime;
  step: WorkflowStep;
  disabled: boolean;
  onChange: (partial: WorkflowStepPatch) => void;
}) {
  const runtimeModel = normalizeWorkflowRuntimeModel(engine, step.runtimeModel);
  const reasoningEffort = normalizeWorkflowReasoningEffort(
    engine,
    runtimeModel,
    step.reasoningEffort,
  );
  const supportsEffort = workflowRuntimeModelSupportsReasoningEffort(engine, runtimeModel);

  return (
    <div
      className={
        compact
          ? "flex flex-wrap items-center gap-1"
          : "flex flex-wrap items-center gap-2 border-b border-border bg-surface-muted/35 px-3.5 py-2"
      }
    >
      <StepCloudModelPicker
        engine={engine}
        value={runtimeModel}
        onChange={(nextModel) => {
          onChange({
            runtimeModel: nextModel,
            reasoningEffort: normalizeWorkflowReasoningEffort(
              engine,
              nextModel,
              step.reasoningEffort,
            ),
          });
        }}
        disabled={disabled}
      />
      {supportsEffort ? (
        <StepEffortPicker
          value={reasoningEffort ?? DEFAULT_WORKFLOW_REASONING_EFFORT}
          onChange={(nextEffort) => onChange({ reasoningEffort: nextEffort })}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}

function StepCloudModelPicker({
  engine,
  value,
  onChange,
  disabled,
}: {
  engine: WorkflowCloudRuntime;
  value: AgentModelId;
  onChange: (value: AgentModelId) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const options = workflowCloudModelOptions(engine);
  const selectedOption = options.find((option) => option.id === value);
  const visibleOptions = options.filter((option) => option.id !== "anthropic/claude-opus-4.8");
  const selectedLabel = selectedOption?.label ?? value;
  const runtimeLabel = CLOUD_CODING_ENGINE_CONFIG[engine].label;

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger
        type="button"
        disabled={disabled}
        aria-label={`${runtimeLabel} model: ${selectedLabel}`}
        className="flex h-7 max-w-[210px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-default disabled:hover:bg-transparent data-[popup-open]:bg-surface-hover data-[popup-open]:text-ink"
      >
        <span className="truncate">{selectedLabel}</span>
        {disabled ? null : <ChevronDown size={11} strokeWidth={2} className="shrink-0" />}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[312px] max-w-[calc(100vw-1.5rem)] bg-surface p-1 text-ink"
      >
        {visibleOptions.map((option) => (
          <ModelOption
            key={option.id}
            label={option.label}
            hint={option.description}
            selected={value === option.id}
            onSelect={() => {
              onChange(option.id);
              setOpen(false);
            }}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

const WORKFLOW_EFFORT_LABELS = {
  low: { label: "Low effort", hint: "Fastest" },
  medium: { label: "Medium effort", hint: "Balanced" },
  high: { label: "High effort", hint: "Deeper" },
  xhigh: { label: "X-high effort", hint: "Maximum" },
} as const;

const WORKFLOW_EFFORT_OPTIONS = WORKFLOW_REASONING_EFFORT_OPTIONS.map((value) => ({
  value,
  ...WORKFLOW_EFFORT_LABELS[value],
}));

type WorkflowEffort = (typeof WORKFLOW_EFFORT_OPTIONS)[number]["value"];

function StepEffortPicker({
  value,
  onChange,
  disabled,
}: {
  value: WorkflowEffort;
  onChange: (value: WorkflowEffort) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selectedOption = WORKFLOW_EFFORT_OPTIONS.find((option) => option.value === value);
  const selectedLabel = selectedOption?.label ?? "High effort";

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger
        type="button"
        disabled={disabled}
        aria-label={`Effort: ${selectedLabel}`}
        className="flex h-7 max-w-[160px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-default disabled:hover:bg-transparent data-[popup-open]:bg-surface-hover data-[popup-open]:text-ink"
      >
        <span className="truncate">{selectedLabel}</span>
        {disabled ? null : <ChevronDown size={11} strokeWidth={2} className="shrink-0" />}
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-[220px] bg-surface p-1 text-ink">
        {WORKFLOW_EFFORT_OPTIONS.map((option) => (
          <ModelOption
            key={option.value}
            label={option.label}
            hint={option.hint}
            selected={value === option.value}
            onSelect={() => {
              onChange(option.value);
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
