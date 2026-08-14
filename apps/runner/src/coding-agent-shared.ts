// Shared helpers for opencompany's Codex and Claude Code harnesses.

export const GITHUB_AUTH_HEADER_ENV = "GITHUB_AUTH_HEADER";

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

export function buildGitHubCommandEnv(input: {
  githubAuthHeader: string;
  githubToken: string;
  toolCallId: string;
  repositoryFullName?: string;
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
  };
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
