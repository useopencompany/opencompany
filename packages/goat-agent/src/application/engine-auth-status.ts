import { getDb } from "@opencompany/db/client";
import { loadGoatClaudeCodeAuthStatus } from "@opencompany/db/goat-claude-code-auth";
import { loadGoatCodexAuthStatus } from "@opencompany/db/goat-codex-auth";

type DbLike = ReturnType<typeof getDb>;

export async function isGoatCodexConnectedForUser(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<boolean> {
  const status = await loadGoatCodexAuthStatus({ db, userWorkosId });
  return status?.status === "connected";
}

export async function isGoatClaudeCodeConnectedForUser(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<boolean> {
  const status = await loadGoatClaudeCodeAuthStatus({ db, userWorkosId });
  return status?.status === "connected";
}
