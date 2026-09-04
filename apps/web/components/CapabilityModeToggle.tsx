"use client";

import { cn } from "@opencompany/ui/lib/utils";
import type { CapabilityMode } from "@/lib/actions/capabilities";

const CAPABILITY_MODE_OPTIONS: Array<{
  mode: CapabilityMode;
  label: string;
}> = [
  { mode: "on", label: "On" },
  { mode: "ask", label: "Ask" },
  { mode: "off", label: "Off" },
];

export function CapabilityModeToggle({
  label,
  mode,
  disabled = false,
  onChange,
}: {
  label: string;
  mode: CapabilityMode;
  disabled?: boolean;
  onChange: (mode: CapabilityMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label={`${label} permission`}
      className="flex shrink-0 items-center rounded-full bg-surface-muted p-0.5"
    >
      {CAPABILITY_MODE_OPTIONS.map((option) => {
        const active = option.mode === mode;
        return (
          <button
            key={option.mode}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(option.mode)}
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 transition-colors duration-150",
              active
                ? "bg-surface text-ink shadow-sm"
                : "text-ink-subtle hover:text-ink disabled:opacity-60",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
