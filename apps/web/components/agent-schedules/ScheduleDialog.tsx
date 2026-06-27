"use client";

import {
  cronForSchedulePreset,
  normalizeScheduleTimezone,
  schedulePresetFromCron,
} from "@opencompany/agent-runtime";
import type { AgentScheduleTriggerConfig } from "@opencompany/agent-runtime/types";
import { useState } from "react";

type ScheduleFormKind = "minutes" | "hours" | "daily" | "weekdays" | "weekly";

const WEEKDAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

export function ScheduleDialog({
  schedule,
  existingIds,
  defaultTimezone,
  showTimezone = true,
  title,
  agentOptions,
  selectedAgentId,
  onSelectAgent,
  agentPickerDisabled = false,
  onClose,
  onSave,
  onRemove,
}: {
  schedule: AgentScheduleTriggerConfig | null;
  existingIds: string[];
  defaultTimezone?: string;
  showTimezone?: boolean;
  title?: string;
  // When provided, render an agent picker at the top of the form (company Routines tab, where a
  // routine can target any workspace agent). Personal/agent-editor callers omit these — the agent
  // is already implied by context.
  agentOptions?: { id: string; name: string }[];
  selectedAgentId?: string;
  onSelectAgent?: (agentId: string) => void;
  agentPickerDisabled?: boolean;
  onClose: () => void;
  onSave: (trigger: AgentScheduleTriggerConfig) => void;
  onRemove?: () => void;
}) {
  const initial = scheduleFormFromTrigger(schedule, defaultTimezone);
  const [kind, setKind] = useState<ScheduleFormKind>(initial.kind);
  const [interval, setInterval] = useState(initial.interval);
  const [time, setTime] = useState(initial.time);
  const [dayOfWeek, setDayOfWeek] = useState(initial.dayOfWeek);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [prompt, setPrompt] = useState(initial.prompt);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError("Prompt is required.");
      return;
    }

    const [hour, minute] = parseTimeInput(time);
    const cron =
      kind === "minutes"
        ? cronForSchedulePreset({ kind, interval })
        : kind === "hours"
          ? cronForSchedulePreset({ kind, interval })
          : kind === "daily"
            ? cronForSchedulePreset({ kind, hour, minute })
            : kind === "weekdays"
              ? cronForSchedulePreset({ kind, hour, minute })
              : cronForSchedulePreset({ kind, dayOfWeek, hour, minute });

    onSave({
      id: schedule?.id ?? uniqueScheduleId(trimmedPrompt, existingIds),
      type: "agent.schedule",
      cron,
      timezone: normalizeScheduleTimezone(showTimezone ? timezone : defaultTimezone),
      prompt: trimmedPrompt,
      enabled,
    });
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/25 px-4">
      <div className="w-full max-w-[420px] rounded-lg border border-border bg-surface-raised p-4 shadow-[0_18px_50px_rgba(0,0,0,0.18)]">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-semibold text-ink">
            {title ?? (schedule ? "Edit schedule" : "Run every...")}
          </div>
          <label className="flex items-center gap-2 text-[12px] font-medium text-ink-muted">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Enabled
          </label>
        </div>

        <div className="mt-4 space-y-3">
          {agentOptions && agentOptions.length > 0 ? (
            <label className="block">
              <span className="text-[11px] font-medium uppercase text-ink-subtle">Agent</span>
              <select
                value={selectedAgentId}
                onChange={(event) => onSelectAgent?.(event.target.value)}
                disabled={agentPickerDisabled}
                className="mt-1 h-9 w-full rounded-md border border-border bg-surface px-2 text-[13px] text-ink outline-none focus:ring-1 focus:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {agentOptions.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="block">
            <span className="text-[11px] font-medium uppercase text-ink-subtle">Frequency</span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as ScheduleFormKind)}
              className="mt-1 h-9 w-full rounded-md border border-border bg-surface px-2 text-[13px] text-ink outline-none focus:ring-1 focus:ring-ink/20"
            >
              <option value="minutes">Every few minutes</option>
              <option value="hours">Every few hours</option>
              <option value="daily">Daily</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>

          {kind === "minutes" || kind === "hours" ? (
            <label className="block">
              <span className="text-[11px] font-medium uppercase text-ink-subtle">Every</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={kind === "minutes" ? 59 : 23}
                  value={interval}
                  onChange={(event) => setInterval(Number.parseInt(event.target.value, 10) || 1)}
                  className="h-9 w-20 rounded-md border border-border bg-surface px-2 text-[13px] text-ink outline-none focus:ring-1 focus:ring-ink/20"
                />
                <span className="text-[12.5px] text-ink-muted">
                  {kind === "minutes" ? "minutes" : "hours"}
                </span>
              </div>
            </label>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {kind === "weekly" ? (
                <label className="block">
                  <span className="text-[11px] font-medium uppercase text-ink-subtle">Day</span>
                  <select
                    value={dayOfWeek}
                    onChange={(event) => setDayOfWeek(Number.parseInt(event.target.value, 10))}
                    className="mt-1 h-9 w-full rounded-md border border-border bg-surface px-2 text-[13px] text-ink outline-none focus:ring-1 focus:ring-ink/20"
                  >
                    {WEEKDAYS.map((day) => (
                      <option key={day.value} value={day.value}>
                        {day.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="block">
                <span className="text-[11px] font-medium uppercase text-ink-subtle">Time</span>
                <input
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-border bg-surface px-2 text-[13px] text-ink outline-none focus:ring-1 focus:ring-ink/20"
                />
              </label>
            </div>
          )}

          {showTimezone ? (
            <label className="block">
              <span className="text-[11px] font-medium uppercase text-ink-subtle">Timezone</span>
              <input
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-border bg-surface px-2 text-[13px] text-ink outline-none focus:ring-1 focus:ring-ink/20"
              />
            </label>
          ) : null}

          <label className="block">
            <span className="text-[11px] font-medium uppercase text-ink-subtle">Prompt</span>
            <textarea
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                setError(null);
              }}
              rows={4}
              className="mt-1 w-full resize-none rounded-md border border-border bg-surface px-2 py-2 text-[13px] leading-5 text-ink outline-none focus:ring-1 focus:ring-ink/20"
              placeholder="Tell the agent exactly what to do on each run."
            />
          </label>
        </div>

        {error ? <div className="mt-3 text-[12px] font-medium text-danger">{error}</div> : null}

        <div className="mt-5 flex items-center justify-between">
          {onRemove ? (
            <button
              type="button"
              onClick={onRemove}
              className="rounded-md px-2 py-1.5 text-[12.5px] font-medium text-danger hover:bg-danger-bg"
            >
              Remove
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink-muted hover:bg-surface-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              className="rounded-md bg-ink px-3 py-1.5 text-[12.5px] font-medium text-canvas hover:bg-ink/90"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function scheduleFormFromTrigger(
  schedule: AgentScheduleTriggerConfig | null,
  defaultTimezone?: string,
): {
  kind: ScheduleFormKind;
  interval: number;
  time: string;
  dayOfWeek: number;
  timezone: string;
  prompt: string;
  enabled: boolean;
} {
  const preset = schedule ? schedulePresetFromCron(schedule.cron) : null;
  const timezone = schedule?.timezone ?? defaultTimezone ?? browserTimezone() ?? "UTC";
  const prompt = schedule?.prompt ?? "";
  const enabled = schedule?.enabled ?? true;

  if (preset?.kind === "minutes") {
    return {
      kind: "minutes",
      interval: preset.interval,
      time: "09:00",
      dayOfWeek: 1,
      timezone,
      prompt,
      enabled,
    };
  }
  if (preset?.kind === "hours") {
    return {
      kind: "hours",
      interval: preset.interval,
      time: "09:00",
      dayOfWeek: 1,
      timezone,
      prompt,
      enabled,
    };
  }
  if (preset?.kind === "daily" || preset?.kind === "weekdays") {
    return {
      kind: preset.kind,
      interval: 1,
      time: `${String(preset.hour).padStart(2, "0")}:${String(preset.minute).padStart(2, "0")}`,
      dayOfWeek: 1,
      timezone,
      prompt,
      enabled,
    };
  }
  if (preset?.kind === "weekly") {
    return {
      kind: "weekly",
      interval: 1,
      time: `${String(preset.hour).padStart(2, "0")}:${String(preset.minute).padStart(2, "0")}`,
      dayOfWeek: preset.dayOfWeek,
      timezone,
      prompt,
      enabled,
    };
  }

  return {
    kind: "weekdays",
    interval: 1,
    time: "09:00",
    dayOfWeek: 1,
    timezone,
    prompt,
    enabled,
  };
}

function browserTimezone() {
  if (typeof window === "undefined") return null;
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
}

function parseTimeInput(value: string) {
  const [hour, minute] = value.split(":").map((part) => Number.parseInt(part, 10));
  return [Number.isFinite(hour) ? hour! : 9, Number.isFinite(minute) ? minute! : 0] as const;
}

function uniqueScheduleId(prompt: string, existingIds: string[]) {
  const base =
    prompt
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36) || "schedule";
  const used = new Set(existingIds);
  if (!used.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
