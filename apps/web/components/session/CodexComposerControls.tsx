"use client";

import { CODEX_REASONING_EFFORTS } from "@opencompany/agent-runtime";
import type { CodexReasoningEffort } from "@opencompany/agent-runtime/types";

function codexReasoningLabel(effort: CodexReasoningEffort) {
  return effort === "xhigh" ? "XHigh" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

// Advances to the next reasoning effort, wrapping xhigh -> low, so the toolbar pill
// cycles through every level on repeated clicks instead of opening a dropdown.
export function nextCodexReasoningEffort(current: CodexReasoningEffort): CodexReasoningEffort {
  const idx = CODEX_REASONING_EFFORTS.indexOf(current);
  return CODEX_REASONING_EFFORTS[(idx + 1) % CODEX_REASONING_EFFORTS.length] ?? current;
}

// Four ascending bars; the first N (N = the level's 1-based rank, low=1 ... xhigh=4)
// render at full strength and the rest fade out, so the icon reads as a signal meter.
function ReasoningBars({ effort, size = 12 }: { effort: CodexReasoningEffort; size?: number }) {
  const active = CODEX_REASONING_EFFORTS.indexOf(effort) + 1;
  const bars = [
    { x: 1, height: 4.5 },
    { x: 5, height: 7 },
    { x: 9, height: 9.5 },
    { x: 13, height: 12 },
  ];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className="shrink-0"
      aria-hidden="true"
    >
      {bars.map((bar, i) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={14 - bar.height}
          width={2}
          height={bar.height}
          rx={1}
          fill="currentColor"
          opacity={i < active ? 1 : 0.28}
        />
      ))}
    </svg>
  );
}

export function CodexComposerControls({
  reasoningEffort,
  planModeEnabled,
  onReasoningEffortChange,
  onPlanModeEnabledChange,
}: {
  reasoningEffort: CodexReasoningEffort;
  planModeEnabled: boolean;
  onReasoningEffortChange: (reasoningEffort: CodexReasoningEffort) => void;
  onPlanModeEnabledChange: (enabled: boolean) => void;
}) {
  const label = codexReasoningLabel(reasoningEffort);
  return (
    <>
      <button
        type="button"
        onClick={() => onReasoningEffortChange(nextCodexReasoningEffort(reasoningEffort))}
        aria-label={`Codex reasoning effort: ${label} (click to cycle)`}
        title="Reasoning effort - click to cycle"
        className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] font-medium text-ink-muted transition-colors hover:bg-surface-subtle/70 hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <ReasoningBars effort={reasoningEffort} size={12} />
        {label}
      </button>
      <button
        type="button"
        aria-pressed={planModeEnabled}
        title="Plan mode for the next message"
        onClick={() => onPlanModeEnabledChange(!planModeEnabled)}
        className={
          planModeEnabled
            ? "flex h-6 items-center gap-1.5 rounded-md bg-ink px-1.5 text-[11.5px] font-medium text-surface transition-colors hover:bg-ink/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            : "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] font-medium text-ink-muted transition-colors hover:bg-surface-subtle/70 hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        }
      >
        Plan
      </button>
    </>
  );
}
