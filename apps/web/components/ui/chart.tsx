"use client";

import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "@/lib/utils";

/**
 * Chart primitives in the shadcn/ui style (https://ui.shadcn.com/charts),
 * trimmed to what KPI cards need and themed with the app's design tokens:
 * series colors flow through CSS variables (`--color-<key>`) set from the
 * ChartConfig, so charts follow light/dark mode for free.
 */

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    color?: string;
  }
>;

type ChartContextProps = { config: ChartConfig };

const ChartContext = React.createContext<ChartContextProps | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) throw new Error("useChart must be used within a <ChartContainer />");
  return context;
}

export function ChartContainer({
  config,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
}) {
  const style = Object.fromEntries(
    Object.entries(config)
      .filter(([, entry]) => entry.color)
      .map(([key, entry]) => [`--color-${key}`, entry.color]),
  ) as React.CSSProperties;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        className={cn(
          "flex aspect-auto justify-center overflow-hidden text-[11px]",
          "[&_.recharts-cartesian-grid_line]:stroke-border-subtle [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-surface-hover",
          className,
        )}
        style={style}
        {...props}
      >
        <RechartsPrimitive.ResponsiveContainer width="100%" height="100%">
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = RechartsPrimitive.Tooltip;

type TooltipPayloadEntry = {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
  payload?: Record<string, unknown>;
};

export function ChartTooltipContent({
  active,
  payload,
  labelFormatter,
  valueFormatter,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  /** Formats the x value (the datapoint's `ts`) into the tooltip heading. */
  labelFormatter?: (item: Record<string, unknown>) => string;
  valueFormatter?: (value: number) => string;
}) {
  const { config } = useChart();
  if (!active || !payload || payload.length === 0) return null;

  const first = payload[0];
  const heading = first?.payload && labelFormatter ? labelFormatter(first.payload) : null;

  return (
    <div className="min-w-[7rem] rounded-md border border-border bg-surface px-2.5 py-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.10)]">
      {heading && <div className="mb-0.5 text-[10.5px] text-ink-muted">{heading}</div>}
      {payload.map((entry, index) => {
        const key = String(entry.dataKey ?? entry.name ?? index);
        const seriesConfig = config[key];
        const numeric = typeof entry.value === "number" ? entry.value : Number(entry.value);
        return (
          <div key={key} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[11px] text-ink-muted">
              <span
                className="size-2 shrink-0 rounded-[2px]"
                style={{ background: `var(--color-${key})` }}
              />
              {seriesConfig?.label ?? key}
            </span>
            <span className="font-medium tabular-nums text-ink">
              {Number.isFinite(numeric) && valueFormatter
                ? valueFormatter(numeric)
                : String(entry.value ?? "")}
            </span>
          </div>
        );
      })}
    </div>
  );
}
