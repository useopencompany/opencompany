export const GOAT_HOME_NAVIGATION_EVENT = "goat:home-navigation";

const GOAT_CHAT_SESSION_ID_PATTERN =
  /^goat_chat_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newOptimisticGoatChatSessionId() {
  return `goat_chat_${crypto.randomUUID()}`;
}

export function parseOptimisticGoatChatSessionId(value: unknown) {
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
