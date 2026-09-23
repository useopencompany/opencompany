import {
  type AgentModelId,
  isClaudeCodeReasoningEffort,
  isCodexReasoningEffort,
} from "@opencompany/agent-runtime";
import type { CloudCodingReasoningEffort } from "@opencompany/agent-runtime/types";
import { AUTO_MODEL_SELECTION, type AutoModelSelection } from "@/lib/chat-auto-model";
import {
  CLAUDE_PICKER_VALUE,
  type ClaudeChatModelId,
  type ClaudePickerValue,
  CODEX_PICKER_VALUE,
  type CodexChatModelId,
  type CodexPickerValue,
  ENGINE_REGISTRY,
  type EngineChatKind,
  type EngineChatModelId,
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
const ENGINE_MODEL_STORAGE_KEY = "opencompany-goat-main-chat-engine-model";

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

// Composer preferences the user sets per coding agent: the level and the model you last picked
// for an agent are what your next chat with that agent opens on. Browser-local for the same
// reason the model selection is — a convenience, not workspace state.
//
// Both are the same shape, so they share one store. Only the storage key and how a stored
// string is validated differ; an unreadable or retired value falls back to the engine default.
function engineScopedPreference<T extends string>(
  storageKeyPrefix: string,
  normalize: (stored: string | null, engine: EngineChatKind) => T,
) {
  const listeners = new Set<() => void>();
  const keyFor = (userWorkosId: string, engine: EngineChatKind) =>
    `${storageKeyPrefix}:${userWorkosId.trim() || "anonymous"}:${engine}`;

  function read(userWorkosId: string, engine: EngineChatKind): T {
    if (typeof window === "undefined") return normalize(null, engine);

    try {
      return normalize(window.localStorage.getItem(keyFor(userWorkosId, engine)), engine);
    } catch {
      return normalize(null, engine);
    }
  }

  function persist(userWorkosId: string, engine: EngineChatKind, value: T) {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem(keyFor(userWorkosId, engine), value);
      for (const listener of listeners) listener();
    } catch {
      // Same progressive-enhancement contract as the model selection: the current page keeps
      // working from in-memory state when storage is unavailable.
    }
  }

  function subscribe(onStoreChange: () => void) {
    listeners.add(onStoreChange);

    function handleStorage(event: StorageEvent) {
      if (event.key === null || event.key.startsWith(`${storageKeyPrefix}:`)) onStoreChange();
    }

    window.addEventListener("storage", handleStorage);
    return () => {
      listeners.delete(onStoreChange);
      window.removeEventListener("storage", handleStorage);
    };
  }

  return { read, persist, subscribe };
}

// Kept per engine because Codex and Claude Code have different sensible defaults: dialling one
// down must not drag the other with it.
const reasoningEffortPreference = engineScopedPreference<CloudCodingReasoningEffort>(
  REASONING_EFFORT_STORAGE_KEY,
  (stored, engine) => {
    if (stored !== null) {
      if (engine === "claude_code" && isClaudeCodeReasoningEffort(stored)) return stored;
      if (engine === "codex" && isCodexReasoningEffort(stored)) return stored;
    }
    return ENGINE_REGISTRY[engine].defaultReasoningEffort;
  },
);

const engineModelPreference = engineScopedPreference<EngineChatModelId>(
  ENGINE_MODEL_STORAGE_KEY,
  (stored, engine) => ENGINE_REGISTRY[engine].normalizeModelId(stored),
);

export const readLastReasoningEffort = reasoningEffortPreference.read;
export const persistLastReasoningEffort = reasoningEffortPreference.persist;
export const subscribeLastReasoningEffort = reasoningEffortPreference.subscribe;

// Overloaded per engine so a caller cannot read a Claude model where a Codex one is expected,
// or store one engine's model under the other's key.
export function readLastEngineModel(userWorkosId: string, engine: "codex"): CodexChatModelId;
export function readLastEngineModel(userWorkosId: string, engine: "claude_code"): ClaudeChatModelId;
export function readLastEngineModel(
  userWorkosId: string,
  engine: EngineChatKind,
): EngineChatModelId;
export function readLastEngineModel(
  userWorkosId: string,
  engine: EngineChatKind,
): EngineChatModelId {
  return engineModelPreference.read(userWorkosId, engine);
}

export function persistLastEngineModel(
  userWorkosId: string,
  engine: "codex",
  model: CodexChatModelId,
): void;
export function persistLastEngineModel(
  userWorkosId: string,
  engine: "claude_code",
  model: ClaudeChatModelId,
): void;
export function persistLastEngineModel(
  userWorkosId: string,
  engine: EngineChatKind,
  model: EngineChatModelId,
): void {
  engineModelPreference.persist(userWorkosId, engine, model);
}

export const subscribeLastEngineModel = engineModelPreference.subscribe;
