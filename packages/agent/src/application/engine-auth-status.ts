import { loadClaudeCodeAuthStatus } from "@opencompany/db/claude-code-auth";
import { getDb } from "@opencompany/db/client";
import { loadCodexAuthStatus } from "@opencompany/db/codex-auth";

type DbLike = ReturnType<typeof getDb>;

export async function isCodexConnectedForUser(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<boolean> {
  const status = await loadCodexAuthStatus({ db, userWorkosId });
  return status?.status === "connected";
}

export async function isClaudeCodeConnectedForUser(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<boolean> {
  const status = await loadClaudeCodeAuthStatus({ db, userWorkosId });
  return status?.status === "connected";
}
