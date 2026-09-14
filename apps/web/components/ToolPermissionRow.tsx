"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@opencompany/ui/components/select";
import { cn } from "@opencompany/ui/lib/utils";
import type { CapabilityMode, ToolMode } from "@/lib/actions/capabilities";

export const TOOL_MODE_LABELS: Record<CapabilityMode, string> = {
  on: "On",
  ask: "Ask",
  off: "Off",
};

/**
 * One discovered tool and the permission it actually runs under. The trigger always shows the
 * effective mode so a group's tool list can be read top to bottom; muted means the tool follows
 * its group, and full ink with a dot means someone set this row by hand.
 */
export function ToolPermissionRow({
  name,
  description,
  effectiveMode,
  inheritedMode,
  inheritLabel,
  overridden,
  disabled = false,
  onChange,
}: {
  name: string;
  description: string | null;
  effectiveMode: CapabilityMode;
  /** What the tool falls back to when it is released — named in the menu so it is never a guess. */
  inheritedMode: CapabilityMode;
  inheritLabel: string;
  overridden: boolean;
  disabled?: boolean;
  onChange: (mode: ToolMode) => void;
}) {
  return (
    <li className="flex items-start justify-between gap-3 border-b border-border/70 px-3 py-2 last:border-b-0">
      <div className="min-w-0">
        <p className="text-[12px] font-medium leading-4 text-ink">{name}</p>
        {description ? (
          <p className="mt-0.5 text-[11.5px] leading-4 text-ink-subtle">{description}</p>
        ) : null}
      </div>
      <Select
        value={overridden ? effectiveMode : "inherit"}
        disabled={disabled}
        onValueChange={(next) => onChange(next as ToolMode)}
      >
        <SelectTrigger
          aria-label={`Permission for ${name}`}
          className={cn(
            "h-7 w-[106px] shrink-0 gap-1.5 px-2 text-[12px]",
            overridden
              ? "text-ink"
              : "border-transparent bg-transparent text-ink-subtle shadow-none",
          )}
        >
          <SelectValue>
            <span className="flex items-center gap-1.5">
              {overridden ? <span className="size-1.5 rounded-full bg-ink-muted" /> : null}
              {TOOL_MODE_LABELS[effectiveMode]}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">
            {inheritLabel} ({TOOL_MODE_LABELS[inheritedMode]})
          </SelectItem>
          <SelectItem value="on">On</SelectItem>
          <SelectItem value="ask">Ask</SelectItem>
          <SelectItem value="off">Off</SelectItem>
        </SelectContent>
      </Select>
    </li>
  );
}
