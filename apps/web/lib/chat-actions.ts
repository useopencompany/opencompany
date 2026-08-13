"use server";

import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import { reopenGoatChatSessionForUser, setGoatChatSessionPinnedForUser } from "@/lib/chat";
import { archiveGoatChatSessionForUser } from "@/lib/codex-chat";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type CloseGoatChatResult = {
  ok: boolean;
  error: string | null;
};

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

export async function closeGoatChatSessionAction(
  sessionId: string | null,
): Promise<CloseGoatChatResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: true, error: null };

  const { user } = await currentGoatUser();
  let closed: boolean;
  try {
    closed = await archiveGoatChatSessionForUser({
      userWorkosId: user.workosUserId,
      chatSessionId: trimmed,
    });
  } catch (error) {
    console.error("[goat] Failed to archive chat session", {
      event: "goat.chat_archive_failed",
      chat_session_id: trimmed,
      error,
    });
    return { ok: false, error: "Could not archive that chat." };
  }
  if (!closed) {
    return { ok: false, error: "Could not archive that chat." };
  }

  revalidatePath("/");
  return { ok: true, error: null };
}

export async function reopenGoatChatSessionAction(
  sessionId: string | null,
): Promise<CloseGoatChatResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: false, error: "Could not restore that chat." };

  const { user } = await currentGoatUser();
  const reopened = await reopenGoatChatSessionForUser({
    userWorkosId: user.workosUserId,
    sessionId: trimmed,
  });
  if (!reopened) {
    return { ok: false, error: "Could not restore that chat." };
  }

  revalidatePath("/");
  return { ok: true, error: null };
}

export async function setGoatChatPinnedAction(
  sessionId: string | null,
  pinned: boolean,
): Promise<CloseGoatChatResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: true, error: null };

  const { user } = await currentGoatUser();
  const updated = await setGoatChatSessionPinnedForUser({
    userWorkosId: user.workosUserId,
    sessionId: trimmed,
    pinned,
  });
  if (!updated) {
    return { ok: false, error: pinned ? "Could not pin that chat." : "Could not unpin that chat." };
  }

  revalidatePath("/");
  return { ok: true, error: null };
}
