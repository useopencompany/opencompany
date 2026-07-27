"use server";

import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import {
  closeGoatChatSessionForUser,
  reopenGoatChatSessionForUser,
  setGoatChatSessionPinnedForUser,
} from "@/lib/chat";
import { ensureGoatChatShareForUser } from "@/lib/chat-sharing";
import { closeGoatCodexChatSessionForChat } from "@/lib/codex-chat";

export type CloseGoatChatResult = {
  ok: boolean;
  error: string | null;
};

export type CreateGoatChatShareResult =
  | { ok: true; shareId: string }
  | { ok: false; error: string };

export async function createGoatChatShareAction(
  sessionId: string | null,
): Promise<CreateGoatChatShareResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: false, error: "Could not share that chat." };

  const { user } = await currentGoatUser();
  const share = await ensureGoatChatShareForUser({
    userWorkosId: user.workosUserId,
    chatSessionId: trimmed,
  });
  if (!share) return { ok: false, error: "Could not share that chat." };

  return { ok: true, shareId: share.id };
}

export async function closeGoatChatSessionAction(
  sessionId: string | null,
): Promise<CloseGoatChatResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: true, error: null };

  const { user } = await currentGoatUser();
  const closed = await closeGoatChatSessionForUser({
    userWorkosId: user.workosUserId,
    sessionId: trimmed,
  });
  if (!closed) {
    return { ok: false, error: "Could not close that chat." };
  }

  // Best-effort engine cleanup; the chat close itself must not fail on it. No-op for
  // non-Codex chats (there is no matching engine session row).
  await closeGoatCodexChatSessionForChat({
    userWorkosId: user.workosUserId,
    chatSessionId: trimmed,
  }).catch((error) => {
    console.warn("Goat codex chat close cleanup failed.", {
      event: "goat.codex_chat_close_cleanup_failed",
      chat_session_id: trimmed,
      error,
    });
  });

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
