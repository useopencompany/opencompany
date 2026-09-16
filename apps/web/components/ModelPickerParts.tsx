"use client";

import type { CloudCodingEngine } from "@opencompany/agent-runtime";
import { AnthropicIcon, OpenAIIcon } from "@opencompany/ui/icons";
import { cn } from "@opencompany/ui/lib/utils";
import { Check, Code2, MessageSquare } from "lucide-react";

export type ModelPickerTab = "chat" | "coding";

export function modelProviderLabel(id: string) {
  const provider = id.split("/")[0] ?? "";
  if (provider === "alibaba") return "Alibaba";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "moonshotai") return "Moonshot";
  if (provider === "openai") return "OpenAI";
  if (provider === "xai") return "SpaceXAI";
  if (provider === "zai") return "Z.ai";
  return provider;
}

export function ModelPickerTabs({
  value,
  onChange,
  chatLabel = "Chat",
}: {
  value: ModelPickerTab;
  onChange: (value: ModelPickerTab) => void;
  chatLabel?: string;
}) {
  return (
    <div className="flex gap-1 border-b border-border p-2 pb-1.5">
      <button
        type="button"
        aria-pressed={value === "chat"}
        onClick={() => onChange("chat")}
        className={cn(
          "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[12.5px] font-medium transition-colors duration-150",
          value === "chat" ? "bg-surface-active text-ink" : "text-ink-subtle hover:text-ink",
        )}
      >
        <MessageSquare size={12} strokeWidth={2} />
        {chatLabel}
      </button>
      <button
        type="button"
        aria-pressed={value === "coding"}
        onClick={() => onChange("coding")}
        className={cn(
          "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[12.5px] font-medium transition-colors duration-150",
          value === "coding" ? "bg-surface-active text-ink" : "text-ink-subtle hover:text-ink",
        )}
      >
        <Code2 size={12} strokeWidth={2} />
        Coding agents
      </button>
    </div>
  );
}

// Coding agents stay visible while disconnected so the picker doubles as the discovery and
// connection path in both chat and workflow editors.
export function CodingAgentOption({
  engine,
  connected,
  selected,
  onSelect,
  onConnect,
}: {
  engine: CloudCodingEngine;
  connected: boolean;
  selected: boolean;
  onSelect: () => void;
  onConnect: () => void;
}) {
  const label = engine === "codex" ? "Codex" : "Claude Code";
  const subscriptionLabel = engine === "codex" ? "ChatGPT" : "Claude";
  const icon =
    engine === "codex" ? (
      <OpenAIIcon size={14} strokeWidth={1.85} className="shrink-0 text-ink-muted" />
    ) : (
      <AnthropicIcon size={14} strokeWidth={1.85} className="shrink-0 text-ink-muted" />
    );
  const header = (
    <>
      <Check
        size={13}
        strokeWidth={2}
        className={cn("shrink-0 text-ink", selected ? "opacity-100" : "opacity-0")}
      />
      {icon}
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate font-medium leading-4",
            connected ? "text-ink" : "text-ink-muted",
          )}
        >
          {label}
        </div>
        <div className="truncate text-[11.5px] leading-4 text-ink-subtle">
          {connected
            ? `Included with your ${subscriptionLabel} subscription`
            : `Connect your ${subscriptionLabel} account to use this`}
        </div>
      </div>
    </>
  );

  if (!connected) {
    return (
      <div className="flex flex-col gap-2 rounded-md px-2 py-1.5">
        <div className="flex items-center gap-2">{header}</div>
        <button
          type="button"
          onClick={onConnect}
          className="ml-[21px] self-start rounded-full border border-border-strong bg-surface px-3 py-1 text-[11.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover"
        >
          Connect {label}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-label={`${label}: included with your ${subscriptionLabel} subscription`}
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-surface-hover"
    >
      {header}
    </button>
  );
}
