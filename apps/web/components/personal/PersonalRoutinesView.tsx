"use client";

import { scheduleSummary } from "@opencompany/agent-runtime";
import type { AgentScheduleTriggerConfig } from "@opencompany/agent-runtime/types";
import { Clock3 } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { personalPaths } from "@/lib/personal/paths";

function scheduleTriggers(triggers: readonly unknown[]): AgentScheduleTriggerConfig[] {
  return triggers.filter((trigger): trigger is AgentScheduleTriggerConfig => {
    if (!trigger || typeof trigger !== "object" || !("type" in trigger)) return false;
    return trigger.type === "agent.schedule";
  });
}

function RoutineStatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
        enabled
          ? "border-success-border bg-success-bg text-success"
          : "border-border bg-surface text-ink-subtle"
      }`}
    >
      {enabled ? "on" : "off"}
    </span>
  );
}

function RoutineRow({ routine }: { routine: AgentScheduleTriggerConfig }) {
  return (
    <article className="rounded-lg border border-border bg-surface/55 px-4 py-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-surface/70 bg-surface/70 text-ink-muted">
          <Clock3 size={15} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-[13.5px] font-medium text-ink">
              {scheduleSummary(routine)}
            </h2>
            <RoutineStatusPill enabled={routine.enabled} />
          </div>
          <dl className="mt-2 grid gap-2 text-[12px] leading-5 text-ink-muted sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-[10px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
                Cron
              </dt>
              <dd className="mt-0.5 truncate font-mono text-[11.5px] text-ink">{routine.cron}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[10px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
                Timezone
              </dt>
              <dd className="mt-0.5 truncate text-ink">{routine.timezone}</dd>
            </div>
          </dl>
          <div className="mt-3">
            <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
              Prompt
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-5 text-ink-muted">
              {routine.prompt}
            </p>
          </div>
        </div>
      </div>
    </article>
  );
}

export function PersonalRoutinesView() {
  const { config } = usePersonalAgent();
  const routines = useMemo(() => scheduleTriggers(config.triggers), [config.triggers]);

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-6 py-10">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Routines</h1>
            <p className="mt-1 text-[13px] leading-5 text-ink-muted">
              {routines.length} {routines.length === 1 ? "routine" : "routines"}
            </p>
          </div>
          <Link
            href={personalPaths.agent}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12.5px] font-medium text-ink/85 transition-colors duration-150 hover:bg-surface-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <Clock3 size={12.5} strokeWidth={1.9} />
            Behavior
          </Link>
        </div>

        <div className="mt-6 space-y-3">
          {routines.map((routine) => (
            <RoutineRow key={routine.id} routine={routine} />
          ))}
          {routines.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-surface/45 px-4 py-8 text-center">
              <Clock3
                size={18}
                strokeWidth={1.9}
                className="mx-auto text-ink-subtle"
                aria-hidden="true"
              />
              <p className="mt-3 text-[13px] font-medium text-ink">No routines yet</p>
              <p className="mx-auto mt-1 max-w-[360px] text-[12.5px] leading-5 text-ink-muted">
                Add a schedule in Behavior and it will appear here.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
