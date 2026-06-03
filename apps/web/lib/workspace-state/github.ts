import { createSign } from "node:crypto";
import type { getDb } from "@opencompany/db/client";
import { type Workspace, workspaceRepositories } from "@opencompany/db/schema";
import { createLogger } from "@opencompany/observability";
import { eq } from "drizzle-orm";

type Db = ReturnType<typeof getDb>;

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

type WorkspaceRepositoryRecord = typeof workspaceRepositories.$inferSelect;

type GitHubRepo = {
  id: number | string;
  name?: string;
  full_name: string;
  default_branch?: string;
  private?: boolean;
};

type GitHubTree = {
  sha?: string;
  truncated?: boolean;
  tree?: Array<{
    path?: string;
    type?: string;
    sha?: string;
  }>;
};

type GitHubRef = {
  object?: {
    sha?: string;
  };
};

type GitHubCommit = {
  sha?: string;
  tree?: {
    sha?: string;
  };
};

/** A single entry in a Git Data API tree write: either upsert (inline content) or delete (sha: null). */
export type GitTreeWriteEntry =
  | { path: string; mode: "100644"; type: "blob"; content: string }
  | { path: string; mode: "100644"; type: "blob"; sha: null };

type GitHubInstallation = {
  id: number | string;
  account?: {
    login?: string;
    type?: string;
  };
};

type GitHubInstallationRepositories = {
  repositories?: GitHubRepo[];
};

export async function ensureWorkspaceRepository(input: {
  db: Db;
  workspace: Workspace;
}): Promise<WorkspaceRepositoryRecord> {
  const [existing] = await input.db
    .select()
    .from(workspaceRepositories)
    .where(eq(workspaceRepositories.workspaceId, input.workspace.id))
    .limit(1);

  if (existing) return existing;

  const repo = await ensureManagedGitHubRepo(input.workspace);
  const [record] = await input.db
    .insert(workspaceRepositories)
    .values({
      workspaceId: input.workspace.id,
      githubRepoId: String(repo.id),
      fullName: repo.full_name,
      defaultBranch: repo.default_branch ?? "main",
      updatedAt: new Date(),
    })
    .returning();

  if (!record) {
    throw new Error(`Failed to create workspace repository for ${input.workspace.id}`);
  }

  return record;
}

// ---------------------------------------------------------------------------
// Git Data API — used by the per-workspace reconcile to materialize the entire
// desired tree in a single atomic commit (blobs are created inline via the tree
// API; the branch ref is the single optimistic-lock point).
// ---------------------------------------------------------------------------

/** Resolve the branch HEAD commit SHA and its tree SHA. */
export async function getBranchHead(input: {
  repository: WorkspaceRepositoryRecord;
}): Promise<{ commitSha: string; treeSha: string }> {
  const token = await getInstallationToken();
  const ref = await githubRequest<GitHubRef>({
    token,
    path: `/repos/${input.repository.fullName}/git/ref/heads/${encodeURIComponent(
      input.repository.defaultBranch,
    )}`,
    method: "GET",
  });
  const commitSha = ref.object?.sha;
  if (!commitSha) {
    throw new Error(
      `Unable to resolve HEAD for ${input.repository.fullName}@${input.repository.defaultBranch}`,
    );
  }
  const commit = await githubRequest<GitHubCommit>({
    token,
    path: `/repos/${input.repository.fullName}/git/commits/${commitSha}`,
    method: "GET",
  });
  const treeSha = commit.tree?.sha;
  if (!treeSha) {
    throw new Error(`Unable to resolve base tree for commit ${commitSha}`);
  }
  return { commitSha, treeSha };
}

/** List all blob entries of a tree (recursive) as path → blob SHA. */
export async function listTreeBlobs(input: {
  repository: WorkspaceRepositoryRecord;
  treeSha: string;
}): Promise<{ entries: Map<string, string>; truncated: boolean }> {
  const token = await getInstallationToken();
  const tree = await githubRequest<GitHubTree>({
    token,
    path: `/repos/${input.repository.fullName}/git/trees/${input.treeSha}?recursive=1`,
    method: "GET",
  });
  const entries = new Map<string, string>();
  for (const item of tree.tree ?? []) {
    if (item.type === "blob" && typeof item.path === "string" && typeof item.sha === "string") {
      entries.set(item.path, item.sha);
    }
  }
  return { entries, truncated: tree.truncated === true };
}

/** Create a new tree from a base tree plus a set of upsert/delete entries. */
export async function createTree(input: {
  repository: WorkspaceRepositoryRecord;
  baseTreeSha: string;
  entries: GitTreeWriteEntry[];
}): Promise<string> {
  const token = await getInstallationToken();
  const result = await githubRequest<{ sha?: string }>({
    token,
    path: `/repos/${input.repository.fullName}/git/trees`,
    method: "POST",
    body: { base_tree: input.baseTreeSha, tree: input.entries },
  });
  if (!result.sha) {
    throw new Error("GitHub did not return a tree SHA.");
  }
  return result.sha;
}

/** Create a commit pointing at a tree with a single parent. */
export async function createCommit(input: {
  repository: WorkspaceRepositoryRecord;
  message: string;
  treeSha: string;
  parentSha: string;
}): Promise<string> {
  const token = await getInstallationToken();
  const result = await githubRequest<{ sha?: string }>({
    token,
    path: `/repos/${input.repository.fullName}/git/commits`,
    method: "POST",
    body: { message: input.message, tree: input.treeSha, parents: [input.parentSha] },
  });
  if (!result.sha) {
    throw new Error("GitHub did not return a commit SHA.");
  }
  return result.sha;
}

/**
 * Fast-forward the branch ref to a commit. Throws a GitHubApiError with status
 * 422 on a non-fast-forward (the ref moved since we read HEAD) — callers should
 * re-read HEAD and retry. See `isGitHubRefUpdateConflict`.
 */
export async function updateBranchRef(input: {
  repository: WorkspaceRepositoryRecord;
  commitSha: string;
}): Promise<void> {
  const token = await getInstallationToken();
  await githubRequest({
    token,
    path: `/repos/${input.repository.fullName}/git/refs/heads/${encodeURIComponent(
      input.repository.defaultBranch,
    )}`,
    method: "PATCH",
    body: { sha: input.commitSha, force: false },
  });
}

/** True for a 422 returned by `updateBranchRef` when the ref is no longer a fast-forward. */
export function isGitHubRefUpdateConflict(error: unknown) {
  return error instanceof GitHubApiError && error.status === 422;
}

export async function getConfiguredGitHubInstallation() {
  const token = await createAppJwt();
  const installationId = requiredEnv("GITHUB_APP_INSTALLATION_ID");
  return githubRequest<GitHubInstallation>({
    token,
    path: `/app/installations/${installationId}`,
    method: "GET",
  });
}

export async function listConfiguredInstallationRepositories() {
  const token = await getInstallationToken();
  const result = await githubRequest<GitHubInstallationRepositories>({
    token,
    path: "/installation/repositories?per_page=100",
    method: "GET",
  });

  return (result.repositories ?? []).map((repo) => ({
    githubRepoId: String(repo.id),
    fullName: repo.full_name,
    defaultBranch: repo.default_branch ?? "main",
    private: repo.private ?? true,
  }));
}

async function ensureManagedGitHubRepo(workspace: Workspace): Promise<GitHubRepo> {
  const org = requiredEnv("OPENCOMPANY_GITHUB_ORG");
  const token = await getInstallationToken();
  const name = managedRepoName(workspace);

  try {
    return await githubRequest<GitHubRepo>({
      token,
      path: `/orgs/${org}/repos`,
      method: "POST",
      body: {
        name,
        private: true,
        auto_init: true,
        description: `OpenCompany workspace state for ${workspace.name}`,
      },
    });
  } catch (error) {
    if (!isGitHubConflict(error)) throw error;
    return githubRequest<GitHubRepo>({
      token,
      path: `/repos/${org}/${name}`,
      method: "GET",
    });
  }
}

type CachedInstallationToken = {
  token: string;
  expiresAt: number;
};

let cachedInstallationToken: CachedInstallationToken | null = null;

export async function getWorkspaceGitHubInstallationToken() {
  return getInstallationToken();
}

async function getInstallationToken() {
  if (cachedInstallationToken && cachedInstallationToken.expiresAt - Date.now() > 60_000) {
    return cachedInstallationToken.token;
  }

  const installationId = requiredEnv("GITHUB_APP_INSTALLATION_ID");
  const jwt = createAppJwt();
  const result = await githubRequest<{ token?: string; expires_at?: string }>({
    token: jwt,
    authScheme: "Bearer",
    path: `/app/installations/${installationId}/access_tokens`,
    method: "POST",
  });

  if (!result.token) {
    throw new Error("GitHub did not return an installation token.");
  }

  cachedInstallationToken = {
    token: result.token,
    expiresAt: result.expires_at
      ? new Date(result.expires_at).getTime()
      : Date.now() + 55 * 60 * 1000,
  };

  return result.token;
}

function createAppJwt() {
  const appId = requiredEnv("GITHUB_APP_ID");
  const privateKey = normalizePrivateKey(requiredEnv("GITHUB_APP_PRIVATE_KEY"));
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  );
  const input = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(input).sign(privateKey);

  return `${input}.${base64Url(signature)}`;
}

async function githubRequest<T>(input: {
  token: string;
  path: string;
  method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  body?: Record<string, unknown>;
  authScheme?: "Bearer" | "token";
}): Promise<T> {
  const startedAt = performance.now();
  const response = await fetch(`https://api.github.com${input.path}`, {
    method: input.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `${input.authScheme ?? "Bearer"} ${input.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
  });
  const durationMs = performance.now() - startedAt;

  logGitHubTiming(input.method, input.path, response, durationMs);

  if (!response.ok) {
    const details = await response.text();
    throw new GitHubApiError(response.status, details);
  }

  return (await response.json()) as T;
}

function logGitHubTiming(method: string, path: string, response: Response, durationMs: number) {
  if (process.env.OPENCOMPANY_TIMING !== "1" && process.env.OBSERVABILITY_TIMING !== "1") return;

  logger.info("GitHub API request", {
    event: "opencompany.github",
    method,
    path: redactGitHubPath(path),
    status: response.status,
    durationMs: Math.round(durationMs),
    rateLimitLimit: response.headers.get("x-ratelimit-limit"),
    rateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
    rateLimitUsed: response.headers.get("x-ratelimit-used"),
    rateLimitReset: response.headers.get("x-ratelimit-reset"),
    rateLimitResource: response.headers.get("x-ratelimit-resource"),
  });
}

function redactGitHubPath(path: string) {
  return path.replace(/\?.*$/, "");
}

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    details: string,
  ) {
    super(`GitHub API request failed with ${status}: ${details}`);
  }
}

function isGitHubConflict(error: unknown) {
  return error instanceof GitHubApiError && error.status === 422;
}

function managedRepoName(workspace: Workspace) {
  const name = workspace.name
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = workspace.id
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-10)
    .toLowerCase();

  return `opencompany-${name || "workspace"}-${suffix}`;
}

function encodeURIComponentPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required GitHub workspace-state env var: ${name}`);
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
