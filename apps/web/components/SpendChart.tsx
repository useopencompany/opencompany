"use client";

import { useState } from "react";

export type SpendCategory = "chat" | "ingestion" | "capabilities" | "other";

export type SpendDay = {
  day: string;
  chat: number;
  ingestion: number;
  capabilities: number;
  other: number;
  total: number;
};

export type SpendSeries = { key: SpendCategory; label: string; total: number };

// Validated categorical palette (six-checks pass, light + dark); tokens live in globals.css.
const BAR_CLASS: Record<SpendCategory, string> = {
  chat: "bg-spend-chat",
  ingestion: "bg-spend-ingestion",
  capabilities: "bg-spend-capabilities",
  other: "bg-spend-other",
};

const PLOT_HEIGHT_CLASS = "h-44"; // 176px

export function formatUsdMicros(usdMicros: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(usdMicros / 1_000_000);
}

function formatAxis(usdMicros: number) {
  const v = usdMicros / 1_000_000;
  if (v <= 0) return "$0";
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  if (v >= 10 || Number.isInteger(v)) return `$${Math.round(v)}`;
  return `$${v.toFixed(1)}`;
}

function formatDay(day: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00.000Z`));
}

// Round a dollar amount up to a clean axis ceiling so the tallest bar fills the plot
// without a stunted gap and the midpoint tick stays a round number.
function niceCeilUsd(dollars: number) {
  if (dollars <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(dollars));
  const n = dollars / pow;
  const step = [1, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => n <= s) ?? 10;
  return step * pow;
}

export function SpendChart({ days, series }: { days: SpendDay[]; series: SpendSeries[] }) {
  const [active, setActive] = useState<number | null>(null);

  const n = days.length;
  const maxTotal = Math.max(0, ...days.map((d) => d.total));
  const niceMax = niceCeilUsd(maxTotal / 1_000_000) * 1_000_000;
  const grandTotal = series.reduce((sum, s) => sum + s.total, 0);
  const labelStep = Math.max(1, Math.ceil(n / 6));
  const gridVals = [niceMax, niceMax / 2, 0];
  const activeDay = active != null ? days[active] : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Plot: y-axis gutter + stacked columns */}
      <div className="flex gap-2">
        <div className={`relative w-9 shrink-0 ${PLOT_HEIGHT_CLASS}`}>
          {gridVals.map((g, i) => (
            <span
              key={g}
              style={{ top: `${(i / (gridVals.length - 1)) * 100}%` }}
              className="absolute right-0 -translate-y-1/2 text-[10px] tabular-nums text-ink-subtle"
            >
              {formatAxis(g)}
            </span>
          ))}
        </div>

        <div className={`relative flex-1 ${PLOT_HEIGHT_CLASS}`}>
          {gridVals.map((g, i) => (
            <span
              key={g}
              style={{ top: `${(i / (gridVals.length - 1)) * 100}%` }}
              className="absolute inset-x-0 h-px -translate-y-1/2 bg-border"
            />
          ))}

          <div className="absolute inset-0 flex items-stretch gap-[2px]">
            {days.map((d, i) => {
              const present = series.filter((s) => d[s.key] > 0);
              const topKey = present.at(-1)?.key ?? null;
              const isActive = active === i;
              const parts = present.map((s) => `${s.label} ${formatUsdMicros(d[s.key])}`);
              return (
                // biome-ignore lint/a11y/useSemanticElements: focusable data mark, not a control
                <div
                  key={d.day}
                  role="img"
                  aria-label={`${formatDay(d.day)}: ${formatUsdMicros(d.total)} total${
                    parts.length ? ` — ${parts.join(", ")}` : ""
                  }`}
                  tabIndex={0}
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  className={`flex max-w-[24px] flex-1 flex-col-reverse gap-[2px] rounded-t-[3px] outline-none transition-[filter] focus-visible:ring-1 focus-visible:ring-ink/25 ${
                    isActive ? "brightness-110" : ""
                  }`}
                >
                  {series.map((s) => {
                    const v = d[s.key];
                    if (v <= 0) return null;
                    return (
                      <div
                        key={s.key}
                        style={{ height: `${(v / niceMax) * 100}%` }}
                        className={`w-full ${BAR_CLASS[s.key]} ${
                          s.key === topKey ? "rounded-t-[3px]" : ""
                        }`}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>

          {activeDay ? (
            <div
              style={{
                left: `${((active! + 0.5) / n) * 100}%`,
                bottom: `calc(${Math.min(activeDay.total / niceMax, 0.82) * 100}% + 8px)`,
                transform: `translateX(${active! < n * 0.15 ? "0%" : active! > n * 0.85 ? "-100%" : "-50%"})`,
              }}
              className="pointer-events-none absolute z-10 w-max max-w-[220px] rounded-lg border border-border bg-surface p-2.5 shadow-md"
            >
              <div className="mb-1.5 text-[11px] font-medium text-ink-subtle">
                {formatDay(activeDay.day)}
              </div>
              <div className="flex flex-col gap-1">
                {series
                  .filter((s) => activeDay[s.key] > 0)
                  .map((s) => (
                    <div key={s.key} className="flex items-center gap-2 text-[12px]">
                      <span className={`h-0.5 w-2.5 shrink-0 rounded-full ${BAR_CLASS[s.key]}`} />
                      <span className="text-ink-subtle">{s.label}</span>
                      <span className="ml-auto pl-3 font-medium tabular-nums text-ink">
                        {formatUsdMicros(activeDay[s.key])}
                      </span>
                    </div>
                  ))}
                <div className="mt-1 flex items-center gap-2 border-t border-border pt-1 text-[12px]">
                  <span className="text-ink-subtle">Total</span>
                  <span className="ml-auto font-semibold tabular-nums text-ink">
                    {formatUsdMicros(activeDay.total)}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* X-axis labels, aligned under the plot columns */}
      <div className="flex gap-2">
        <div className="w-9 shrink-0" />
        <div className="flex flex-1 gap-[2px]">
          {days.map((d, i) => (
            <span
              key={d.day}
              className="max-w-[24px] flex-1 text-center text-[10px] tabular-nums text-ink-subtle"
            >
              {i % labelStep === 0 ? formatDay(d.day) : ""}
            </span>
          ))}
        </div>
      </div>

      {/* Legend doubles as the category breakdown (identity channel + contrast relief) */}
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 pt-1">
        {series.map((s) => (
          <div key={s.key} className="flex items-center gap-2 text-[12px]">
            <span className={`h-2 w-2 shrink-0 rounded-[2px] ${BAR_CLASS[s.key]}`} />
            <span className="text-ink">{s.label}</span>
            <span className="font-medium tabular-nums text-ink">{formatUsdMicros(s.total)}</span>
            {grandTotal > 0 ? (
              <span className="tabular-nums text-ink-subtle">
                {Math.round((s.total / grandTotal) * 100)}%
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
