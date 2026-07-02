"use server";

import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import { closeGoatChatSessionForUser } from "@/lib/chat";

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
