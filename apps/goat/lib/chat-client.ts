type MarkGoatChatSeenResult = {
  ok: boolean;
  error: string | null;
};

export async function markGoatChatSeen(sessionId: string): Promise<MarkGoatChatSeenResult> {
  const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/seen`, {
    method: "POST",
  });
  const body = await response.json().catch(() => null);
  if (isMarkGoatChatSeenResult(body)) return body;

  return {
    ok: false,
    error: errorMessage(body),
  };
}

function isMarkGoatChatSeenResult(value: unknown): value is MarkGoatChatSeenResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.ok === "boolean" &&
    (candidate.error === null || typeof candidate.error === "string")
  );
}

function errorMessage(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const error = (value as Record<string, unknown>).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return "Could not mark that chat as seen.";
}
