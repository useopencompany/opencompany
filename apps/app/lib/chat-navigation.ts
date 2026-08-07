export const GOAT_HOME_NAVIGATION_EVENT = "goat:home-navigation";
export const GOAT_CHAT_COMPOSER_FOCUS_EVENT = "goat:chat-composer-focus";

let pendingChatComposerFocusSessionId: string | null = null;

const GOAT_CHAT_SESSION_ID_PATTERN =
  /^goat_chat_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newOptimisticChatSessionId() {
  return `goat_chat_${crypto.randomUUID()}`;
}

export function requestChatComposerFocus(sessionId: string) {
  pendingChatComposerFocusSessionId = sessionId;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(GOAT_CHAT_COMPOSER_FOCUS_EVENT, {
      detail: { sessionId },
    }),
  );
}

export function consumePendingChatComposerFocus(sessionId: string | null | undefined) {
  if (!sessionId || pendingChatComposerFocusSessionId !== sessionId) return false;
  pendingChatComposerFocusSessionId = null;
  return true;
}

export function parseOptimisticChatSessionId(value: unknown) {
  if (value === undefined || value === null) {
    return { ok: true as const, sessionId: null };
  }
  if (typeof value !== "string") {
    return { ok: false as const, error: "Invalid new chat session id." };
  }

  const sessionId = value.trim();
  if (!GOAT_CHAT_SESSION_ID_PATTERN.test(sessionId)) {
    return { ok: false as const, error: "Invalid new chat session id." };
  }
  return { ok: true as const, sessionId };
}
