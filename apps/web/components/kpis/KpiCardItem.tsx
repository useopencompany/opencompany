"use client";

import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Area, AreaChart, Bar, BarChart } from "recharts";
import { useToast } from "@/components/ToastProvider";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { refreshKpiCard } from "@/lib/kpis/actions";
import type { KpiCardPayload } from "@/lib/kpis/payload";
import { type KpiSeriesPoint, summarizeKpi } from "@/lib/kpis/summarize";
import { KPI_TIME_RANGES } from "@/lib/kpis/types";

export type KpiCardActions = {
  changeRange: (cardId: string, days: number) => void;
  remove: (cardId: string) => void;
};

const RANGE_LABELS: Record<number, string> = {
  1: "Today",
  7: "7 days",
  30: "30 days",
  90: "90 days",
};

export function KpiCardItem({
  card,
  points,
  actions,
}: {
  card: KpiCardPayload;
  points: KpiSeriesPoint[];
  /** Undefined while the live collections haven't hydrated; controls disable. */
  actions?: KpiCardActions | undefined;
}) {
  const { showError } = useToast();
  const [isRefreshing, startRefresh] = useTransition();
  const now = useNowMinute();

  const summary = useMemo(
    () =>
      summarizeKpi({
        metricType: card.metric.metricType,
        points,
        rangeDays: card.timeRangeDays,
        now,
      }),
    [card.metric.metricType, card.timeRangeDays, points, now],
  );

  function handleRefresh() {
    startRefresh(async () => {
      try {
        const result = await refreshKpiCard(card.id);
        if (!result.ok) showError(result.error, "Refresh failed");
      } catch (err) {
        showError(err instanceof Error ? err.message : "Could not refresh", "Refresh failed");
      }
    });
  }

  const hasError = card.metric.lastRefreshStatus === "error";

  return (
    <div className="group relative flex flex-col rounded-lg border border-border bg-surface p-4 transition-colors duration-150 hover:border-border-strong">
      {/* Header: title + provider, hover actions */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium tracking-[-0.005em] text-ink">
            {card.title}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-subtle">
            {providerLabel(card.metric.provider)} ·{" "}
            {RANGE_LABELS[card.timeRangeDays] ?? `${card.timeRangeDays} days`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
          <Select
            value={String(card.timeRangeDays)}
            onValueChange={(value) => actions?.changeRange(card.id, Number(value))}
            disabled={!actions}
          >
            <SelectTrigger
              aria-label="Time range"
              className="h-6 w-auto gap-1 border-transparent bg-transparent px-1.5 text-[11px] text-ink-muted hover:bg-surface-hover"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KPI_TIME_RANGES.map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {RANGE_LABELS[days]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            aria-label="Refresh"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="rounded-md p-1 text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:opacity-55"
          >
            <RefreshCw
              size={12.5}
              strokeWidth={1.8}
              className={isRefreshing ? "animate-spin" : undefined}
            />
          </button>
          <button
            type="button"
            aria-label="Remove card"
            onClick={() => actions?.remove(card.id)}
            disabled={!actions}
            className="rounded-md p-1 text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-danger disabled:opacity-55"
          >
            <Trash2 size={12.5} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {/* Headline value + delta */}
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-[26px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-ink">
          {summary.headline === null ? "—" : formatKpiValue(summary.headline)}
        </span>
        {summary.delta && summary.delta.direction !== "flat" && (
          <span
            className={`flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${
              summary.delta.direction === "up"
                ? "bg-success-bg text-success"
                : "bg-danger-bg text-danger"
            }`}
          >
            {summary.delta.direction === "up" ? (
              <ArrowUpRight size={11} strokeWidth={2} />
            ) : (
              <ArrowDownRight size={11} strokeWidth={2} />
            )}
            {formatDelta(summary.delta.absolute, summary.delta.percent)}
          </span>
        )}
      </div>

      {/* Chart */}
      <div className="mt-3">
        {summary.series.length > 1 && card.viz !== "number" ? (
          <KpiChart card={card} series={summary.series} />
        ) : summary.series.length > 1 ? (
          <KpiSparkline card={card} series={summary.series} />
        ) : (
          <div className="flex h-16 items-center justify-center rounded-md bg-surface-muted text-[11px] text-ink-subtle">
            {summary.headline === null ? "No data yet" : "Collecting history…"}
          </div>
        )}
      </div>

      {/* Footer: freshness + error state */}
      <div className="mt-3 flex items-center gap-1.5 text-[10.5px] text-ink-subtle">
        {card.metric.lastRefreshStatus === "refreshing" || isRefreshing ? (
          <>
            <Loader2 size={10} strokeWidth={2} className="animate-spin" />
            Refreshing…
          </>
        ) : (
          <span suppressHydrationWarning>{formatUpdatedAt(card.metric.lastRefreshedAt, now)}</span>
        )}
        {hasError && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1 text-warning">
                  <AlertTriangle size={10.5} strokeWidth={1.8} />
                  Last refresh failed
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[260px]">
                {card.metric.lastRefreshError ?? "The provider request failed."}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </div>
  );
}

function KpiChart({ card, series }: { card: KpiCardPayload; series: KpiSeriesPoint[] }) {
  const config = { value: { label: card.metric.label, color: "var(--color-accent)" } };
  const hourly = card.metric.metricType === "current" && card.timeRangeDays === 1;

  if (card.viz === "bar") {
    return (
      <ChartContainer config={config} className="h-16 w-full">
        <BarChart data={series} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <ChartTooltip
            cursor={{ fill: "var(--color-surface-hover)" }}
            content={
              <ChartTooltipContent
                labelFormatter={(item) => formatTs(Number(item.ts), hourly)}
                valueFormatter={formatKpiValue}
              />
            }
          />
          <Bar dataKey="value" fill="var(--color-value)" radius={[2, 2, 0, 0]} maxBarSize={18} />
        </BarChart>
      </ChartContainer>
    );
  }

  return (
    <ChartContainer config={config} className="h-16 w-full">
      <AreaChart data={series} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`kpi-fill-${card.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-value)" stopOpacity={0.25} />
            <stop offset="100%" stopColor="var(--color-value)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <ChartTooltip
          cursor={{ stroke: "var(--color-border-strong)" }}
          content={
            <ChartTooltipContent
              labelFormatter={(item) => formatTs(Number(item.ts), hourly)}
              valueFormatter={formatKpiValue}
            />
          }
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--color-value)"
          strokeWidth={1.5}
          fill={`url(#kpi-fill-${card.id})`}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

function KpiSparkline({ card, series }: { card: KpiCardPayload; series: KpiSeriesPoint[] }) {
  return (
    <ChartContainer
      config={{ value: { label: card.metric.label, color: "var(--color-ink-subtle)" } }}
      className="h-10 w-full"
    >
      <AreaChart data={series} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--color-value)"
          strokeWidth={1.25}
          fill="none"
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

function providerLabel(providerId: string): string {
  if (providerId === "github") return "GitHub";
  if (providerId === "posthog") return "PostHog";
  return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

export function formatKpiValue(value: number): string {
  if (Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  return value.toFixed(1);
}

function formatDelta(absolute: number, percent: number | null): string {
  if (percent === null) return `${absolute > 0 ? "+" : ""}${formatKpiValue(absolute)}`;
  const rounded = Math.round(Math.abs(percent));
  return `${rounded}%`;
}

function formatTs(ts: number, hourly: boolean): string {
  const date = new Date(ts);
  return hourly
    ? date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Wall-clock for window math and freshness labels, ticking once a minute so
 * "Updated 4m ago" and trailing windows stay honest on a long-open tab.
 */
function useNowMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(interval);
  }, []);
  return now;
}

function formatUpdatedAt(iso: string | null, now: number): string {
  if (!iso) return "Waiting for first refresh";
  const elapsedMs = now - Date.parse(iso);
  if (elapsedMs < 60 * 1000) return "Updated just now";
  const minutes = Math.floor(elapsedMs / (60 * 1000));
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}
