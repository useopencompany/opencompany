"use server";

import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type CreateGoatChatShareResult =
  | { ok: true; shareId: string }
  | { ok: false; error: string };

export type GetGoatChatShareResult =
  | { ok: true; shareId: string | null }
  | { ok: false; error: string };

export type RevokeGoatChatShareResult = { ok: true } | { ok: false; error: string };

export async function getGoatChatShareAction(
  sessionId: string | null,
): Promise<GetGoatChatShareResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: false, error: "Could not load sharing settings." };

  const client = await serverApiClient();
  const response = await client.v1.conversations[":conversationId"].share.$get({
    param: { conversationId: trimmed },
  });
  if (!response.ok) {
    return {
      ok: false,
      error: await serverApiErrorMessage(response, "Could not load sharing settings."),
    };
  }
  return { ok: true, shareId: (await response.json()).data.shareId };
}

export async function createGoatChatShareAction(
  sessionId: string | null,
): Promise<CreateGoatChatShareResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: false, error: "Could not share that chat." };

  const client = await serverApiClient();
  const response = await client.v1.conversations[":conversationId"].share.$put({
    param: { conversationId: trimmed },
  });
  if (!response.ok) {
    return {
      ok: false,
      error: await serverApiErrorMessage(response, "Could not share that chat."),
    };
  }
  return { ok: true, shareId: (await response.json()).data.shareId };
}

export async function revokeGoatChatShareAction(
  sessionId: string | null,
): Promise<RevokeGoatChatShareResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: false, error: "Could not stop sharing that chat." };

  const client = await serverApiClient();
  const response = await client.v1.conversations[":conversationId"].share.$delete({
    param: { conversationId: trimmed },
  });
  if (!response.ok) {
    return {
      ok: false,
      error: await serverApiErrorMessage(response, "Could not stop sharing that chat."),
    };
  }

  return { ok: true };
}
