import { shellQuote } from "@opencompany/agent-runtime";
import {
  type InfisicalAuthBundle,
  loadInfisicalConnection,
  loadInfisicalConnectionMetadata,
  markInfisicalConnectionNeedsReauth,
  markInfisicalConnectionValidated,
} from "@opencompany/db/infisical-auth";
import { getWorkspaceRole } from "@opencompany/db/workspaces";
import { createLogger } from "@opencompany/observability";
import { getDb } from "./db";
import { INFISICAL_CLI_LINUX_AMD64_SHA256, INFISICAL_CLI_VERSION } from "./infisical-version";
import type { SandboxHandle } from "./sandbox";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "infisical-sandbox-auth",
});

const INFISICAL_CONFIG_ROOT = "/home/user/.infisical";
const INFISICAL_KEYRING_ROOT = "/home/user/infisical-keyring";
const INFISICAL_GENERATION_PATH = "/home/user/.opencompany/infisical-generation";
const INFISICAL_VALIDATION_INTERVAL_MS = 6 * 60 * 60_000;
const INFISICAL_BUNDLE_MAX_BYTES = 512 * 1024;

export type InfisicalSandboxAuth = {
  available: boolean;
  promptFragment: string;
  redactionValues: string[];
};

export async function reconcileInfisicalSandboxAuth(input: {
  sandbox: SandboxHandle;
  workspaceId: string | null;
  userWorkosId: string;
}): Promise<InfisicalSandboxAuth> {
  if (!input.workspaceId) return unavailableAuth();

  const db = getDb();
  const role = await getWorkspaceRole(
    { workspaceId: input.workspaceId, userWorkosId: input.userWorkosId },
    { db },
  );
  if (!role) {
    await clearInfisicalAuth(input.sandbox);
    return unavailableAuth();
  }

  const metadata = await loadInfisicalConnectionMetadata({
    db,
    workspaceId: input.workspaceId,
  });
  if (!metadata || metadata.status === "disconnected") {
    await reconcileDisconnectedGeneration(
      input.sandbox,
      metadata?.credentialGeneration ?? "not-connected",
    );
    return unavailableAuth();
  }
  if (metadata.status === "needs_reauth") {
    await reconcileDisconnectedGeneration(input.sandbox, metadata.credentialGeneration);
    return needsReauthAuth();
  }
  if (metadata.expiresAt && metadata.expiresAt <= new Date()) {
    await markNeedsReauth({
      workspaceId: input.workspaceId,
      credentialGeneration: metadata.credentialGeneration,
      reason: "The Infisical login expired. Reconnect Infisical in workspace settings.",
    });
    await reconcileDisconnectedGeneration(input.sandbox, metadata.credentialGeneration);
    return needsReauthAuth();
  }

  let connection: Awaited<ReturnType<typeof loadInfisicalConnection>>;
  try {
    connection = await loadInfisicalConnection({ db, workspaceId: input.workspaceId });
  } catch {
    await markNeedsReauth({
      workspaceId: input.workspaceId,
      credentialGeneration: metadata.credentialGeneration,
      reason: "Infisical credentials could not be decrypted. Reconnect Infisical in settings.",
    });
    await reconcileDisconnectedGeneration(input.sandbox, metadata.credentialGeneration);
    return needsReauthAuth();
  }
  if (!connection?.authBundle) {
    await reconcileDisconnectedGeneration(input.sandbox, metadata.credentialGeneration);
    return needsReauthAuth();
  }

  try {
    await ensureInfisicalInstalled(input.sandbox);
    const currentGeneration = await readGeneration(input.sandbox);
    const restored = currentGeneration !== connection.credentialGeneration;
    if (restored) {
      await restoreAuthBundle(
        input.sandbox,
        connection.authBundle,
        connection.credentialGeneration,
      );
    }

    const needsValidation =
      restored ||
      !connection.lastValidatedAt ||
      Date.now() - connection.lastValidatedAt.getTime() >= INFISICAL_VALIDATION_INTERVAL_MS;
    if (needsValidation) {
      const valid = await validateInfisicalLogin(input.sandbox);
      if (!valid) {
        await markNeedsReauth({
          workspaceId: input.workspaceId,
          credentialGeneration: connection.credentialGeneration,
          reason: "Infisical rejected the saved login. Reconnect Infisical in workspace settings.",
        });
        await clearInfisicalAuth(input.sandbox);
        await writeGeneration(input.sandbox, connection.credentialGeneration);
        return needsReauthAuth();
      }
      await markInfisicalConnectionValidated({
        db,
        workspaceId: input.workspaceId,
        expectedCredentialGeneration: connection.credentialGeneration,
      });
    }

    return {
      available: true,
      redactionValues: connection.authBundle.redactionValues,
      promptFragment: [
        "<infisical_cli>",
        "The Infisical CLI is authenticated for this workspace and may be used directly.",
        "Use the repository's .infisical.json or explicit flags to select a project and environment.",
        "Prefer `infisical run -- <command>` and never print, log, summarize, or expose secret values.",
        "</infisical_cli>",
      ].join("\n"),
    };
  } catch (error) {
    logger.warn("Infisical sandbox authentication could not be prepared", {
      event: "opencompany.runner_infisical_sandbox_prepare_failed",
      workspace_id: input.workspaceId,
      credential_generation: metadata.credentialGeneration,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return {
      available: false,
      redactionValues: connection.authBundle.redactionValues,
      promptFragment:
        "Infisical is connected, but its CLI authentication could not be prepared in this sandbox. Continue coding without it and tell the user if Infisical is required.",
    };
  }
}

export function combineSandboxPromptFragments(...fragments: Array<string | null | undefined>) {
  return fragments
    .map((fragment) => fragment?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}

async function ensureInfisicalInstalled(sandbox: SandboxHandle) {
  const check = await sandbox.commands.run("infisical --version 2>/dev/null || true", {
    user: "user",
    timeoutMs: 30_000,
  });
  if (check.stdout.trim() === `infisical version ${INFISICAL_CLI_VERSION}`) return;

  const archiveUrl = `https://github.com/Infisical/cli/releases/download/v${INFISICAL_CLI_VERSION}/cli_${INFISICAL_CLI_VERSION}_linux_amd64.tar.gz`;
  await sandbox.commands.run(
    [
      "infisical_install_dir=$(mktemp -d /tmp/opencompany-infisical.XXXXXX)",
      `curl -fsSL ${shellQuote(archiveUrl)} -o "$infisical_install_dir/infisical.tar.gz"`,
      `printf '%s  %s\\n' ${shellQuote(INFISICAL_CLI_LINUX_AMD64_SHA256)} "$infisical_install_dir/infisical.tar.gz" | sha256sum -c -`,
      'tar -xzf "$infisical_install_dir/infisical.tar.gz" -C "$infisical_install_dir" infisical',
      'install -m 0755 "$infisical_install_dir/infisical" /usr/local/bin/infisical',
      'rm -rf "$infisical_install_dir"',
      `test "$(infisical --version)" = ${shellQuote(`infisical version ${INFISICAL_CLI_VERSION}`)}`,
    ].join(" && "),
    { user: "root", timeoutMs: 180_000 },
  );
}

async function restoreAuthBundle(
  sandbox: SandboxHandle,
  bundle: InfisicalAuthBundle,
  credentialGeneration: string,
) {
  const files = decodeBundleFiles(bundle);
  await clearInfisicalAuth(sandbox);
  await sandbox.commands.run(
    [
      `install -d -m 700 -o user -g user ${shellQuote(INFISICAL_CONFIG_ROOT)}`,
      `install -d -m 700 -o user -g user ${shellQuote(INFISICAL_KEYRING_ROOT)}`,
      `install -d -m 700 -o user -g user ${shellQuote("/home/user/.opencompany")}`,
    ].join(" && "),
    { user: "root", timeoutMs: 30_000 },
  );
  await sandbox.files.write(
    files.map((file) => ({
      path: `/home/user/${file.path}`,
      data: file.contents.toString("utf8"),
    })),
    { user: "user" },
  );
  await sandbox.commands.run(
    files
      .map((file) => `chmod ${file.mode.toString(8)} ${shellQuote(`/home/user/${file.path}`)}`)
      .join(" && "),
    { user: "user", timeoutMs: 30_000 },
  );
  await writeGeneration(sandbox, credentialGeneration);
}

function decodeBundleFiles(bundle: InfisicalAuthBundle) {
  if (bundle.files.length < 2 || bundle.files.length > 6) {
    throw new Error("Infisical auth bundle contains an unexpected number of files.");
  }
  let totalBytes = 0;
  const files = bundle.files.map((file) => {
    if (!isAllowedBundlePath(file.path) || file.mode !== 0o600) {
      throw new Error("Infisical auth bundle contains an invalid file.");
    }
    const contents = Buffer.from(file.contentsBase64, "base64");
    totalBytes += contents.byteLength;
    return { path: file.path, contents, mode: file.mode };
  });
  if (
    !files.some((file) => file.path === ".infisical/infisical-config.json") ||
    !files.some((file) => file.path.startsWith("infisical-keyring/")) ||
    totalBytes > INFISICAL_BUNDLE_MAX_BYTES
  ) {
    throw new Error("Infisical auth bundle is incomplete or too large.");
  }
  return files;
}

function isAllowedBundlePath(path: string) {
  return (
    path === ".infisical/infisical-config.json" ||
    /^infisical-keyring\/[A-Za-z0-9@._%+\-=]+$/.test(path)
  );
}

async function validateInfisicalLogin(sandbox: SandboxHandle) {
  const result = await sandbox.commands.run("HOME=/home/user infisical login status --json", {
    user: "user",
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) return false;
  try {
    const value = JSON.parse(result.stdout) as { sessions?: Array<Record<string, unknown>> };
    return Boolean(
      value.sessions?.some(
        (session) =>
          session.principalType === "user" &&
          session.status === "authenticated" &&
          session.domain === "https://app.infisical.com",
      ),
    );
  } catch {
    return false;
  }
}

async function reconcileDisconnectedGeneration(
  sandbox: SandboxHandle,
  credentialGeneration: string,
) {
  if ((await readGeneration(sandbox)) === credentialGeneration) return;
  await clearInfisicalAuth(sandbox);
  await writeGeneration(sandbox, credentialGeneration);
}

async function clearInfisicalAuth(sandbox: SandboxHandle) {
  await sandbox.commands.run(
    `rm -rf ${shellQuote(INFISICAL_CONFIG_ROOT)} ${shellQuote(INFISICAL_KEYRING_ROOT)}`,
    { user: "user", timeoutMs: 30_000 },
  );
}

async function readGeneration(sandbox: SandboxHandle) {
  try {
    const value = await sandbox.files.read(INFISICAL_GENERATION_PATH);
    return (typeof value === "string" ? value : Buffer.from(value).toString("utf8")).trim();
  } catch {
    return null;
  }
}

async function writeGeneration(sandbox: SandboxHandle, credentialGeneration: string) {
  await sandbox.commands.run(`install -d -m 700 ${shellQuote("/home/user/.opencompany")}`, {
    user: "user",
    timeoutMs: 30_000,
  });
  await sandbox.files.write(INFISICAL_GENERATION_PATH, credentialGeneration, { user: "user" });
  await sandbox.commands.run(`chmod 600 ${shellQuote(INFISICAL_GENERATION_PATH)}`, {
    user: "user",
    timeoutMs: 30_000,
  });
}

async function markNeedsReauth(input: {
  workspaceId: string;
  credentialGeneration: string;
  reason: string;
}) {
  await markInfisicalConnectionNeedsReauth({
    db: getDb(),
    workspaceId: input.workspaceId,
    expectedCredentialGeneration: input.credentialGeneration,
    statusReason: input.reason,
  });
}

function unavailableAuth(): InfisicalSandboxAuth {
  return { available: false, promptFragment: "", redactionValues: [] };
}

function needsReauthAuth(): InfisicalSandboxAuth {
  return {
    available: false,
    redactionValues: [],
    promptFragment:
      "Infisical needs to be reconnected by a workspace admin. Continue coding without it and tell the user if Infisical access is required.",
  };
}
