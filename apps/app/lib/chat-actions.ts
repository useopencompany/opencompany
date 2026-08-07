"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import {
  closeChatSessionForUser,
  markChatSessionSeenForUser,
  reopenChatSessionForUser,
  setChatSessionPinnedForUser,
} from "@/lib/chat";
import {
  ensureChatShareForUser,
  findChatShareForUser,
  revokeChatShareForUser,
} from "@/lib/chat-sharing";
import { closeCodexChatSessionForChat } from "@/lib/codex-chat";

export type CloseChatResult = {
  ok: boolean;
  error: string | null;
};

export type CreateChatShareResult = { ok: true; shareId: string } | { ok: false; error: string };

export type GetChatShareResult =
  | { ok: true; shareId: string | null }
  | { ok: false; error: string };

export type RevokeChatShareResult = { ok: true } | { ok: false; error: string };

export async function getChatShareAction(sessionId: string | null): Promise<GetChatShareResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: false, error: "Could not load sharing settings." };

  const { user, workspace } = await currentUser();
  const share = await findChatShareForUser({
    userWorkosId: user.workosUserId,
    workspaceId: workspace.id,
    chatSessionId: trimmed,
  });
  return { ok: true, shareId: share?.id ?? null };
}

export async function createChatShareAction(
  sessionId: string | null,
): Promise<CreateChatShareResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: false, error: "Could not share that chat." };

  const { user, workspace } = await currentUser();
  const share = await ensureChatShareForUser({
    userWorkosId: user.workosUserId,
    workspaceId: workspace.id,
    chatSessionId: trimmed,
  });
  if (!share) return { ok: false, error: "Could not share that chat." };

  return { ok: true, shareId: share.id };
}

export async function revokeChatShareAction(
  sessionId: string | null,
): Promise<RevokeChatShareResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: false, error: "Could not stop sharing that chat." };

  const { user, workspace } = await currentUser();
  const revoked = await revokeChatShareForUser({
    userWorkosId: user.workosUserId,
    workspaceId: workspace.id,
    chatSessionId: trimmed,
  });
  if (!revoked) return { ok: false, error: "Could not stop sharing that chat." };

  return { ok: true };
}

export async function closeChatSessionAction(sessionId: string | null): Promise<CloseChatResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: true, error: null };

  const { user } = await currentUser();
  const closed = await closeChatSessionForUser({
    userWorkosId: user.workosUserId,
    sessionId: trimmed,
  });
  if (!closed) {
    return { ok: false, error: "Could not close that chat." };
  }

  // Best-effort engine cleanup; the chat close itself must not fail on it. No-op for
  // non-Codex chats (there is no matching engine session row).
  await closeCodexChatSessionForChat({
    userWorkosId: user.workosUserId,
    chatSessionId: trimmed,
  }).catch((error) => {
    console.warn("Codex chat close cleanup failed.", {
      event: "goat.codex_chat_close_cleanup_failed",
      chat_session_id: trimmed,
      error,
    });
  });

  revalidatePath("/");
  return { ok: true, error: null };
}

export async function reopenChatSessionAction(sessionId: string | null): Promise<CloseChatResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: false, error: "Could not restore that chat." };

  const { user } = await currentUser();
  const reopened = await reopenChatSessionForUser({
    userWorkosId: user.workosUserId,
    sessionId: trimmed,
  });
  if (!reopened) {
    return { ok: false, error: "Could not restore that chat." };
  }

  revalidatePath("/");
  return { ok: true, error: null };
}

export async function setChatPinnedAction(
  sessionId: string | null,
  pinned: boolean,
): Promise<CloseChatResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: true, error: null };

  const { user } = await currentUser();
  const updated = await setChatSessionPinnedForUser({
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

export async function markChatSeenAction(sessionId: string | null): Promise<CloseChatResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: true, error: null };

  const { user } = await currentUser();
  const updated = await markChatSessionSeenForUser({
    userWorkosId: user.workosUserId,
    sessionId: trimmed,
  });
  if (!updated) return { ok: false, error: "Could not mark that chat as seen." };

  revalidatePath("/");
  return { ok: true, error: null };
}
