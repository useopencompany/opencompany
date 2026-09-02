import { createSign } from "node:crypto";
import { hasGhApiRequestBody, readGhApiMethod } from "@opencompany/agent-runtime";

type InstallationToken = {
  token: string;
  expiresAt: number;
};

const cachedTokens = new Map<string, InstallationToken>();

// GitHub returns this when an installation token is valid but the App was never granted the
// permission for the attempted action (e.g. `gh issue create` / POST /repos/:o/:r/issues with no
// Issues:write). The raw stderr ("Resource not accessible by integration") is opaque, so we turn it
// into an actionable instruction the agent — or an operator reading logs — can act on directly.
const GITHUB_PERMISSION_ERROR_PATTERN = /resource not accessible by integration/i;

type GitHubPermissionOperation = {
  path?: string | undefined;
  method?: string | undefined;
  ghArgv?: string[] | undefined;
};

const GENERIC_REPOSITORY_PERMISSION = "one or more repository permissions";

export function gitHubPermissionErrorHint(
  detail: string,
  operation?: GitHubPermissionOperation,
): string | null {
  if (!GITHUB_PERMISSION_ERROR_PATTERN.test(detail)) return null;
  const permissions = githubOperationPermissions(operation);
  const permissionText =
    permissions.length > 0 ? permissions.join(" + ") : GENERIC_REPOSITORY_PERMISSION;
  return [
    "GitHub denied this action: the GitHub App installation lacks the required repository",
    `permission(s): ${permissionText}`,
    '(403 "Resource not accessible by integration").',
    `Grant the GitHub App ${permissionText} and have the org installation re-approve the expanded permissions, then retry.`,
  ].join(" ");
}

function githubOperationPermissions(operation: GitHubPermissionOperation | undefined) {
  if (operation?.ghArgv) {
    const ghPermissions = githubCliOperationPermissions(operation.ghArgv);
    if (ghPermissions.length > 0) return ghPermissions;
  }
  return githubEndpointPermissions(operation?.path, operation?.method);
}

function githubCliOperationPermissions(ghArgv: string[]) {
  const argv = dropGitHubCliGlobalFlags(ghArgv);
  const [command, subcommand] = argv;
  if (!command) return [];

  if (command === "run") {
    if (["download", "list", "view", "watch"].includes(subcommand ?? "")) return ["Actions: Read"];
    if (["cancel", "delete", "rerun"].includes(subcommand ?? "")) return ["Actions: Write"];
    return [];
  }
  if (command === "pr") {
    if (subcommand === "checks") return ["Checks: Read", "Statuses: Read"];
    if (subcommand === "merge") {
      // `gh pr merge` may use GraphQL and branch-protection operations beyond the
      // least-privilege REST merge endpoint, so keep the broader operational hint here.
      return ["Administration: Write", "Pull requests: Read & write", "Contents: Read & write"];
    }
    if (subcommand === "create" || subcommand === "comment") return ["Pull requests: Read & write"];
  }
  if (command === "issue" && subcommand === "create") return ["Issues: Read & write"];
  if (command === "api") {
    const apiOperation = parseGitHubCliApiOperation(argv.slice(1));
    return githubEndpointPermissions(apiOperation.path, apiOperation.method);
  }

  return [];
}

function dropGitHubCliGlobalFlags(argv: string[]) {
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (!arg?.startsWith("-")) break;
    index += githubCliFlagConsumesValue(arg) ? 2 : 1;
  }
  return argv.slice(index);
}

function parseGitHubCliApiOperation(argv: string[]) {
  const method = readGhApiMethod(argv) ?? (hasGhApiRequestBody(argv) ? "POST" : "GET");
  let path: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === "-X" || arg === "--method" || arg === "--request") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--method=") || arg.startsWith("--request=")) {
      continue;
    }
    if (githubCliApiFlagConsumesValue(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;

    path ??= arg;
  }

  return { path, method };
}

function githubCliFlagConsumesValue(arg: string) {
  return ["--repo", "-R", "--hostname", "--config"].includes(arg);
}

function githubCliApiFlagConsumesValue(arg: string) {
  return [
    "--field",
    "-F",
    "--raw-field",
    "-f",
    "--header",
    "-H",
    "--input",
    "--jq",
    "-q",
    "--template",
  ].includes(arg);
}

function githubEndpointPermissions(path: string | undefined, method: string | undefined) {
  const segments = githubRepositoryEndpointSegments(path);
  const normalizedMethod = (method ?? "GET").toUpperCase();
  if (segments.length === 0) return [];

  if (segments[0] === "actions") {
    if (normalizedMethod === "GET" && (segments[1] === "runs" || segments[1] === "workflows")) {
      return ["Actions: Read"];
    }
    if (
      normalizedMethod === "POST" &&
      ((segments[1] === "jobs" && segments[3] === "rerun") ||
        (segments[1] === "runs" &&
          ["cancel", "force-cancel", "rerun", "rerun-failed-jobs"].includes(segments[3] ?? "")))
    ) {
      return ["Actions: Write"];
    }
    return [];
  }
  if (segments[0] === "commits") {
    if (normalizedMethod === "GET" && (segments[2] === "status" || segments[2] === "statuses")) {
      return ["Statuses: Read"];
    }
    if (normalizedMethod === "GET" && segments[2] === "check-suites") return ["Checks: Read"];
    if (normalizedMethod === "GET" && segments[2] === "check-runs") return ["Checks: Read"];
  }
  if (segments[0] === "statuses") {
    if (normalizedMethod === "GET") return ["Statuses: Read"];
    if (normalizedMethod === "POST") return ["Statuses: Read & write"];
  }
  if (segments[0] === "check-runs") {
    if (normalizedMethod === "GET") return ["Checks: Read"];
    if (["PATCH", "POST"].includes(normalizedMethod)) return ["Checks: Write"];
  }
  if (segments[0] === "check-suites") {
    if (normalizedMethod === "GET") return ["Checks: Read"];
    if (normalizedMethod === "POST" && segments[2] === "rerequest") return ["Checks: Write"];
  }
  if (segments[0] === "issues") {
    if (normalizedMethod === "GET") return ["Issues: Read"];
    if (["PATCH", "POST", "PUT"].includes(normalizedMethod)) return ["Issues: Read & write"];
  }
  if (segments[0] === "pulls") {
    if (segments[2] === "merge" && normalizedMethod === "PUT") {
      return ["Contents: Read & write"];
    }
    if (segments[2] === "comments" && normalizedMethod === "POST") {
      return ["Pull requests: Read & write"];
    }
    if (normalizedMethod === "GET") return ["Pull requests: Read"];
    if (["PATCH", "POST", "PUT"].includes(normalizedMethod)) {
      return ["Pull requests: Read & write"];
    }
  }
  if (segments[0] === "branches" && segments.includes("protection")) {
    if (normalizedMethod === "GET") return ["Administration: Read"];
    if (["DELETE", "PATCH", "POST", "PUT"].includes(normalizedMethod)) {
      return ["Administration: Write"];
    }
  }

  return [];
}

function githubRepositoryEndpointSegments(path: string | undefined) {
  const normalizedPath = normalizeGitHubApiPath(path);
  if (!normalizedPath) return [];
  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments[0] === "repos" && segments.length >= 4) return segments.slice(3);
  return segments;
}

function normalizeGitHubApiPath(path: string | undefined) {
  if (!path) return "";
  try {
    return new URL(path, "https://api.github.com").pathname;
  } catch {
    return path.split(/[?#]/, 1)[0] ?? "";
  }
}

export async function getGitHubWorkInstallationToken(input: {
  installationId: string;
  repositoryFullName?: string;
  repositoryFullNames?: string[];
}) {
  if (!hasGitHubIntegrationAppEnv()) return null;

  const repositoryFullNames = normalizeRepositoryFullNames(
    input.repositoryFullNames ?? (input.repositoryFullName ? [input.repositoryFullName] : []),
  );

  return getInstallationToken({
    installationId: input.installationId,
    appId: requiredEnv("GITHUB_INTEGRATION_APP_ID"),
    privateKey: requiredEnv("GITHUB_INTEGRATION_APP_PRIVATE_KEY"),
    cachePrefix: "integration",
    purpose: "work repository integration",
    envNames: ["GITHUB_INTEGRATION_APP_ID", "GITHUB_INTEGRATION_APP_PRIVATE_KEY"],
    repositoryFullNames,
  });
}

export async function listGitHubUserRepositoryNames(input: {
  accessToken: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  const pageCap = 10;
  const names = new Set<string>();

  for (let page = 1; page <= pageCap; page += 1) {
    const url = new URL("https://api.github.com/user/repos");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "full_name");
    url.searchParams.set("direction", "asc");
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: input.signal ?? null,
    });
    if (!response.ok) {
      throw new Error(`GitHub personal repository listing failed with ${response.status}.`);
    }

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      throw new Error("GitHub personal repository listing returned an invalid response.");
    }
    for (const row of payload) {
      if (!row || typeof row !== "object") continue;
      const fullName = "full_name" in row ? row.full_name : null;
      if (typeof fullName === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
        names.add(fullName);
      }
    }
    if (payload.length < 100) break;
  }

  return [...names].sort((left, right) => left.localeCompare(right));
}

function normalizeRepositoryFullNames(names: string[]) {
  return [...new Set(names)].sort();
}

async function getInstallationToken(input: {
  installationId: string;
  repositoryFullNames?: string[];
  appId: string;
  privateKey: string;
  cachePrefix: string;
  purpose: string;
  envNames: [string, string];
}) {
  const repositoryFullNames = input.repositoryFullNames ?? [];
  const cacheScope = repositoryFullNames.length > 0 ? repositoryFullNames.join(",") : "*";
  const cacheKey = `${input.cachePrefix}:${input.installationId}:${cacheScope}`;
  const cachedToken = cachedTokens.get(cacheKey);
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) {
    return cachedToken.token;
  }

  const response = await fetch(
    `https://api.github.com/app/installations/${input.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${createAppJwt({
          appId: input.appId,
          privateKey: input.privateKey,
        })}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(repositoryFullNames.length > 0
        ? {
            body: JSON.stringify({
              repositories: repositoryFullNames.map(githubRepositoryName),
            }),
          }
        : {}),
    },
  );

  if (!response.ok) {
    const details = await response.text();
    if (response.status === 404) {
      throw new Error(
        [
          `GitHub ${input.purpose} installation ${input.installationId} is not accessible to the configured GitHub App.`,
          `Reconnect the GitHub integration or verify the runner and web app use the same ${input.envNames.join(
            "/",
          )} credentials.`,
          `GitHub response: ${details}`,
        ].join(" "),
      );
    }

    throw new Error(`GitHub installation token request failed with ${response.status}: ${details}`);
  }

  const result = (await response.json()) as { token?: string; expires_at?: string };
  if (!result.token) {
    throw new Error("GitHub did not return an installation token.");
  }

  cachedTokens.set(cacheKey, {
    token: result.token,
    expiresAt: result.expires_at
      ? new Date(result.expires_at).getTime()
      : Date.now() + 55 * 60 * 1000,
  });

  return result.token;
}

/**
 * Live check whether the work-repository installation can currently reach a repo, returning its
 * metadata or null when GitHub does not grant it (404).
 *
 * The synced `workspaceIntegrationResources` list is only a point-in-time snapshot (refreshed at
 * connect-time or via the "Refresh repositories" button), so a repo granted to the installation
 * *after* the last sync is absent there even though the agent is allowed to use it. Callers resolve
 * such a freshly-granted repo on demand with this instead of failing on a stale snapshot.
 */
export async function fetchGitHubWorkRepository(input: {
  installationId: string;
  fullName: string;
}): Promise<{
  id: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
} | null> {
  if (!hasGitHubIntegrationAppEnv()) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.fullName)) return null;

  // Unscoped installation token (no `repositories` filter): lets us probe any repo the installation
  // can see. GitHub answers 200 when the repo is granted, 404 when it is not.
  const token = await getGitHubWorkInstallationToken({ installationId: input.installationId });
  if (!token) return null;

  const response = await fetch(`https://api.github.com/repos/${input.fullName}`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  // 404 = the installation cannot see this repo (never granted, or access revoked). Treat as
  // "unknown" so the caller falls back to its existing not-available handling rather than throwing.
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `GitHub repository lookup for ${input.fullName} failed with ${response.status}: ${await response.text()}`,
    );
  }

  const repo = (await response.json()) as {
    id?: number | string;
    full_name?: string;
    default_branch?: string;
    private?: boolean;
  };
  if (!repo.full_name) return null;

  return {
    id: String(repo.id ?? ""),
    fullName: repo.full_name,
    defaultBranch: repo.default_branch?.trim() || "main",
    private: repo.private ?? true,
  };
}

async function githubRequest<T>(input: {
  token: string;
  path: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
}): Promise<T> {
  const response = await fetch(`https://api.github.com${input.path}`, {
    method: input.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
  });

  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 403) {
      const hint = gitHubPermissionErrorHint(detail, { path: input.path, method: input.method });
      if (hint) throw new Error(hint);
    }
    throw new Error(`GitHub request failed with ${response.status}: ${detail}`);
  }

  return (await response.json()) as T;
}

function hasGitHubIntegrationAppEnv() {
  return Boolean(
    process.env.GITHUB_INTEGRATION_APP_ID && process.env.GITHUB_INTEGRATION_APP_PRIVATE_KEY,
  );
}

function githubRepositoryName(repositoryFullName: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) {
    throw new Error("Invalid GitHub repository name for installation token scope.");
  }
  return repositoryFullName.split("/")[1];
}

function createAppJwt(credentials: { appId: string; privateKey: string }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: credentials.appId,
    }),
  );
  const input = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(input)
    .sign(normalizePrivateKey(credentials.privateKey));

  return `${input}.${base64Url(signature)}`;
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for GitHub Brain sync.`);
  }
  return value;
}

function normalizePrivateKey(value: string) {
  return value.replace(/\\\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\\n/g, "\n");
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
