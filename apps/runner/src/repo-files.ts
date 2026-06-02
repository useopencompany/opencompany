import { createHash, randomUUID } from "node:crypto";
import { BRAIN_SYNC_DELAY_MS } from "@opencompany/agent-runtime";
import type { agentFileSyncJobs, brainSyncJobs, WorkspaceRepository } from "@opencompany/db/schema";
import { getDb } from "./db";
import { getGitHubInstallationToken } from "./github";

type RepoFileSyncJobsTable = typeof brainSyncJobs | typeof agentFileSyncJobs;
type RepoFileSyncJobOperation = "upsert" | "delete";

export function hashContent(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function conflictPath(path: string) {
  const dot = path.lastIndexOf(".");
  // Random (not timestamp) suffix so concurrent conflicts can't collide.
  const suffix = `.conflict-${randomUUID().slice(0, 8)}`;
  if (dot <= 0) return `${path}${suffix}`;
  return `${path.slice(0, dot)}${suffix}${path.slice(dot)}`;
}

export async function writeRepoFileToGitHub(
  repository: WorkspaceRepository | null | undefined,
  path: string,
  content: string,
) {
  if (!repository) return { commitSha: null, blobSha: null };
  const token = await getGitHubInstallationToken();
  if (!token) return { commitSha: null, blobSha: null };
  const repositoryPath = githubRepositoryPath(repository.fullName);
  const encodedPath = `/repos/${repositoryPath}/contents/${encodeURIComponentPath(path)}`;
  const put = (sha: string | undefined) =>
    githubRequest<{ content?: { sha?: string }; commit?: { sha?: string } }>({
      token,
      repository,
      path: encodedPath,
      method: "PUT",
      body: {
        message: `Update ${path}`,
        branch: repository.defaultBranch,
        content: Buffer.from(content, "utf8").toString("base64"),
        ...(sha ? { sha } : {}),
      },
    });

  let current = await getGitHubFile(token, repository, path);
  let result: { content?: { sha?: string }; commit?: { sha?: string } };
  try {
    result = await put(current?.sha);
  } catch (error) {
    // Concurrent writers can leave us with a stale blob SHA (409/422). Refetch
    // the latest SHA once and retry rather than failing the whole sync.
    if (!isGitHubShaConflict(error)) throw error;
    current = await getGitHubFile(token, repository, path);
    result = await put(current?.sha);
  }
  return { commitSha: result.commit?.sha ?? null, blobSha: result.content?.sha ?? null };
}

export async function deleteRepoFileFromGitHub(
  repository: WorkspaceRepository | null | undefined,
  path: string,
  blobSha: string | null,
) {
  if (!repository) return;
  const token = await getGitHubInstallationToken();
  if (!token) return;
  const repositoryPath = githubRepositoryPath(repository.fullName);
  const encodedPath = `/repos/${repositoryPath}/contents/${encodeURIComponentPath(path)}`;
  const del = (sha: string) =>
    githubRequest({
      token,
      repository,
      path: encodedPath,
      method: "DELETE",
      body: {
        message: `Delete ${path}`,
        branch: repository.defaultBranch,
        sha,
      },
    });

  const current = blobSha ? { sha: blobSha } : await getGitHubFile(token, repository, path);
  if (!current?.sha) return;
  try {
    await del(current.sha);
  } catch (error) {
    // Same self-healing path as writeRepoFileToGitHub: a stale SHA means a
    // concurrent update landed first, so refetch and retry the delete once.
    if (!isGitHubShaConflict(error)) throw error;
    const latest = await getGitHubFile(token, repository, path);
    if (!latest?.sha) return;
    await del(latest.sha);
  }
}

export async function upsertRepoFileSyncJob(input: {
  jobsTable: RepoFileSyncJobsTable;
  workspaceId: string;
  path: string;
  operation: RepoFileSyncJobOperation;
  desiredHash: string | null;
  previousPath?: string | null | undefined;
  previousBlobSha?: string | null | undefined;
  delayMs?: number;
}) {
  const now = new Date();
  const nextRunAt = new Date(now.getTime() + (input.delayMs ?? BRAIN_SYNC_DELAY_MS));
  await getDb()
    .insert(input.jobsTable)
    .values({
      workspaceId: input.workspaceId,
      path: input.path,
      operation: input.operation,
      desiredHash: input.desiredHash,
      previousPath: input.previousPath ?? null,
      previousBlobSha: input.previousBlobSha ?? null,
      nextRunAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [input.jobsTable.workspaceId, input.jobsTable.path],
      set: {
        operation: input.operation,
        desiredHash: input.desiredHash,
        previousPath: input.previousPath ?? null,
        previousBlobSha: input.previousBlobSha ?? null,
        status: "pending",
        nextRunAt,
        lastError: null,
        updatedAt: now,
      },
    });
}

// Bound every GitHub call so a slow/hung response can't stall sandbox setup or
// post-run sync indefinitely. Override via GITHUB_REQUEST_TIMEOUT_MS.
const GITHUB_REQUEST_TIMEOUT_MS = Number(process.env.GITHUB_REQUEST_TIMEOUT_MS) || 30_000;

class GitHubRequestError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`GitHub request failed with ${status}: ${body}`);
    this.name = "GitHubRequestError";
    this.status = status;
  }
}

function isGitHubShaConflict(error: unknown): boolean {
  // GitHub returns 409 (and occasionally 422) when the supplied blob SHA is
  // stale relative to the branch head.
  return error instanceof GitHubRequestError && (error.status === 409 || error.status === 422);
}

async function getGitHubFile(token: string, repository: WorkspaceRepository, path: string) {
  try {
    const repositoryPath = githubRepositoryPath(repository.fullName);
    return await githubRequest<{ sha?: string }>({
      token,
      repository,
      path: `/repos/${repositoryPath}/contents/${encodeURIComponentPath(path)}?ref=${encodeURIComponent(repository.defaultBranch)}`,
      method: "GET",
    });
  } catch (error) {
    if (error instanceof GitHubRequestError && error.status === 404) return null;
    if (error instanceof Error && /404|not found/i.test(error.message)) return null;
    throw error;
  }
}

async function githubRequest<T = unknown>(input: {
  token: string;
  repository: WorkspaceRepository;
  path: string;
  method: "GET" | "PUT" | "DELETE";
  body?: unknown;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
  const init: RequestInit = {
    method: input.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: controller.signal,
  };
  if (input.body !== undefined) {
    init.body = JSON.stringify(input.body);
  }
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${input.path}`, init);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `GitHub request timed out after ${GITHUB_REQUEST_TIMEOUT_MS}ms: ${input.method} ${input.path}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new GitHubRequestError(response.status, await response.text());
  }
  return (await response.json()) as T;
}

function encodeURIComponentPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function githubRepositoryPath(fullName: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw new Error("Invalid GitHub repository full name.");
  }
  return fullName;
}
