import { type AgentModelId, isCodexReasoningEffort } from "@opencompany/agent-runtime";
import type { CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import { AUTO_MODEL_SELECTION, type AutoModelSelection } from "@/lib/chat-auto-model";
import {
  CLAUDE_PICKER_VALUE,
  type ClaudePickerValue,
  CODEX_PICKER_VALUE,
  type CodexPickerValue,
  ENGINE_REGISTRY,
  type EngineChatKind,
} from "@/lib/engine-registry";
import { DEFAULT_MODEL, normalizeModel } from "@/lib/model-options";

export type ChatModelSelection =
  | AgentModelId
  | AutoModelSelection
  | CodexPickerValue
  | ClaudePickerValue;

type ChatEngineAvailability = {
  codexConnected: boolean;
  claudeCodeConnected?: boolean;
  autoModelRoutingEnabled?: boolean;
};

const CHAT_SELECTION_STORAGE_KEY = "opencompany-goat-main-chat-selection";
const chatSelectionListeners = new Set<() => void>();
const REASONING_EFFORT_STORAGE_KEY = "opencompany-goat-main-chat-reasoning-effort";
const reasoningEffortListeners = new Set<() => void>();

export function normalizeStoredChatSelection(
  value: unknown,
  availability: ChatEngineAvailability,
): ChatModelSelection {
  if (value === AUTO_MODEL_SELECTION) {
    return availability.autoModelRoutingEnabled ? AUTO_MODEL_SELECTION : DEFAULT_MODEL;
  }
  if (value === CODEX_PICKER_VALUE) {
    return availability.codexConnected ? CODEX_PICKER_VALUE : DEFAULT_MODEL;
  }
  if (value === CLAUDE_PICKER_VALUE) {
    return availability.claudeCodeConnected ? CLAUDE_PICKER_VALUE : DEFAULT_MODEL;
  }
  return normalizeModel(value);
}

export function readLastChatSelection(
  userWorkosId: string,
  availability: ChatEngineAvailability,
): ChatModelSelection {
  if (typeof window === "undefined") return DEFAULT_MODEL;

  try {
    return normalizeStoredChatSelection(
      window.localStorage.getItem(storageKey(userWorkosId)),
      availability,
    );
  } catch {
    return DEFAULT_MODEL;
  }
}

export function persistLastChatSelection(userWorkosId: string, selection: ChatModelSelection) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(storageKey(userWorkosId), selection);
    for (const listener of chatSelectionListeners) listener();
  } catch {
    // Browser storage can be unavailable in locked-down contexts. The in-memory selection
    // still works for the current page, so persistence remains a progressive enhancement.
  }
}

export function subscribeLastChatSelection(onStoreChange: () => void) {
  chatSelectionListeners.add(onStoreChange);

  function handleStorage(event: StorageEvent) {
    if (event.key === null || event.key.startsWith(`${CHAT_SELECTION_STORAGE_KEY}:`)) {
      onStoreChange();
    }
  }

  window.addEventListener("storage", handleStorage);
  return () => {
    chatSelectionListeners.delete(onStoreChange);
    window.removeEventListener("storage", handleStorage);
  };
}

function storageKey(userWorkosId: string) {
  const userKey = userWorkosId.trim() || "anonymous";
  return `${CHAT_SELECTION_STORAGE_KEY}:${userKey}`;
}

// The composer's reasoning dial is a preference, not a per-chat decision: the level you last
// picked for an agent is the level your next chat with that agent should open on. Kept per
// engine because Codex and Claude Code have different sensible defaults, and browser-local
// for the same reason the model selection is — it is a convenience, not workspace state.
export function readLastReasoningEffort(
  userWorkosId: string,
  engine: EngineChatKind,
): CodexReasoningEffort {
  const fallback = ENGINE_REGISTRY[engine].defaultReasoningEffort;
  if (typeof window === "undefined") return fallback;

  try {
    const stored = window.localStorage.getItem(reasoningEffortStorageKey(userWorkosId, engine));
    return typeof stored === "string" && isCodexReasoningEffort(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

export function persistLastReasoningEffort(
  userWorkosId: string,
  engine: EngineChatKind,
  effort: CodexReasoningEffort,
) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(reasoningEffortStorageKey(userWorkosId, engine), effort);
    for (const listener of reasoningEffortListeners) listener();
  } catch {
    // Same progressive-enhancement contract as the model selection: the current page keeps
    // working from in-memory state when storage is unavailable.
  }
}

export function subscribeLastReasoningEffort(onStoreChange: () => void) {
  reasoningEffortListeners.add(onStoreChange);

  function handleStorage(event: StorageEvent) {
    if (event.key === null || event.key.startsWith(`${REASONING_EFFORT_STORAGE_KEY}:`)) {
      onStoreChange();
    }
  }

  window.addEventListener("storage", handleStorage);
  return () => {
    reasoningEffortListeners.delete(onStoreChange);
    window.removeEventListener("storage", handleStorage);
  };
}

function reasoningEffortStorageKey(userWorkosId: string, engine: EngineChatKind) {
  const userKey = userWorkosId.trim() || "anonymous";
  return `${REASONING_EFFORT_STORAGE_KEY}:${userKey}:${engine}`;
}
