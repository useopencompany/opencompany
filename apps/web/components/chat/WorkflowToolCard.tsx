"use client";

import { scheduleSummary } from "@opencompany/agent-runtime";
import { ArrowUpRight, Workflow } from "lucide-react";
import Link from "next/link";

export function WorkflowToolCard({ output }: { output: unknown }) {
  if (!isRecord(output) || !isRecord(output.workflow)) return null;
  const workflow = output.workflow;
  if (typeof workflow.name !== "string" || typeof workflow.slug !== "string") return null;
  const schedule = Array.isArray(workflow.triggers)
    ? workflow.triggers.find((trigger: unknown) => isRecord(trigger) && trigger.type === "schedule")
    : workflow.trigger;
  const nextRun =
    isRecord(schedule) &&
    typeof schedule.nextRunAt === "string" &&
    workflow.status === "active" &&
    schedule.enabled !== false
      ? schedule.nextRunAt
      : null;
  const timezone =
    isRecord(schedule) && typeof schedule.timezone === "string" ? schedule.timezone : null;
  const memory = isRecord(workflow.memory) && workflow.memory.enabled === true;
  const blockers = Array.isArray(workflow.activationBlockers)
    ? workflow.activationBlockers.filter(
        (item): item is string => typeof item === "string" && item !== output.error,
      )
    : [];
  return (
    <div className="my-2 max-w-md rounded-xl border border-border bg-surface p-4 text-sm">
      <div className="flex items-center gap-2">
        <Workflow className="size-4 text-ink-muted" aria-hidden="true" />
        <Link
          href={`/workflows/${encodeURIComponent(workflow.slug)}`}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 font-medium hover:underline"
        >
          <span className="truncate">{workflow.name}</span>
          <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
        </Link>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
        <span>
          {workflow.archived ? "Archived" : workflow.status === "active" ? "Active" : "Draft"}
        </span>
        <span>{workflow.scope === "company" ? "Company" : "Personal"}</span>
        {!workflow.archived && <span>Memory {memory ? "on" : "off"}</span>}
      </div>
      {isRecord(schedule) && typeof schedule.cron === "string" && (
        <p className="mt-2 text-xs text-ink-muted">
          {scheduleSummary({ cron: schedule.cron, timezone: timezone ?? "UTC" })}
          {timezone ? ` · ${timezone}` : ""}
        </p>
      )}
      {nextRun && (
        <p className="mt-1 text-xs text-ink-muted">Next run: {formatNextRun(nextRun, timezone)}</p>
      )}
      {output.ok === false && typeof output.error === "string" && (
        <p className="mt-2 text-xs text-danger">{output.error}</p>
      )}
      {workflow.status !== "active" &&
        blockers.map((blocker) => (
          <p key={blocker} className="mt-2 text-xs text-ink-muted">
            {blocker}
          </p>
        ))}
    </div>
  );
}

function formatNextRun(value: string, timezone: string | null) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return date.toLocaleString("en", {
      timeZone: timezone ?? "UTC",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return date.toISOString();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
