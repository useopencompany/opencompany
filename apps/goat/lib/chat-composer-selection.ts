import type { AgentModelId } from "@opencompany/agent-runtime";
import { AUTO_GOAT_MODEL_SELECTION, type AutoGoatModelSelection } from "@/lib/chat-auto-model";
import { CLAUDE_PICKER_VALUE, type ClaudePickerValue } from "@/lib/claude-chat-constants";
import { CODEX_PICKER_VALUE, type CodexPickerValue } from "@/lib/codex-chat-constants";
import { DEFAULT_GOAT_MODEL, normalizeGoatModel } from "@/lib/model-options";

export type GoatChatModelSelection =
  | AgentModelId
  | AutoGoatModelSelection
  | CodexPickerValue
  | ClaudePickerValue;

type GoatChatEngineAvailability = {
  codexConnected: boolean;
  claudeCodeConnected?: boolean;
  autoModelRoutingEnabled?: boolean;
};

const GOAT_CHAT_SELECTION_STORAGE_KEY = "opencompany-goat-main-chat-selection";
const chatSelectionListeners = new Set<() => void>();

export function normalizeStoredGoatChatSelection(
  value: unknown,
  availability: GoatChatEngineAvailability,
): GoatChatModelSelection {
  if (value === AUTO_GOAT_MODEL_SELECTION) {
    return availability.autoModelRoutingEnabled ? AUTO_GOAT_MODEL_SELECTION : DEFAULT_GOAT_MODEL;
  }
  if (value === CODEX_PICKER_VALUE) {
    return availability.codexConnected ? CODEX_PICKER_VALUE : DEFAULT_GOAT_MODEL;
  }
  if (value === CLAUDE_PICKER_VALUE) {
    return availability.claudeCodeConnected ? CLAUDE_PICKER_VALUE : DEFAULT_GOAT_MODEL;
  }
  return normalizeGoatModel(value);
}

export function readLastGoatChatSelection(
  userWorkosId: string,
  availability: GoatChatEngineAvailability,
): GoatChatModelSelection {
  if (typeof window === "undefined") return DEFAULT_GOAT_MODEL;

  try {
    return normalizeStoredGoatChatSelection(
      window.localStorage.getItem(storageKey(userWorkosId)),
      availability,
    );
  } catch {
    return DEFAULT_GOAT_MODEL;
  }
}

export function persistLastGoatChatSelection(
  userWorkosId: string,
  selection: GoatChatModelSelection,
) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(storageKey(userWorkosId), selection);
    for (const listener of chatSelectionListeners) listener();
  } catch {
    // Browser storage can be unavailable in locked-down contexts. The in-memory selection
    // still works for the current page, so persistence remains a progressive enhancement.
  }
}

export function subscribeLastGoatChatSelection(onStoreChange: () => void) {
  chatSelectionListeners.add(onStoreChange);

  function handleStorage(event: StorageEvent) {
    if (event.key === null || event.key.startsWith(`${GOAT_CHAT_SELECTION_STORAGE_KEY}:`)) {
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
  return `${GOAT_CHAT_SELECTION_STORAGE_KEY}:${userKey}`;
}
