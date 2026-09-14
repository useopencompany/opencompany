"use client";

import { cn } from "@opencompany/ui/lib/utils";
import type * as React from "react";

type FilterPillOption<TValue extends string> = {
  value: TValue;
  label: string;
  /** Rendered after the label as the number of items behind this filter. */
  count?: number;
  /** Rendered instead of a count when the filter is not a live scope yet, e.g. "Soon". */
  badge?: string;
  disabled?: boolean;
};

/**
 * Single-select filter pills — the standard way to switch a list between scopes.
 *
 * The selected pill carries a filled `secondary` surface and full-strength text; unselected pills
 * are label-only. Avoid rendering this on a `muted` surface: the selected state relies on the pill
 * being darker than what sits behind it.
 */
function FilterPills<TValue extends string>({
  label,
  options,
  value,
  onChange,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "onChange" | "children"> & {
  label: string;
  options: readonly FilterPillOption<TValue>[];
  value: TValue;
  onChange: (value: TValue) => void;
}) {
  return (
    <div
      data-slot="filter-pills"
      role="group"
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-1", className)}
      {...props}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50",
              selected
                ? "bg-secondary font-medium text-secondary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {option.label}
            {option.badge ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
                {option.badge}
              </span>
            ) : option.count === undefined ? null : (
              <span className="text-[12px] tabular-nums text-muted-foreground">{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export { type FilterPillOption, FilterPills };
