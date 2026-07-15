"use client";

import { DatabaseZap, FilePlus2, RadioTower } from "lucide-react";
import { GoatBrainRecentActivity } from "@/components/GoatBrainActivity";
import type { GoatBrainDocumentView } from "@/lib/brain";
import type { GoatBrainOverviewStats } from "@/lib/brain-overview";

export function GoatBrainOverview({
  brainName,
  brainRef,
  documents,
  stats,
}: {
  brainName: string;
  brainRef: string;
  documents: GoatBrainDocumentView[];
  stats: GoatBrainOverviewStats;
}) {
  const windowStart = new Date(stats.windowStartedAt).getTime();
  const itemsAdded = documents.reduce((total, document) => {
    const createdAt = new Date(document.createdAt).getTime();
    return Number.isFinite(createdAt) && createdAt >= windowStart ? total + 1 : total;
  }, 0);

  const metrics = [
    {
      label: "Items added",
      value: itemsAdded,
      description: "Last 7 days",
      icon: FilePlus2,
    },
    {
      label: "Retrievals",
      value: stats.retrievalsLast7Days,
      description: "Successful reads, last 7 days",
      icon: DatabaseZap,
    },
    {
      label: "Active sources",
      value: stats.activeSources,
      description: "Feeding this brain now",
      icon: RadioTower,
    },
  ];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-9 px-6 pb-20 pt-10 sm:px-10 sm:pt-14">
        <section aria-labelledby="brain-overview-title" className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1
              id="brain-overview-title"
              className="text-[22px] font-semibold tracking-[-0.02em] text-ink"
            >
              {brainName}
            </h1>
            <p className="text-[13px] leading-5 text-ink-muted">
              A quick look at how your brain is growing and being used.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {metrics.map((metric) => {
              const Icon = metric.icon;
              return (
                <div
                  key={metric.label}
                  className="flex min-h-[126px] flex-col justify-between rounded-xl border border-border-subtle bg-surface px-4 py-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[12px] font-medium text-ink-muted">{metric.label}</span>
                    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-muted text-ink-subtle">
                      <Icon size={14} strokeWidth={1.8} />
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[28px] font-semibold leading-none tracking-[-0.03em] text-ink tabular-nums">
                      {metric.value.toLocaleString()}
                    </span>
                    <span className="text-[11.5px] text-ink-subtle">{metric.description}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section aria-labelledby="brain-recent-activity-title" className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 id="brain-recent-activity-title" className="text-[14px] font-semibold text-ink">
              Recent activity
            </h2>
            <p className="text-[12px] leading-5 text-ink-subtle">
              The latest captures and filing updates.
            </p>
          </div>
          <GoatBrainRecentActivity brainRef={brainRef} />
        </section>
      </div>
    </div>
  );
}
