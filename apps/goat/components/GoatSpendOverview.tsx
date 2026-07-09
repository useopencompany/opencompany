"use client";

import { CircleDollarSign, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatUsdMicros } from "@/lib/cost-format";

const DEFAULT_DAYS = 14;

type DailyUsageRow = {
  day: string;
  totalCostUsdMicros: number;
  marketCostUsdMicros: number;
  surchargeCostUsdMicros: number;
  gatewayCostUsdMicros: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  requestCount: number;
};

type DrilldownItem = {
  tag: string;
  kind: "chat" | "task" | "ingest";
  id: string;
  label: string;
  href: string | null;
  totalCostUsdMicros: number;
  requestCount: number;
};

type UsageResponse = {
  timezone: "UTC";
  start: string;
  end: string;
  days: DailyUsageRow[];
  drilldown?: {
    day: string;
    items: DrilldownItem[];
  };
  error?: string;
};

type UsageLoadState = {
  key: string;
  data: UsageResponse | null;
  error: string | null;
};

export function GoatSpendOverview() {
  const range = useMemo(() => defaultUsageRange(), []);
  const [selectedDay, setSelectedDay] = useState(range.end);
  const requestKey = `${range.start}:${range.end}:${selectedDay}`;
  const [loadState, setLoadState] = useState<UsageLoadState>({
    key: "",
    data: null,
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      start: range.start,
      end: range.end,
      day: selectedDay,
    });

    void (async () => {
      try {
        const response = await fetch(`/api/usage/daily?${params.toString()}`, {
          signal: controller.signal,
        });
        const body = (await response.json()) as UsageResponse;
        if (!response.ok) {
          throw new Error(body.error || "Could not load spend.");
        }
        setLoadState({ key: requestKey, data: body, error: null });
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setLoadState({
          key: requestKey,
          data: null,
          error: loadError instanceof Error ? loadError.message : "Could not load spend.",
        });
      }
    })();

    return () => controller.abort();
  }, [range.end, range.start, requestKey, selectedDay]);

  const loading = loadState.key !== requestKey;
  const data = loadState.data;
  const error = loading ? null : loadState.error;
  const days = data?.days ?? [];
  const selected = days.find((day) => day.day === selectedDay) ?? null;
  const total = days.reduce((sum, day) => sum + day.totalCostUsdMicros, 0);
  const maxDailySpend = Math.max(1, ...days.map((day) => day.totalCostUsdMicros));
  const drilldownItems = data?.drilldown?.day === selectedDay ? data.drilldown.items : [];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Spend
        </h2>
        {loading ? (
          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-subtle">
            <Loader2 size={12} strokeWidth={2} className="animate-spin" />
            Loading
          </span>
        ) : (
          <span className="text-[11.5px] text-ink-subtle">
            Last {days.length || DEFAULT_DAYS} days
          </span>
        )}
      </div>

      {error ? (
        <div className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-[12.5px] leading-5 text-ink-subtle">
          {error}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <CircleDollarSign size={16} strokeWidth={2} className="shrink-0 text-ink-subtle" />
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium leading-tight text-ink">
                {formatUsdMicros(total)}
              </div>
              <div className="mt-0.5 text-[12px] leading-4 text-ink-subtle">
                {selected
                  ? `${formatDateLabel(selected.day)}: ${formatUsdMicros(
                      selected.totalCostUsdMicros,
                    )} across ${selected.requestCount} request${selected.requestCount === 1 ? "" : "s"}`
                  : "Usage appears here after Goat runs."}
              </div>
            </div>
          </div>

          <div className="flex h-24 items-end gap-1.5 px-2" aria-label="Daily spend chart">
            {days.map((day) => {
              const height = Math.max(8, Math.round((day.totalCostUsdMicros / maxDailySpend) * 80));
              const active = day.day === selectedDay;
              return (
                <button
                  key={day.day}
                  type="button"
                  aria-label={`${formatDateLabel(day.day)} spend ${formatUsdMicros(
                    day.totalCostUsdMicros,
                  )}`}
                  aria-pressed={active}
                  title={`${formatDateLabel(day.day)} - ${formatUsdMicros(day.totalCostUsdMicros)}`}
                  onClick={() => setSelectedDay(day.day)}
                  className="group flex h-24 min-w-0 flex-1 items-end justify-center rounded-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/25"
                >
                  <span
                    className={`block w-full rounded-sm transition-colors ${
                      active ? "bg-ink" : "bg-ink/20 group-hover:bg-ink/35"
                    }`}
                    style={{ height }}
                  />
                </button>
              );
            })}
          </div>

          <div className="flex flex-col gap-1">
            <div className="px-2 text-[12px] font-medium leading-5 text-ink">
              {formatDateLabel(selectedDay)}
            </div>
            {drilldownItems.length > 0 ? (
              drilldownItems.map((item) => <SpendBreakdownRow key={item.tag} item={item} />)
            ) : (
              <div className="rounded-lg px-2 py-2 text-[12.5px] leading-5 text-ink-subtle">
                No itemized usage for this day.
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function SpendBreakdownRow({ item }: { item: DrilldownItem }) {
  const content = (
    <>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-tight text-ink">
          {item.label}
        </span>
        <span className="block truncate text-[11.5px] leading-4 text-ink-subtle">
          {formatKind(item.kind)} - {item.requestCount} request{item.requestCount === 1 ? "" : "s"}
        </span>
      </div>
      <span className="shrink-0 text-[13px] font-medium text-ink">
        {formatUsdMicros(item.totalCostUsdMicros)}
      </span>
    </>
  );

  const className =
    "flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-hover";

  if (!item.href) return <div className={className}>{content}</div>;
  return (
    <Link href={item.href} prefetch className={className}>
      {content}
    </Link>
  );
}

function defaultUsageRange() {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (DEFAULT_DAYS - 1));
  return {
    start: toUtcDate(start),
    end: toUtcDate(end),
  };
}

function toUtcDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatDateLabel(day: string) {
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatKind(kind: DrilldownItem["kind"]) {
  if (kind === "chat") return "Chat";
  if (kind === "task") return "Task";
  return "Ingest";
}
