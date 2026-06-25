"use client";

import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "@opencompany/agent-runtime";
import { useLiveQuery } from "@tanstack/react-db";
import { PanelRight, Sparkles } from "lucide-react";
import { useMemo } from "react";
import { findModel } from "@/components/agent-editor/tools";
import { useCollections } from "@/components/CollectionsProvider";
import { useFloatingNavInset } from "@/components/FloatingNavInsetContext";
import { OpenAIIcon } from "@/components/icons/model-provider-icons";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { agentRowToListItem } from "@/lib/collections/selectors";

export function formatUsdMicros(value: number) {
  return `$${(value / 1_000_000).toFixed(4)}`;
}

// The session header line: agent name · model · capability count, with the context-window
// meter and the inspector toggle on the right. Shared between the live session view and the
// optimistic pending view shown while a prompt-started session is being created, so the
// handoff between the two is pixel-stable. Only the fields it reads are required, letting the
// pending view synthesize them before the session row exists.
export function SessionTopBar({
  session,
  currentContextTokens,
  totalCostUsdMicros,
  inspectorCollapsed,
  onToggleInspector,
}: {
  session: {
    agentId: string;
    agentName: string;
    modelName: string;
    engine?: "opencompany" | "codex";
  };
  currentContextTokens: number;
  totalCostUsdMicros: number;
  inspectorCollapsed: boolean;
  onToggleInspector: () => void;
}) {
  const { agents } = useCollections();
  const { data: agentRows } = useLiveQuery((q) => q.from({ agent: agents }));
  const capabilityCount = useMemo(() => {
    const row = agentRows?.find((agent) => agent.id === session.agentId);
    if (!row) return null;
    const config = agentRowToListItem(row).config;
    // `config.tools` already folds MCP servers in (entries with type "mcp"), so tools + MCP is
    // its length; skills are tracked separately.
    return config.tools.length + (config.skills?.length ?? 0);
  }, [agentRows, session.agentId]);

  const model = findModel(session.modelName);
  const ModelIcon = model?.icon ?? Sparkles;
  const modelLabel = model?.label ?? session.modelName.split("/").at(-1) ?? session.modelName;
  const contextMax = model?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  // On the /personal shell the "expand sidebar" button floats over this bar's top-left while the
  // sidebar is collapsed; widen the left padding so the agent name clears it. (false elsewhere.)
  const floatingNavInset = useFloatingNavInset();

  return (
    <header
      className={`flex items-center justify-between gap-3 py-2 pr-6 ${
        floatingNavInset ? "pl-14" : "pl-6"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2 text-[12px] text-ink-muted">
        <span className="truncate font-medium text-ink">{session.agentName}</span>
        <span className="shrink-0 text-ink-subtle/60" aria-hidden>
          ·
        </span>
        {session.engine === "codex" ? (
          <>
            <span className="flex shrink-0 items-center gap-1.5">
              <OpenAIIcon size={12} className="shrink-0 text-ink-muted" />
              <span>Codex</span>
            </span>
            <span className="shrink-0 text-ink-subtle/60" aria-hidden>
              ·
            </span>
            <span className="min-w-0 shrink truncate">{modelLabel}</span>
          </>
        ) : (
          <span className="flex min-w-0 shrink items-center gap-1.5">
            <ModelIcon size={12} className="shrink-0 text-ink-muted" />
            <span className="truncate">{modelLabel}</span>
          </span>
        )}
        {capabilityCount && capabilityCount > 0 ? (
          <>
            <span className="shrink-0 text-ink-subtle/60" aria-hidden>
              ·
            </span>
            <span className="shrink-0">
              {capabilityCount} {capabilityCount === 1 ? "capability" : "capabilities"}
            </span>
          </>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {currentContextTokens > 0 ? (
          <ContextWindowMeter
            used={currentContextTokens}
            max={contextMax}
            totalCostUsdMicros={totalCostUsdMicros}
          />
        ) : null}
        <button
          type="button"
          aria-label={inspectorCollapsed ? "Expand runtime details" : "Collapse runtime details"}
          aria-expanded={!inspectorCollapsed}
          onClick={onToggleInspector}
          className="shrink-0 rounded-md p-1.5 text-ink/55 transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <PanelRight size={15} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  );
}

// Compact token formatter for the context gauge tooltip: 980 → "980", 14_200 → "14k", 1_000_000 → "1M".
function formatCompactTokens(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return `${value}`;
}

// A small ring that fills to the share of the model's context window in use. The exact
// "used / max" figure stays out of the chrome and is surfaced only on hover (native title),
// keeping the top bar quiet. When a cost total is available it appears below the context line.
function ContextWindowMeter({
  used,
  max,
  totalCostUsdMicros,
}: {
  used: number;
  max: number;
  totalCostUsdMicros?: number;
}) {
  const fraction = max > 0 ? Math.min(1, used / max) : 0;
  const size = 14;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const contextDetail = `${formatCompactTokens(used)} / ${formatCompactTokens(max)} context · ${Math.round(
    fraction * 100,
  )}%`;
  const ariaLabel =
    totalCostUsdMicros !== undefined && totalCostUsdMicros > 0
      ? `Context window usage: ${contextDetail} · ${formatUsdMicros(totalCostUsdMicros)} total cost`
      : `Context window usage: ${contextDetail}`;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger
          aria-label={ariaLabel}
          className="flex shrink-0 items-center rounded-full text-ink-muted outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={strokeWidth}
              stroke="currentColor"
              className="text-ink/15"
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={strokeWidth}
              stroke="currentColor"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - fraction)}
              className="text-ink/70 transition-[stroke-dashoffset] duration-500"
            />
          </svg>
        </TooltipTrigger>
        <TooltipContent>
          <div>{contextDetail}</div>
          {totalCostUsdMicros !== undefined && totalCostUsdMicros > 0 ? (
            <div className="mt-0.5 text-ink-muted">
              {formatUsdMicros(totalCostUsdMicros)} total cost
            </div>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
