import "server-only";

import {
  ChatShareIdSchema,
  createApiClient,
  PublicChatShareEnvelopeSchema,
  PublicChatShareMetadataEnvelopeSchema,
} from "@opencompany/protocol";
import type { ChatUiMessage } from "@/lib/chat-ui";

export type PublicChatMetadata = {
  shareId: string;
  title: string;
  kind: "chat" | "task";
  engine: "opencompany" | "codex" | "claude_code";
};
export type PublicChatView = PublicChatMetadata & {
  messages: ChatUiMessage[];
};

export async function loadPublicChat(shareIdInput: string): Promise<PublicChatView | null> {
  const shareId = validShareId(shareIdInput);
  if (!shareId) return null;
  const response = await publicApiClient().public["chat-shares"][":shareId"].$get({
    param: { shareId },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await publicApiError(response, "Could not load the shared Chat.");
  const envelope = PublicChatShareEnvelopeSchema.parse(await response.json());
  return {
    ...envelope.data,
    messages: envelope.data.messages as unknown as ChatUiMessage[],
  };
}

export async function loadPublicChatMetadata(
  shareIdInput: string,
): Promise<PublicChatMetadata | null> {
  const shareId = validShareId(shareIdInput);
  if (!shareId) return null;
  const response = await publicApiClient().public["chat-shares"][":shareId"].metadata.$get({
    param: { shareId },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await publicApiError(response, "Could not load shared Chat metadata.");
  return PublicChatShareMetadataEnvelopeSchema.parse(await response.json()).data;
}

function validShareId(value: string) {
  const result = ChatShareIdSchema.safeParse(value.trim());
  return result.success ? result.data : null;
}

function publicApiClient() {
  return createApiClient(publicApiOrigin(process.env.GOAT_API_ORIGIN), {
    fetch: (request: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(request, { ...init, cache: "no-store" }),
  });
}

function publicApiOrigin(value: string | undefined) {
  if (!value?.trim()) throw new Error("The canonical API origin is unavailable.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The canonical API origin is invalid.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("The canonical API origin is invalid.");
  }
  return url.origin;
}

async function publicApiError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : fallback;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(`${message}${requestId ? ` (request ${requestId})` : ""}`);
}
