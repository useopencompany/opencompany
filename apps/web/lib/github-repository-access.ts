import { CODEX_COMMAND_TOOL_NAME, USE_ACTION_TOOL_NAME } from "@/lib/chat-ui";

export type GitHubRepositoryAccess = {
  checkedAt: string;
  installations: GitHubInstallationAccess[];
  target: GitHubRepositoryAccessTarget | null;
};

export type GitHubInstallationAccess = {
  id: string;
  account: {
    id: string;
    login: string;
    type: "Organization" | "User";
    avatarUrl: string | null;
    htmlUrl: string | null;
  };
  repositorySelection: "all" | "selected";
  permissions: Record<string, string>;
  pendingPermissions: string[];
  suspendedAt: string | null;
  repositories: Array<{
    id: string;
    name: string;
    fullName: string;
    private: boolean;
    htmlUrl: string;
  }>;
};

export type GitHubRepositoryAccessTarget = {
  owner: string;
  repo: string | null;
  state: "available" | "missing_installation" | "missing_repository" | "suspended";
};

type GitHubToolView = {
  name: string;
  status: string;
  input: unknown;
  output: unknown;
  errorText?: string | null;
};

export async function fetchGitHubRepositoryAccess(input: {
  owner?: string;
  repo?: string;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}) {
  const search = new URLSearchParams();
  if (input.owner) search.set("owner", input.owner);
  if (input.repo) search.set("repo", input.repo);
  const query = search.size > 0 ? `?${search.toString()}` : "";
  const response = await fetch(`/api/integrations/github-user/installations${query}`, {
    method: input.forceRefresh ? "POST" : "GET",
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const value = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      isRecord(value) && isRecord(value.error) && typeof value.error.message === "string"
        ? value.error.message
        : "GitHub repository access could not be checked.";
    throw new Error(message);
  }
  return parseGitHubRepositoryAccess(value);
}

export function githubInstallGapCandidate(tool: GitHubToolView) {
  if (tool.name === USE_ACTION_TOOL_NAME) {
    if (!isRecord(tool.input) || typeof tool.input.action !== "string") return null;
    if (!tool.input.action.startsWith("plugin:github:github.")) return null;
    if (!isRecord(tool.input.params)) return null;
    const output = isRecord(tool.output) ? tool.output : null;
    const failed =
      output?.ok === false || tool.status === "failed" || Boolean(tool.errorText?.trim());
    const emptyResult =
      output?.ok === true && Array.isArray(output.result) && output.result.length === 0;
    if (!failed && !emptyResult) return null;
    return repositoryTarget(tool.input.params.owner, tool.input.params.repo);
  }

  if (tool.name !== CODEX_COMMAND_TOOL_NAME) return null;
  const input = isRecord(tool.input) ? tool.input : null;
  const output = isRecord(tool.output) ? tool.output : null;
  if (tool.status !== "failed" && output?.status !== "failed") return null;
  const command = typeof input?.command === "string" ? input.command : "";
  const failure = [
    typeof output?.outputPreview === "string" ? output.outputPreview : "",
    tool.errorText ?? "",
  ].join("\n");
  if (!isGitHubAccessFailure(failure)) return null;
  return repositoryFromCommand(`${command}\n${failure}`);
}

export function githubInstallStartHref(owner?: string, returnTo = "/") {
  const search = new URLSearchParams({ returnTo });
  if (owner) search.set("owner", owner);
  return `/api/integrations/github-user/start?${search.toString()}`;
}

function parseGitHubRepositoryAccess(value: unknown): GitHubRepositoryAccess {
  if (
    !isRecord(value) ||
    typeof value.checkedAt !== "string" ||
    !Array.isArray(value.installations)
  ) {
    throw new Error("GitHub returned an invalid repository access response.");
  }
  const installations = value.installations.map(parseInstallation);
  const target = value.target === null ? null : parseTarget(value.target);
  return { checkedAt: value.checkedAt, installations, target };
}

function parseInstallation(value: unknown): GitHubInstallationAccess {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isRecord(value.account) ||
    typeof value.account.id !== "string" ||
    typeof value.account.login !== "string" ||
    (value.account.type !== "Organization" && value.account.type !== "User") ||
    (value.repositorySelection !== "all" && value.repositorySelection !== "selected") ||
    !isRecord(value.permissions) ||
    !Array.isArray(value.pendingPermissions) ||
    !value.pendingPermissions.every((permission) => typeof permission === "string") ||
    (value.suspendedAt !== null && typeof value.suspendedAt !== "string") ||
    !Array.isArray(value.repositories)
  ) {
    throw new Error("GitHub returned an invalid installation access response.");
  }
  const permissions = Object.fromEntries(
    Object.entries(value.permissions).flatMap(([key, entry]) =>
      typeof entry === "string" ? [[key, entry]] : [],
    ),
  );
  return {
    id: value.id,
    account: {
      id: value.account.id,
      login: value.account.login,
      type: value.account.type,
      avatarUrl: typeof value.account.avatarUrl === "string" ? value.account.avatarUrl : null,
      htmlUrl: typeof value.account.htmlUrl === "string" ? value.account.htmlUrl : null,
    },
    repositorySelection: value.repositorySelection,
    permissions,
    pendingPermissions: value.pendingPermissions,
    suspendedAt: value.suspendedAt,
    repositories: value.repositories.map(parseRepository),
  };
}

function parseRepository(value: unknown): GitHubInstallationAccess["repositories"][number] {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.fullName !== "string" ||
    typeof value.private !== "boolean" ||
    typeof value.htmlUrl !== "string"
  ) {
    throw new Error("GitHub returned an invalid repository access response.");
  }
  return {
    id: value.id,
    name: value.name,
    fullName: value.fullName,
    private: value.private,
    htmlUrl: value.htmlUrl,
  };
}

function parseTarget(value: unknown): GitHubRepositoryAccessTarget {
  if (
    !isRecord(value) ||
    typeof value.owner !== "string" ||
    (value.repo !== null && typeof value.repo !== "string") ||
    !["available", "missing_installation", "missing_repository", "suspended"].includes(
      String(value.state),
    )
  ) {
    throw new Error("GitHub returned an invalid repository access target.");
  }
  return value as GitHubRepositoryAccessTarget;
}

function repositoryTarget(owner: unknown, repo: unknown) {
  return typeof owner === "string" && typeof repo === "string" && owner.trim() && repo.trim()
    ? { owner: owner.trim(), repo: repo.trim().replace(/\.git$/iu, "") }
    : null;
}

function isGitHubAccessFailure(value: string) {
  return /repository not found|could not read from remote repository|resource not accessible by integration|(?:github|api\.github\.com)[^\n]*\b403\b|\b403\b[^\n]*(?:github|api\.github\.com)/iu.test(
    value,
  );
}

function repositoryFromCommand(value: string) {
  const match =
    value.match(/(?:--repo(?:=|\s+)|GH_REPO=)["']?([a-z0-9-]{1,39})\/([^\s"']+)/iu) ??
    value.match(/github\.com[/:]([a-z0-9-]{1,39})\/([^\s"'/:]+)/iu);
  return match ? repositoryTarget(match[1], match[2]) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
