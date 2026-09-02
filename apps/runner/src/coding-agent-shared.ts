// Shared helpers for opencompany's Codex and Claude Code harnesses.

import {
  GitHubUserAccessAuthError,
  getGitHubUserAccessToken,
  loadGitHubUserIntegration,
} from "@opencompany/agent/integrations/github-user";
import { integrations } from "@opencompany/db/product-schema";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "./db";
import { getGitHubWorkInstallationToken } from "./github";

export const GITHUB_AUTH_HEADER_ENV = "GITHUB_AUTH_HEADER";
export const GITHUB_RECONNECT_NOTICE =
  "GitHub needs reconnecting. This turn continued without GitHub access. Reconnect GitHub in Settings.";
export const GITHUB_UNAVAILABLE_NOTICE =
  "GitHub access is temporarily unavailable. This turn continued without GitHub access.";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

export function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}

export function safePathSegment(value: string, fallback = "coder") {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-") || fallback;
}

export function gitAuthHeader(token: string) {
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString(
    "base64",
  )}`;
}

export type GitHubCommandAuth = {
  githubAuthHeader: string;
  githubToken: string;
  provider: "github_user" | "github";
  gitAuthorName?: string;
  gitAuthorEmail?: string;
};

// A connected personal account is the identity the user explicitly chose for the GitHub plugin,
// so it takes precedence over the legacy workspace installation. Refresh immediately before the
// token enters a sandbox; getGitHubUserAccessToken owns both in-process single-flight and the
// database refresh lease used by concurrent runner/gateway consumers.
export async function loadGitHubUserAuthForUser(
  userWorkosId: string,
): Promise<GitHubCommandAuth | null> {
  const db = getDb();
  const integration = await loadGitHubUserIntegration({ userWorkosId, db });
  if (!integration || integration.status !== "connected") return null;

  return loadConnectedGitHubUserAuth(userWorkosId, integration, db);
}

async function loadConnectedGitHubUserAuth(
  userWorkosId: string,
  integration: NonNullable<Awaited<ReturnType<typeof loadGitHubUserIntegration>>>,
  db: ReturnType<typeof getDb>,
): Promise<GitHubCommandAuth> {
  const githubToken = await getGitHubUserAccessToken(
    {
      userWorkosId,
      integrationId: integration.id,
    },
    { db },
  );
  return {
    githubToken,
    githubAuthHeader: gitAuthHeader(githubToken),
    provider: "github_user",
    gitAuthorName: gitIdentityName(integration.accountName, integration.connectionLabel),
    gitAuthorEmail: gitIdentityEmail(integration.accountEmail, integration.connectionLabel),
  };
}

// Missing GitHub auth is not an error: a sandbox can still work with public repositories. A
// connected personal credential is different — refresh failures propagate rather than silently
// switching the sandbox to the workspace App identity.
export async function loadGitHubAuthForUser(
  userWorkosId: string,
): Promise<GitHubCommandAuth | null> {
  const db = getDb();
  const personalIntegration = await loadGitHubUserIntegration({ userWorkosId, db });
  if (personalIntegration) {
    if (personalIntegration.status !== "connected") {
      throw new GitHubUserAccessAuthError("Reconnect GitHub in Settings.");
    }
    return loadConnectedGitHubUserAuth(userWorkosId, personalIntegration, db);
  }

  const [integration] = await db
    .select({ installationId: integrations.externalId })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, userWorkosId),
        eq(integrations.provider, "github"),
        eq(integrations.status, "connected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);
  if (!integration?.installationId) return null;

  const githubToken = await getGitHubWorkInstallationToken({
    installationId: integration.installationId,
  }).catch(() => null);
  if (!githubToken) return null;
  return {
    githubToken,
    githubAuthHeader: gitAuthHeader(githubToken),
    provider: "github",
  };
}

export function buildGitHubCommandEnv(input: {
  githubAuthHeader: string;
  githubToken: string;
  toolCallId: string;
  repositoryFullName?: string;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
}) {
  return {
    GH_TOKEN: input.githubToken,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    ...(input.repositoryFullName ? { GH_REPO: input.repositoryFullName } : {}),
    GH_CONFIG_DIR: `/tmp/opencompany-gh-${safePathSegment(input.toolCallId)}`,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: input.githubAuthHeader,
    ...(input.gitAuthorName
      ? {
          GIT_AUTHOR_NAME: input.gitAuthorName,
          GIT_COMMITTER_NAME: input.gitAuthorName,
        }
      : {}),
    ...(input.gitAuthorEmail
      ? {
          GIT_AUTHOR_EMAIL: input.gitAuthorEmail,
          GIT_COMMITTER_EMAIL: input.gitAuthorEmail,
        }
      : {}),
  };
}

function gitIdentityName(accountName: string | null, connectionLabel: string | null) {
  return sanitizeGitIdentity(accountName) || githubLogin(connectionLabel) || "GitHub user";
}

function gitIdentityEmail(accountEmail: string | null, connectionLabel: string | null) {
  const email = sanitizeGitIdentity(accountEmail);
  if (email && /^[^<>@\s]+@[^<>@\s]+$/u.test(email)) return email;
  return `${githubLogin(connectionLabel) || "github-user"}@users.noreply.github.com`;
}

function githubLogin(connectionLabel: string | null) {
  const login = connectionLabel?.replace(/^@/u, "").trim() ?? "";
  return /^[A-Za-z0-9-]+$/u.test(login) ? login : "";
}

function sanitizeGitIdentity(value: string | null) {
  return (value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

export function createKnownSecretRedactor(secrets: Array<string | null | undefined>) {
  const patterns = [...new Set(secrets.filter((secret): secret is string => Boolean(secret)))]
    .filter((secret) => secret.length >= 6)
    .sort((a, b) => b.length - a.length);

  return (value: string) => {
    let output = value;
    for (const secret of patterns) {
      output = output.split(secret).join("[redacted]");
    }
    return output;
  };
}
