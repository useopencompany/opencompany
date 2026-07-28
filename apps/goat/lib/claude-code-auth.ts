"use server";

import { getDb } from "@opencompany/db/client";
import {
  deleteGoatClaudeCodeCredential,
  saveGoatClaudeCodeCredential,
} from "@opencompany/db/goat-claude-code-auth";
import { goatClaudeCodeCredentials } from "@opencompany/db/goat-schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";

export type GoatClaudeCodeAuthSettings = {
  status: "connected" | "needs_reauth" | null;
  statusReason: string | null;
  lastValidatedAt: string | null;
  lastRotatedAt: string | null;
};

// Long-lived OAuth tokens from `claude setup-token` are prefixed sk-ant-oat.
const CLAUDE_CODE_TOKEN_PREFIX = "sk-ant-oat";
const CLAUDE_CODE_TOKEN_MAX_LENGTH = 512;

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
  const trimmed = token.trim();
  if (!trimmed) {
    return { ok: false as const, error: "Paste the token printed by `claude setup-token`." };
  }
  if (!trimmed.startsWith(CLAUDE_CODE_TOKEN_PREFIX)) {
    return {
      ok: false as const,
      error: "That doesn't look like a Claude Code token (expected it to start with sk-ant-oat).",
    };
  }
  if (trimmed.length > CLAUDE_CODE_TOKEN_MAX_LENGTH || /\s/.test(trimmed)) {
    return { ok: false as const, error: "That doesn't look like a valid Claude Code token." };
  }

  const { user } = await currentGoatUser();
  await saveGoatClaudeCodeCredential({
    db: getDb(),
    userWorkosId: user.workosUserId,
    authJson: { token: trimmed },
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
