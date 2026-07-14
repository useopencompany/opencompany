"use server";

import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import { closeGoatChatSessionForUser, setGoatChatSessionPinnedForUser } from "@/lib/chat";

export type CloseGoatChatResult = {
  ok: boolean;
  error: string | null;
};

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
