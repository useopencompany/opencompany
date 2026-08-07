"use server";

import {
  deleteGoatClaudeCodeCredential,
  saveGoatClaudeCodeCredential,
} from "@opencompany/db/claude-code-auth";
import { getDb } from "@opencompany/db/client";
import { goatClaudeCodeCredentials } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import { validateGoatClaudeCodeToken } from "@/lib/claude-code-token";

export type GoatClaudeCodeAuthSettings = {
  status: "connected" | "needs_reauth" | null;
  statusReason: string | null;
  lastValidatedAt: string | null;
  lastRotatedAt: string | null;
};

export async function loadCurrentGoatClaudeCodeAuthSettings(): Promise<GoatClaudeCodeAuthSettings> {
  const { user } = await currentGoatUser();
  return loadGoatClaudeCodeAuthSettingsForUser(user.workosUserId);
}

export async function loadGoatClaudeCodeAuthSettingsForUser(
  userWorkosId: string,
): Promise<GoatClaudeCodeAuthSettings> {
  const [row] = await getDb()
    .select({
      status: goatClaudeCodeCredentials.status,
      statusReason: goatClaudeCodeCredentials.statusReason,
      lastValidatedAt: goatClaudeCodeCredentials.lastValidatedAt,
      lastRotatedAt: goatClaudeCodeCredentials.lastRotatedAt,
    })
    .from(goatClaudeCodeCredentials)
    .where(eq(goatClaudeCodeCredentials.userWorkosId, userWorkosId))
    .limit(1);

  return {
    status: row?.status ?? null,
    statusReason: row?.statusReason ?? null,
    lastValidatedAt: row?.lastValidatedAt?.toISOString() ?? null,
    lastRotatedAt: row?.lastRotatedAt?.toISOString() ?? null,
  };
}

export async function isGoatClaudeCodeConnectedForUser(userWorkosId: string) {
  const settings = await loadGoatClaudeCodeAuthSettingsForUser(userWorkosId);
  return settings.status === "connected";
}

export async function saveGoatClaudeCodeToken(token: string) {
  const validated = validateGoatClaudeCodeToken(token);
  if (!validated.ok) return validated;

  const { user } = await currentGoatUser();
  await saveGoatClaudeCodeCredential({
    db: getDb(),
    userWorkosId: user.workosUserId,
    authJson: { token: validated.token },
    validatedAt: null,
  });
  revalidatePath("/settings");
  return { ok: true as const };
}

export async function disconnectGoatClaudeCodeAuth() {
  const { user } = await currentGoatUser();
  await deleteGoatClaudeCodeCredential({ db: getDb(), userWorkosId: user.workosUserId });
  revalidatePath("/settings");
  return { ok: true as const };
}
