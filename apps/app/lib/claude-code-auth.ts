"use server";

import {
  deleteClaudeCodeCredential,
  saveClaudeCodeCredential,
} from "@opencompany/db/claude-code-auth";
import { getDb } from "@opencompany/db/client";
import { claudeCodeCredentials } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { validateClaudeCodeToken } from "@/lib/claude-code-token";

export type ClaudeCodeAuthSettings = {
  status: "connected" | "needs_reauth" | null;
  statusReason: string | null;
  lastValidatedAt: string | null;
  lastRotatedAt: string | null;
};

export async function loadCurrentClaudeCodeAuthSettings(): Promise<ClaudeCodeAuthSettings> {
  const { user } = await currentUser();
  return loadClaudeCodeAuthSettingsForUser(user.workosUserId);
}

export async function loadClaudeCodeAuthSettingsForUser(
  userWorkosId: string,
): Promise<ClaudeCodeAuthSettings> {
  const [row] = await getDb()
    .select({
      status: claudeCodeCredentials.status,
      statusReason: claudeCodeCredentials.statusReason,
      lastValidatedAt: claudeCodeCredentials.lastValidatedAt,
      lastRotatedAt: claudeCodeCredentials.lastRotatedAt,
    })
    .from(claudeCodeCredentials)
    .where(eq(claudeCodeCredentials.userWorkosId, userWorkosId))
    .limit(1);

  return {
    status: row?.status ?? null,
    statusReason: row?.statusReason ?? null,
    lastValidatedAt: row?.lastValidatedAt?.toISOString() ?? null,
    lastRotatedAt: row?.lastRotatedAt?.toISOString() ?? null,
  };
}

export async function isClaudeCodeConnectedForUser(userWorkosId: string) {
  const settings = await loadClaudeCodeAuthSettingsForUser(userWorkosId);
  return settings.status === "connected";
}

export async function saveClaudeCodeToken(token: string) {
  const validated = validateClaudeCodeToken(token);
  if (!validated.ok) return validated;

  const { user } = await currentUser();
  await saveClaudeCodeCredential({
    db: getDb(),
    userWorkosId: user.workosUserId,
    authJson: { token: validated.token },
    validatedAt: null,
  });
  revalidatePath("/settings");
  return { ok: true as const };
}

export async function disconnectClaudeCodeAuth() {
  const { user } = await currentUser();
  await deleteClaudeCodeCredential({ db: getDb(), userWorkosId: user.workosUserId });
  revalidatePath("/settings");
  return { ok: true as const };
}
