import { hasGhApiRequestBody, readGhApiMethod } from "@opencompany/agent-runtime";
import { createLogger } from "@opencompany/observability";

const logger = createLogger({ service: "opencompany-runner", runtime: "github" });

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
    if (page === pageCap) {
      logger.warn("GitHub personal repository listing reached its pagination cap", {
        event: "opencompany.github_user_repository_listing_truncated",
        page_cap: pageCap,
        repository_count: names.size,
      });
    }
  }

  return [...names].sort((left, right) => left.localeCompare(right));
}
