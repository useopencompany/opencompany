"use server";

import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import {
  markGoatChatSessionSeenForUser,
  reopenGoatChatSessionForUser,
  setGoatChatSessionPinnedForUser,
} from "@/lib/chat";
import {
  ensureGoatChatShareForUser,
  findGoatChatShareForUser,
  revokeGoatChatShareForUser,
} from "@/lib/chat-sharing";
import { archiveGoatChatSessionForUser } from "@/lib/codex-chat";

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

  const { user, workspace } = await currentGoatUser();
  const share = await findGoatChatShareForUser({
    userWorkosId: user.workosUserId,
    workspaceId: workspace.id,
    chatSessionId: trimmed,
  });
  return { ok: true, shareId: share?.id ?? null };
}

export async function createGoatChatShareAction(
  sessionId: string | null,
): Promise<CreateGoatChatShareResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: false, error: "Could not share that chat." };

  const { user, workspace } = await currentGoatUser();
  const share = await ensureGoatChatShareForUser({
    userWorkosId: user.workosUserId,
    workspaceId: workspace.id,
    chatSessionId: trimmed,
  });
  if (!share) return { ok: false, error: "Could not share that chat." };

  return { ok: true, shareId: share.id };
}

export async function revokeGoatChatShareAction(
  sessionId: string | null,
): Promise<RevokeGoatChatShareResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: false, error: "Could not stop sharing that chat." };

  const { user, workspace } = await currentGoatUser();
  const revoked = await revokeGoatChatShareForUser({
    userWorkosId: user.workosUserId,
    workspaceId: workspace.id,
    chatSessionId: trimmed,
  });
  if (!revoked) return { ok: false, error: "Could not stop sharing that chat." };

  return { ok: true };
}

export async function closeGoatChatSessionAction(
  sessionId: string | null,
): Promise<CloseGoatChatResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: true, error: null };

  const { user } = await currentGoatUser();
  const closed = await archiveGoatChatSessionForUser({
    userWorkosId: user.workosUserId,
    chatSessionId: trimmed,
  });
  if (!closed) {
    return { ok: false, error: "Could not close that chat." };
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

export async function markGoatChatSeenAction(
  sessionId: string | null,
): Promise<CloseGoatChatResult> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return { ok: true, error: null };

  const { user } = await currentGoatUser();
  const updated = await markGoatChatSessionSeenForUser({
    userWorkosId: user.workosUserId,
    sessionId: trimmed,
  });
  if (!updated) return { ok: false, error: "Could not mark that chat as seen." };

  revalidatePath("/");
  return { ok: true, error: null };
}
