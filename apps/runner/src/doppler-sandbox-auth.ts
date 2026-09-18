import { shellQuote } from "@opencompany/agent-runtime";
import {
  loadDopplerConnection,
  loadDopplerConnectionMetadata,
  markDopplerConnectionNeedsReauth,
  markDopplerConnectionValidated,
} from "@opencompany/db/doppler-auth";
import { getDb } from "./db";
import { DopplerAuthRejected, validateDopplerToken } from "./doppler-api";
import { ensureDopplerInstalled, hasDopplerPlugin } from "./doppler-auth";
import type { SandboxHandle } from "./sandbox";

const GENERATION = "/home/user/.opencompany/doppler-generation";
const TOKEN_FILE = "/home/user/.opencompany/doppler-token";
const empty = () => ({ available: false, promptFragment: "", redactionValues: [] as string[] });

export async function clearDopplerAuth(sandbox: SandboxHandle) {
  // Remove cached fallback secrets as well as CLI credentials. Keep no stale cache after access ends.
  await sandbox.commands.run(
    `if test -f ${GENERATION}; then rm -rf /home/user/.doppler && rm -f ${GENERATION}; fi && rm -f ${TOKEN_FILE}`,
    { user: "user", timeoutMs: 30_000 },
  );
}

export async function reconcileDopplerSandboxAuth(input: {
  sandbox: SandboxHandle;
  workspaceId: string | null;
  userWorkosId: string;
}) {
  const { sandbox, workspaceId, userWorkosId: userId } = input;
  if (!workspaceId || !(await hasDopplerPlugin(workspaceId, userId))) {
    await clearDopplerAuth(sandbox);
    return empty();
  }
  const scope = { db: getDb(), workspaceId, userId };
  const metadata = await loadDopplerConnectionMetadata(scope);
  if (!metadata || metadata.status !== "connected") {
    await clearDopplerAuth(sandbox);
    return {
      ...empty(),
      promptFragment:
        "Doppler is not connected. If the repository requires it, ask the user to connect Doppler in Plugins → Doppler.",
    };
  }
  let connection: Awaited<ReturnType<typeof loadDopplerConnection>>;
  try {
    connection = await loadDopplerConnection(scope);
  } catch {
    await clearDopplerAuth(sandbox);
    throw new Error("Doppler credentials could not be prepared. Reconnect Doppler in Plugins.");
  }
  const token = connection?.authBundle?.token;
  if (!token) {
    await clearDopplerAuth(sandbox);
    throw new Error("Doppler credentials are missing. Reconnect Doppler.");
  }
  try {
    await validateDopplerToken(token);
  } catch (error) {
    await clearDopplerAuth(sandbox);
    if (error instanceof DopplerAuthRejected) {
      await markDopplerConnectionNeedsReauth({
        ...scope,
        expectedCredentialGeneration: connection!.credentialGeneration,
        statusReason: error.message,
      });
      return { ...empty(), redactionValues: [token], promptFragment: error.message };
    }
    throw error;
  }
  await markDopplerConnectionValidated({
    ...scope,
    expectedCredentialGeneration: connection!.credentialGeneration,
  });
  await ensureDopplerInstalled(sandbox);
  const generation = await sandbox.commands.run(
    `if test -f ${GENERATION}; then cat ${GENERATION}; fi`,
    { user: "user", timeoutMs: 15_000 },
  );
  if (generation.stdout.trim() !== connection!.credentialGeneration) {
    // Updating just the token preserves the project/config scopes created in existing worktrees.
    await sandbox.commands.run(
      `mkdir -p /home/user/.opencompany /home/user/.doppler && chmod 700 /home/user/.doppler && umask 077 && touch ${TOKEN_FILE} && chmod 600 ${TOKEN_FILE}`,
      { user: "user", timeoutMs: 15_000 },
    );
    try {
      await sandbox.files.write(GENERATION, connection!.credentialGeneration, { user: "user" });
      await sandbox.files.write(TOKEN_FILE, token, { user: "user" });
      await sandbox.commands.run(
        `doppler --no-read-env --no-check-version configure set token --scope / < ${TOKEN_FILE} > /dev/null && chmod 600 /home/user/.doppler/.doppler.yaml`,
        { user: "user", timeoutMs: 15_000 },
      );
    } catch {
      await clearDopplerAuth(sandbox);
      throw new Error("Doppler credentials could not be restored. Please retry.");
    } finally {
      await sandbox.commands.run(`rm -f ${shellQuote(TOKEN_FILE)}`, {
        user: "user",
        timeoutMs: 15_000,
      });
    }
  }
  // A disconnect or replacement during restore must take effect before agent execution.
  const latest = await loadDopplerConnectionMetadata(scope);
  if (
    latest?.status !== "connected" ||
    latest.credentialGeneration !== connection!.credentialGeneration ||
    !(await hasDopplerPlugin(workspaceId, userId))
  ) {
    await clearDopplerAuth(sandbox);
    throw new Error("The Doppler connection changed during sandbox preparation. Retry the turn.");
  }
  return {
    available: true,
    redactionValues: [token],
    promptFragment: [
      "<doppler_cli>",
      "Doppler is installed and authenticated with your connected personal account.",
      "For each new worktree, follow repository instructions and run `doppler setup --no-interactive` before development commands. Keep the repository's project/config directory mappings.",
      "Use existing `doppler run -- ...` scripts to inject secrets. Never print secret values, tokens, CLI config files, or fallback caches.",
      "The CLI has the connected account's permissions. Secret writes require an explicit user request and an exact project/config target. If Doppler rejects authentication, tell the user to reconnect in Plugins → Doppler.",
      "</doppler_cli>",
    ].join("\n"),
  };
}
