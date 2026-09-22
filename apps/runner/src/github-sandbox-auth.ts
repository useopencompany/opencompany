import { createHash, randomBytes } from "node:crypto";
import { shellQuote } from "@opencompany/agent-runtime";
import { createLogger } from "@opencompany/observability";
import { type GitHubCommandAuth, gitAuthHeader } from "./coding-agent-shared";
import { createGitHubBrokerTicket } from "./github-broker";
import { githubSandboxRelayScript } from "./github-sandbox-relay";
import type { SandboxHandle } from "./sandbox";

const logger = createLogger({ service: "opencompany-runner", runtime: "github-sandbox-auth" });
export type GitHubSandboxAuth = { env: Record<string, string>; dispose: () => Promise<void> };
export type GitHubSandboxCapability = {
  ticket: string;
  localToken: string;
  root: string;
  lifetimeSeconds: number;
  redactionValues: string[];
};

export function createGitHubSandboxCapability(input: {
  sessionId: string;
  turnId: string;
  attemptId: string;
  leaseId: string;
  secret: string;
  timeoutMs: number;
}): GitHubSandboxCapability {
  const ttlMs = input.timeoutMs * 2 + 10 * 60_000;
  const ticket = createGitHubBrokerTicket({
    codexChatSessionId: input.sessionId,
    codexChatTurnId: input.turnId,
    attemptId: input.attemptId,
    leaseId: input.leaseId,
    secret: input.secret,
    ttlMs,
  }).ticket;
  // Preserve gh's GitHub App token classification without exposing a provider token.
  const localToken = `ghu_${randomBytes(32).toString("hex")}`;
  return {
    ticket,
    localToken,
    redactionValues: [ticket, localToken, gitAuthHeader(localToken)],
    root: `/tmp/oc-gh-${createHash("sha256").update(input.attemptId).update(randomBytes(16)).digest("hex").slice(0, 24)}`,
    lifetimeSeconds: Math.ceil(ttlMs / 1000),
  };
}

export function buildGitHubRelayEnv(input: {
  root: string;
  port: number;
  localToken: string;
  identity: Pick<GitHubCommandAuth, "gitAuthorName" | "gitAuthorEmail">;
}): Record<string, string> {
  const origin = `http://127.0.0.1:${input.port}`;
  const entries = [
    ["http.https://github.com/.extraheader", ""],
    [`http.${origin}/.extraheader`, gitAuthHeader(input.localToken)],
    [`http.${origin}/.proxy`, ""],
  ];
  return {
    GH_TOKEN: input.localToken,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_CONFIG_DIR: input.root,
    GIT_EXEC_PATH: `${input.root}/git-core`,
    GIT_CONFIG_COUNT: String(entries.length),
    ...Object.fromEntries(
      entries.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key!],
        [`GIT_CONFIG_VALUE_${index}`, value!],
      ]),
    ),
    ...(input.identity.gitAuthorName
      ? {
          GIT_AUTHOR_NAME: input.identity.gitAuthorName,
          GIT_COMMITTER_NAME: input.identity.gitAuthorName,
        }
      : {}),
    ...(input.identity.gitAuthorEmail
      ? {
          GIT_AUTHOR_EMAIL: input.identity.gitAuthorEmail,
          GIT_COMMITTER_EMAIL: input.identity.gitAuthorEmail,
        }
      : {}),
  };
}

export async function prepareGitHubSandboxAuth(input: {
  sandbox: SandboxHandle;
  brokerUrl: string;
  capability: GitHubSandboxCapability;
  identity: Pick<GitHubCommandAuth, "gitAuthorName" | "gitAuthorEmail">;
}): Promise<GitHubSandboxAuth> {
  const url = new URL(input.brokerUrl);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))
  ) {
    throw new Error("GitHub broker requires HTTPS outside local development.");
  }
  const { root, localToken, ticket, lifetimeSeconds } = input.capability;
  let rootCreated = false;
  let relayPid: number | null = null;
  let relayStderr = "";
  const dispose = async () => {
    const cleanupErrors: unknown[] = [];
    if (relayPid !== null) {
      try {
        await input.sandbox.commands.kill(relayPid);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (rootCreated) {
      try {
        await input.sandbox.commands.run(`rm -rf -- ${shellQuote(root)}`, { timeoutMs: 15_000 });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const error of cleanupErrors) {
      logger.warn("GitHub sandbox relay cleanup failed", {
        event: "opencompany.github_sandbox_relay_cleanup_failed",
        error_name: error instanceof Error ? error.name : typeof error,
      });
    }
  };
  try {
    // mktemp-like random path with exclusive creation: never follow sandbox-provided links.
    await input.sandbox.commands.run(`umask 077 && mkdir ${shellQuote(root)}`, {
      timeoutMs: 30_000,
    });
    rootCreated = true;
    await input.sandbox.files.write([
      { path: `${root}/relay.py`, data: githubSandboxRelayScript },
      {
        path: `${root}/config.json`,
        data: JSON.stringify({ brokerUrl: url.origin, ticket, localToken, lifetimeSeconds }),
      },
      {
        path: `${root}/config.yml`,
        data: `http_unix_socket: ${root}/http.sock\ngit_protocol: https\n`,
      },
    ]);
    const command = await input.sandbox.commands.run(
      `exec python3 ${shellQuote(`${root}/relay.py`)} ${shellQuote(`${root}/config.json`)}`,
      {
        background: true,
        timeoutMs: lifetimeSeconds * 1000,
        onStderr: (data) => {
          relayStderr = `${relayStderr}${data}`.slice(-2_000);
        },
      },
    );
    relayPid = command.pid;
    const ready = await input.sandbox.commands.run(
      `python3 -c ${shellQuote(`import os,time\np=${JSON.stringify(`${root}/ready.json`)}\nfor _ in range(100):\n if os.path.exists(p):\n  print(open(p).read());break\n time.sleep(0.1)\nelse: raise RuntimeError("GitHub relay failed to start")`)}`,
      { timeoutMs: 15_000 },
    );
    const { port } = JSON.parse(ready.stdout) as { port: number };
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid GitHub relay port.");
    return {
      env: buildGitHubRelayEnv({ root, localToken, port, identity: input.identity }),
      dispose,
    };
  } catch (error) {
    await dispose();
    const startupDiagnostic = relayStderr.trim();
    if (startupDiagnostic) {
      throw new Error(`GitHub relay failed to start: ${startupDiagnostic}`, { cause: error });
    }
    throw error;
  }
}
