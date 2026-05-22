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
  full_name: string;
  default_branch?: string;
};

type GitHubContent = {
  sha?: string;
  content?: string;
  encoding?: string;
};

type GitHubContentWrite = {
  content?: {
    sha?: string;
  };
  commit?: {
    sha?: string;
  };
};

type GitHubContentDelete = {
  commit?: {
    sha?: string;
  };
};

type GitHubTree = {
  tree?: Array<{
    path?: string;
    type?: string;
    sha?: string;
  }>;
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

export async function writeWorkspaceFile(input: {
  db: Db;
  repository: WorkspaceRepositoryRecord;
  path: string;
  content: string;
  message: string;
  blobSha?: string | null;
}) {
  const token = await getInstallationToken();
  const currentSha =
    input.blobSha ??
    (
      await getFileSha({
        token,
        fullName: input.repository.fullName,
        path: input.path,
        branch: input.repository.defaultBranch,
      })
    )?.sha;
  let result: GitHubContentWrite;
  try {
    result = await putWorkspaceFileContent({
      token,
      repository: input.repository,
      path: input.path,
      content: input.content,
      message: input.message,
      ...(currentSha ? { sha: currentSha } : {}),
    });
  } catch (error) {
    if (!input.blobSha || !isGitHubContentConflict(error)) throw error;
    const latest = await getFileSha({
      token,
      fullName: input.repository.fullName,
      path: input.path,
      branch: input.repository.defaultBranch,
    });
    result = await putWorkspaceFileContent({
      token,
      repository: input.repository,
      path: input.path,
      content: input.content,
      message: input.message,
      ...(latest?.sha ? { sha: latest.sha } : {}),
    });
  }
  const commitSha = result.commit?.sha ?? null;
  const blobSha = result.content?.sha ?? null;

  await input.db
    .update(workspaceRepositories)
    .set({ latestHeadSha: commitSha, updatedAt: new Date() })
    .where(eq(workspaceRepositories.workspaceId, input.repository.workspaceId));

  return { commitSha, blobSha };
}

export async function deleteWorkspaceFile(input: {
  db: Db;
  repository: WorkspaceRepositoryRecord;
  path: string;
  message: string;
  blobSha?: string | null;
}) {
  const token = await getInstallationToken();
  const currentSha =
    input.blobSha ??
    (
      await getFileSha({
        token,
        fullName: input.repository.fullName,
        path: input.path,
        branch: input.repository.defaultBranch,
      })
    )?.sha;

  if (!currentSha) return { commitSha: null, deleted: false };

  let result: GitHubContentDelete;
  try {
    result = await deleteWorkspaceFileContent({
      token,
      repository: input.repository,
      path: input.path,
      message: input.message,
      sha: currentSha,
    });
  } catch (error) {
    if (isGitHubNotFound(error)) return { commitSha: null, deleted: false };
    if (!isGitHubContentConflict(error)) throw error;

    const latest = await getFileSha({
      token,
      fullName: input.repository.fullName,
      path: input.path,
      branch: input.repository.defaultBranch,
    });
    if (!latest?.sha) return { commitSha: null, deleted: false };

    result = await deleteWorkspaceFileContent({
      token,
      repository: input.repository,
      path: input.path,
      message: input.message,
      sha: latest.sha,
    });
  }

  const commitSha = result.commit?.sha ?? null;

  await input.db
    .update(workspaceRepositories)
    .set({ latestHeadSha: commitSha, updatedAt: new Date() })
    .where(eq(workspaceRepositories.workspaceId, input.repository.workspaceId));

  return { commitSha, deleted: true };
}

function putWorkspaceFileContent(input: {
  token: string;
  repository: WorkspaceRepositoryRecord;
  path: string;
  content: string;
  message: string;
  sha?: string;
}) {
  return githubRequest<GitHubContentWrite>({
    token: input.token,
    path: `/repos/${input.repository.fullName}/contents/${encodeURIComponentPath(input.path)}`,
    method: "PUT",
    body: {
      message: input.message,
      branch: input.repository.defaultBranch,
      content: Buffer.from(input.content, "utf8").toString("base64"),
      ...(input.sha ? { sha: input.sha } : {}),
    },
  });
}

function deleteWorkspaceFileContent(input: {
  token: string;
  repository: WorkspaceRepositoryRecord;
  path: string;
  message: string;
  sha: string;
}) {
  return githubRequest<GitHubContentDelete>({
    token: input.token,
    path: `/repos/${input.repository.fullName}/contents/${encodeURIComponentPath(input.path)}`,
    method: "DELETE",
    body: {
      message: input.message,
      branch: input.repository.defaultBranch,
      sha: input.sha,
    },
  });
}

export async function listWorkspaceAgentFiles(input: { repository: WorkspaceRepositoryRecord }) {
  const token = await getInstallationToken();
  const tree = await githubRequest<GitHubTree>({
    token,
    path: `/repos/${input.repository.fullName}/git/trees/${encodeURIComponent(
      input.repository.defaultBranch,
    )}?recursive=1`,
    method: "GET",
  });

  return (tree.tree ?? [])
    .filter((item) => {
      return (
        item.type === "blob" &&
        typeof item.path === "string" &&
        item.path.startsWith("agents/") &&
        item.path.endsWith(".agent")
      );
    })
    .map((item) => ({
      path: item.path!,
      sha: item.sha ?? null,
    }));
}

export async function readWorkspaceFile(input: {
  repository: WorkspaceRepositoryRecord;
  path: string;
}) {
  const token = await getInstallationToken();
  const file = await githubRequest<GitHubContent>({
    token,
    path: `/repos/${input.repository.fullName}/contents/${encodeURIComponentPath(
      input.path,
    )}?ref=${encodeURIComponent(input.repository.defaultBranch)}`,
    method: "GET",
  });

  if (!file.content || file.encoding !== "base64") {
    throw new Error(`Unable to read ${input.path} from GitHub.`);
  }

  return {
    content: Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8"),
    sha: file.sha ?? null,
  };
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

async function getFileSha(input: {
  token: string;
  fullName: string;
  path: string;
  branch: string;
}) {
  try {
    return await githubRequest<GitHubContent>({
      token: input.token,
      path: `/repos/${input.fullName}/contents/${encodeURIComponentPath(
        input.path,
      )}?ref=${encodeURIComponent(input.branch)}`,
      method: "GET",
    });
  } catch (error) {
    if (isGitHubNotFound(error)) return null;
    throw error;
  }
}

type CachedInstallationToken = {
  token: string;
  expiresAt: number;
};

let cachedInstallationToken: CachedInstallationToken | null = null;

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
  method: "DELETE" | "GET" | "POST" | "PUT";
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

function isGitHubContentConflict(error: unknown) {
  return error instanceof GitHubApiError && (error.status === 409 || error.status === 422);
}

function isGitHubNotFound(error: unknown) {
  return error instanceof GitHubApiError && error.status === 404;
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
