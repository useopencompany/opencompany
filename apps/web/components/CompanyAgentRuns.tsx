"use client";

import type { CompanyAgentDto, CompanyAgentRunDto } from "@opencompany/protocol";

// Mirrors the protocol's CompanyAgentRun contract with concrete web-side types: the generated
// z.infer types collapse to `any` under this app's tsconfig, which would silently drop the
// exhaustiveness the status and trigger lookups below rely on.
type AgentRun = {
  id: string;
  taskId: string | null;
  displayId: string | null;
  conversationId: string | null;
  name: string;
  status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "canceled" | "blocked";
  triggerKind: "manual" | "schedule" | "event";
  triggerLabel: string;
  result: string | null;
  error: string | null;
  awaitingInput: boolean;
  createdAt: string;
  updatedAt: string;
};

import { AlertTriangle, CalendarClock, Play, Webhook } from "lucide-react";
import Link from "next/link";
import { EmptyState, formatRelativeTime } from "@/components/Routes";

const TRIGGER_ICON = {
  manual: Play,
  schedule: CalendarClock,
  event: Webhook,
} as const;

const STATUS_COPY: Record<AgentRun["status"], { label: string; className: string }> = {
  queued: { label: "Queued", className: "text-ink-subtle" },
  running: { label: "Running", className: "text-ink" },
  waiting: { label: "Waiting", className: "text-warning" },
  succeeded: { label: "Done", className: "text-success" },
  failed: { label: "Failed", className: "text-danger" },
  canceled: { label: "Canceled", className: "text-ink-subtle" },
  blocked: { label: "Blocked", className: "text-danger" },
};

/**
 * What this agent has done, and what it could not do. A blocked row is an event that matched the
 * agent but never became work — almost always the owner's connection going missing — and it is
 * shown here precisely so that failure is not invisible.
 */
export function CompanyAgentRuns({
  agent,
  runs,
}: {
  agent: CompanyAgentDto;
  runs: CompanyAgentRunDto[];
}) {
  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[860px] flex-col gap-8 pb-24 pt-10 sm:pt-12">
          <Link
            href={`/agents/${encodeURIComponent(agent.slug)}`}
            prefetch
            className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            {agent.name}
          </Link>
          <header className="flex flex-col gap-1.5">
            <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">
              Runs
            </h1>
            <p className="text-[13px] leading-5 text-ink-subtle">
              Everything {agent.name} has worked on. These runs belong to the agent, so they do not
              show up in anyone’s personal Tasks.
            </p>
          </header>

          {runs.length === 0 ? (
            <EmptyState
              icon={Play}
              title="No runs yet"
              description="Press Run now on the agent, or wait for one of its triggers to fire."
            />
          ) : (
            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {(runs as AgentRun[]).map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}

function RunRow({ run }: { run: AgentRun }) {
  const Icon = run.status === "blocked" ? AlertTriangle : TRIGGER_ICON[run.triggerKind];
  const status = STATUS_COPY[run.status];
  const summary = run.error ?? run.result;
  const body = (
    <div className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3">
      <Icon
        size={15}
        strokeWidth={1.8}
        className={`mt-0.5 shrink-0 ${run.status === "blocked" ? "text-danger" : "text-ink-subtle"}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="truncate text-[13.5px] font-medium text-ink">{run.name}</span>
          <span className="text-[12px] text-ink-subtle">{run.triggerLabel}</span>
        </div>
        {summary ? (
          <p className="line-clamp-2 text-[12.5px] leading-5 text-ink-subtle">{summary}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className={`text-[12px] font-medium ${status.className}`}>
          {run.awaitingInput ? "Needs approval" : status.label}
        </span>
        <span className="text-[11.5px] text-ink-subtle">{formatRelativeTime(run.createdAt)}</span>
      </div>
    </div>
  );

  return (
    <li className="flex min-w-0">
      {run.displayId ? (
        <Link
          href={`/tasks/${run.displayId}`}
          prefetch
          className="flex min-w-0 flex-1 hover:bg-surface-hover"
        >
          {body}
        </Link>
      ) : (
        body
      )}
    </li>
  );
}
