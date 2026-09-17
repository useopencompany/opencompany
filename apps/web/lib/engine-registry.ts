import type { ConversationRuntimeView } from "@opencompany/agent/chat-ui";
import {
  CLAUDE_CODE_AGENT_MODEL_IDS,
  CLAUDE_CODE_DEFAULT_MODEL_ID,
  CLOUD_CODING_ENGINE_CONFIG,
  type CloudCodingEngine,
  CODEX_AGENT_MODEL_IDS,
  CODEX_DEFAULT_MODEL_ID,
  isClaudeCodeModelId,
  isCloudCodingEngine,
  isCodexModelId,
} from "@opencompany/agent-runtime";
import type { AgentModelId, CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import { AnthropicIcon, type LucideIcon, OpenAIIcon } from "@opencompany/ui/icons";
import {
  DEFAULT_CLAUDE_CHAT_REASONING_EFFORT,
  DEFAULT_CODEX_CHAT_REASONING_EFFORT,
} from "@/lib/codex-chat-settings";
import {
  CLAUDE_CODE_MODELS,
  CODEX_MODELS,
  type ModelOption,
  normalizeConversationModel,
} from "@/lib/model-options";

// A cloud coding engine ("codex" | "claude_code"). Re-exported so callers work off one type
// instead of the two parallel picker-value aliases the two constants files used to export.
export type EngineChatKind = CloudCodingEngine;

export const CODEX_PICKER_VALUE = "codex" satisfies EngineChatKind;
export const CLAUDE_PICKER_VALUE = "claude_code" satisfies EngineChatKind;
export type CodexPickerValue = typeof CODEX_PICKER_VALUE;
export type ClaudePickerValue = typeof CLAUDE_PICKER_VALUE;

export type CodexChatModelId = (typeof CODEX_AGENT_MODEL_IDS)[number];
export type ClaudeChatModelId = (typeof CLAUDE_CODE_AGENT_MODEL_IDS)[number];

export const CODEX_CHAT_DEFAULT_MODEL_ID = CODEX_DEFAULT_MODEL_ID as CodexChatModelId;
export const CLAUDE_CHAT_DEFAULT_MODEL_ID = CLAUDE_CODE_DEFAULT_MODEL_ID as ClaudeChatModelId;

export function normalizeCodexChatModelId(value: unknown): CodexChatModelId {
  return normalizeConversationModel("codex", value);
}

export function normalizeClaudeChatModelId(value: unknown): ClaudeChatModelId {
  return normalizeConversationModel("claude_code", value);
}

export type EngineChatModelId = CodexChatModelId | ClaudeChatModelId;

// The model a chat pins for one engine, or null when it pins none: a Codex chat says nothing
// about which Claude model to use, and an opencompany chat says nothing about either. Distinct
// from normalizeModelId, which answers the same question with the engine default and so cannot
// tell "this chat chose the default" apart from "this chat chose nothing".
export function engineChatModelIdForChat(engine: "codex", value: unknown): CodexChatModelId | null;
export function engineChatModelIdForChat(
  engine: "claude_code",
  value: unknown,
): ClaudeChatModelId | null;
export function engineChatModelIdForChat(
  engine: EngineChatKind,
  value: unknown,
): EngineChatModelId | null;
export function engineChatModelIdForChat(
  engine: EngineChatKind,
  value: unknown,
): AgentModelId | null {
  if (typeof value !== "string") return null;
  if (engine === "codex") return isCodexModelId(value) ? value : null;
  return isClaudeCodeModelId(value) ? value : null;
}

// A cloud coding engine's client-side presentation and model catalog. Adding an engine is a
// single entry here — components read `ENGINE_REGISTRY[engine]` instead of branching on the
// engine string, so no per-engine engine-equality checks leak into the UI.
export type EngineRegistryEntry = {
  engine: EngineChatKind;
  label: string;
  // The value the model picker persists for this engine; identical to the engine key.
  pickerValue: EngineChatKind;
  Icon: LucideIcon;
  models: readonly ModelOption[];
  defaultModelId: CodexChatModelId | ClaudeChatModelId;
  defaultReasoningEffort: CodexReasoningEffort;
  normalizeModelId: (value: unknown) => CodexChatModelId | ClaudeChatModelId;
};

export const ENGINE_REGISTRY = {
  codex: {
    engine: "codex",
    label: CLOUD_CODING_ENGINE_CONFIG.codex.label,
    pickerValue: CODEX_PICKER_VALUE,
    Icon: OpenAIIcon,
    models: CODEX_MODELS,
    defaultModelId: CODEX_CHAT_DEFAULT_MODEL_ID,
    defaultReasoningEffort: DEFAULT_CODEX_CHAT_REASONING_EFFORT,
    normalizeModelId: normalizeCodexChatModelId,
  },
  claude_code: {
    engine: "claude_code",
    label: CLOUD_CODING_ENGINE_CONFIG.claude_code.label,
    pickerValue: CLAUDE_PICKER_VALUE,
    Icon: AnthropicIcon,
    models: CLAUDE_CODE_MODELS,
    defaultModelId: CLAUDE_CHAT_DEFAULT_MODEL_ID,
    defaultReasoningEffort: DEFAULT_CLAUDE_CHAT_REASONING_EFFORT,
    normalizeModelId: normalizeClaudeChatModelId,
  },
} as const satisfies Record<EngineChatKind, EngineRegistryEntry>;

// The label to show for a session's engine. Never defaults to another engine's label: a
// claude_code session reads "Claude Code" even before its runtime has hydrated.
export function engineLabel(engine: EngineChatKind): string {
  return ENGINE_REGISTRY[engine].label;
}

export type ConversationRuntimeMetaKind =
  | "connecting"
  | "queued"
  | "starting"
  | "working"
  | "ready"
  | "asleep"
  | "needs-attention"
  | "stopped";

export type ConversationRuntimeMeta = {
  kind: ConversationRuntimeMetaKind;
  label: string;
  dotClass: string;
  textClass: string;
};

// Maps a conversation runtime to its status chip presentation. Engine-independent: the null
// (pre-hydration) case is "Connecting", not any one engine's label.
function conversationRuntimeMeta(runtime: ConversationRuntimeView | null): ConversationRuntimeMeta {
  if (!runtime) {
    return {
      kind: "connecting",
      label: "Connecting",
      dotClass: "bg-ink/25",
      textClass: "text-ink-subtle",
    };
  }
  if (runtime.status === "queued") {
    return {
      kind: "queued",
      label: "Queued",
      dotClass: "animate-pulse bg-warning",
      textClass: "text-warning",
    };
  }
  if (runtime.status === "starting") {
    return {
      kind: "starting",
      label: "Starting",
      dotClass: "animate-pulse bg-warning",
      textClass: "text-warning",
    };
  }
  if (runtime.status === "running") {
    return {
      kind: "working",
      label: "Working",
      dotClass: "animate-pulse bg-warning",
      textClass: "text-warning",
    };
  }
  if (runtime.status === "failed" || runtime.hasError) {
    return {
      kind: "needs-attention",
      label: "Needs attention",
      dotClass: "bg-danger",
      textClass: "text-danger",
    };
  }
  if (runtime.status === "idle") {
    return { kind: "ready", label: "Ready", dotClass: "bg-success", textClass: "text-success" };
  }
  if (runtime.status === "interrupted" || runtime.status === "closed") {
    return {
      kind: "stopped",
      label: "Stopped",
      dotClass: "bg-ink/30",
      textClass: "text-ink-subtle",
    };
  }
  return {
    kind: "connecting",
    label: "Connecting",
    dotClass: "bg-ink/25",
    textClass: "text-ink-subtle",
  };
}

export type EngineStatusPresentation = ConversationRuntimeMeta & { engineLabel: string };

// Combines the session's engine label with its runtime status. Replaces the old
// codex-defaulting label + runtime-meta pair, so an unhydrated (null runtime) claude_code
// session presents as "Claude Code · Connecting" rather than "Codex · Connecting".
export function statusPresenter(
  engine: EngineChatKind,
  runtime: ConversationRuntimeView | null,
): EngineStatusPresentation {
  return { ...conversationRuntimeMeta(runtime), engineLabel: engineLabel(engine) };
}

export { isCloudCodingEngine };
