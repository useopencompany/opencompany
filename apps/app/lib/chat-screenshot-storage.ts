export function goatChatScreenshotFilename() {
  return `${Date.now()}-${crypto.randomUUID()}.png`;
}

export function goatChatScreenshotBlobPath(input: {
  userWorkosId: string;
  chatSessionId: string;
  filename: string;
}) {
  return [
    "goat-chat",
    safePathSegment(input.userWorkosId),
    "screenshots",
    safePathSegment(input.chatSessionId),
    safeScreenshotFilename(input.filename),
  ].join("/");
}

export function goatChatScreenshotUrl(input: { chatSessionId: string; filename: string }) {
  return `/api/chat-screenshots/${encodeURIComponent(input.chatSessionId)}/${encodeURIComponent(
    safeScreenshotFilename(input.filename),
  )}`;
}

export function safeScreenshotFilename(value: string) {
  if (!/^[a-zA-Z0-9_-]+\.png$/.test(value)) {
    throw new Error("Invalid chat screenshot filename.");
  }
  return value;
}

function safePathSegment(value: string) {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
  if (!normalized) throw new Error("Screenshot storage path segment is empty.");
  return normalized;
}
