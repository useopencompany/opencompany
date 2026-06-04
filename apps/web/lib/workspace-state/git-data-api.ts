import { getWorkspaceGitHubInstallationToken } from "@/lib/workspace-state/github";

// Git Data API client. Unlike the Contents API (one PUT == one commit per file),
// this builds ONE commit from many file changes: create a tree off the current
// HEAD tree, create one commit, then fast-forward the branch ref. This is what
// lets a whole workspace sync (many brain files + agent files + .agent edits)
// land as a single, coherent GitHub commit.
//
// CRITICAL: every tree we create passes `base_tree` (the current head commit's
// tree). Omitting it would replace the entire repo with only our entries —
// silently deleting every unmanaged file. The only exception is the empty-repo
// path, where there is no base tree by definition.

export type RepoRef = {
  fullName: string;
  defaultBranch: string;
};

export type CommitUpsert = {
  /** Full repo-relative path, e.g. "brain/spec.md". */
  path: string;
  /** UTF-8 file content (inlined into the tree entry; GitHub hashes the blob). */
  content: string;
};

export type CommitDelete = {
  path: string;
};

export type WorkspaceCommitResult = {
  commitSha: string;
  /** Per-path resulting blob SHA, for upserts only. */
  blobShaByPath: Map<string, string>;
};

type GitRef = { object?: { sha?: string } };
type GitCommit = { tree?: { sha?: string } };
type GitTreeEntryInput =
  | { path: string; mode: "100644"; type: "blob"; content: string }
  | { path: string; mode: "100644"; type: "blob"; sha: null };
type GitTreeResponse = {
  sha?: string;
  tree?: Array<{ path?: string; sha?: string; type?: string }>;
};
type GitCommitResponse = { sha?: string };
type BranchHead = { commitSha: string; treeSha: string };

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    details: string,
  ) {
    super(`GitHub Git Data API request failed with ${status}: ${details}`);
  }
}

function isNotFound(error: unknown) {
  return error instanceof GitHubApiError && error.status === 404;
}

function isRefConflict(error: unknown) {
  // 422 (unprocessable) / 409 (conflict) on ref update == the branch head moved
  // under us between read and update.
  return error instanceof GitHubApiError && (error.status === 409 || error.status === 422);
}

class GitRefConflictError extends Error {
  constructor(cause: unknown) {
    super("GitHub branch ref moved while committing workspace changes.", { cause });
  }
}

const GITHUB_REQUEST_TIMEOUT_MS = Number(process.env.GITHUB_REQUEST_TIMEOUT_MS) || 30_000;

async function gitHubRequest<T>(input: {
  token: string;
  path: string;
  method: "GET" | "PATCH" | "POST";
  body?: Record<string, unknown>;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${input.path}`, {
      method: input.method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    });
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
    throw new GitHubApiError(response.status, await response.text());
  }
  return (await response.json()) as T;
}

function refPath(repo: RepoRef) {
  return `heads/${encodeURIComponent(repo.defaultBranch)}`;
}

async function getBranchHead(token: string, repo: RepoRef): Promise<BranchHead | null> {
  let ref: GitRef;
  try {
    ref = await gitHubRequest<GitRef>({
      token,
      path: `/repos/${repo.fullName}/git/ref/${refPath(repo)}`,
      method: "GET",
    });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const commitSha = ref.object?.sha;
  if (!commitSha) return null;

  const commit = await gitHubRequest<GitCommit>({
    token,
    path: `/repos/${repo.fullName}/git/commits/${commitSha}`,
    method: "GET",
  });
  const treeSha = commit.tree?.sha;
  if (!treeSha) return null;
  return { commitSha, treeSha };
}

async function buildTreeEntries(input: {
  token: string;
  repo: RepoRef;
  head: BranchHead | null;
  upserts: CommitUpsert[];
  deletes: CommitDelete[];
}): Promise<GitTreeEntryInput[]> {
  const entries: GitTreeEntryInput[] = input.upserts.map((file) => ({
    path: file.path,
    mode: "100644",
    type: "blob",
    content: file.content,
  }));

  if (input.deletes.length === 0 || !input.head) return entries;

  const existingBlobPaths = await getTreeBlobPaths(input.token, input.repo, input.head.treeSha);
  entries.push(
    ...input.deletes
      .filter((file) => existingBlobPaths.has(file.path))
      .map(
        (file): GitTreeEntryInput => ({
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: null,
        }),
      ),
  );
  return entries;
}

async function getTreeBlobPaths(
  token: string,
  repo: RepoRef,
  treeSha: string,
): Promise<Set<string>> {
  const tree = await gitHubRequest<GitTreeResponse>({
    token,
    path: `/repos/${repo.fullName}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
    method: "GET",
  });
  return new Set(
    (tree.tree ?? [])
      .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
      .map((entry) => entry.path!),
  );
}

async function createTree(
  token: string,
  repo: RepoRef,
  baseTreeSha: string | null,
  entries: GitTreeEntryInput[],
): Promise<GitTreeResponse> {
  return gitHubRequest<GitTreeResponse>({
    token,
    path: `/repos/${repo.fullName}/git/trees`,
    method: "POST",
    body: {
      ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
      tree: entries,
    },
  });
}

async function createCommit(
  token: string,
  repo: RepoRef,
  input: { message: string; treeSha: string; parents: string[] },
): Promise<string> {
  const commit = await gitHubRequest<GitCommitResponse>({
    token,
    path: `/repos/${repo.fullName}/git/commits`,
    method: "POST",
    body: {
      message: input.message,
      tree: input.treeSha,
      parents: input.parents,
    },
  });
  if (!commit.sha) throw new Error("GitHub did not return a commit SHA.");
  return commit.sha;
}

async function updateBranchRef(token: string, repo: RepoRef, commitSha: string) {
  try {
    await gitHubRequest({
      token,
      path: `/repos/${repo.fullName}/git/refs/${refPath(repo)}`,
      method: "PATCH",
      body: { sha: commitSha, force: false },
    });
  } catch (error) {
    if (isRefConflict(error)) throw new GitRefConflictError(error);
    throw error;
  }
}

async function createBranchRef(token: string, repo: RepoRef, commitSha: string) {
  try {
    await gitHubRequest({
      token,
      path: `/repos/${repo.fullName}/git/refs`,
      method: "POST",
      body: { ref: `refs/${refPath(repo)}`, sha: commitSha },
    });
  } catch (error) {
    if (isRefConflict(error)) throw new GitRefConflictError(error);
    throw error;
  }
}

function collectBlobShas(tree: GitTreeResponse, upserts: CommitUpsert[]): Map<string, string> {
  const wanted = new Set(upserts.map((file) => file.path));
  const result = new Map<string, string>();
  for (const entry of tree.tree ?? []) {
    if (entry.path && entry.sha && entry.type === "blob" && wanted.has(entry.path)) {
      result.set(entry.path, entry.sha);
    }
  }
  return result;
}

/**
 * Commit a batch of file upserts/deletes as a SINGLE GitHub commit.
 *
 * Returns null when the change set is a genuine no-op (the new tree equals the
 * current HEAD tree) — the caller should then skip creating a commit. On a ref
 * conflict (head moved between read and update) the whole flow is rebuilt once
 * against the new head before failing.
 */
export async function commitWorkspaceChanges(input: {
  repo: RepoRef;
  message: string;
  upserts: CommitUpsert[];
  deletes: CommitDelete[];
}): Promise<WorkspaceCommitResult | null> {
  if (input.upserts.length === 0 && input.deletes.length === 0) return null;

  const token = await getWorkspaceGitHubInstallationToken();

  const attempt = async (): Promise<WorkspaceCommitResult | null> => {
    const head = await getBranchHead(token, input.repo);
    const entries = await buildTreeEntries({
      token,
      repo: input.repo,
      head,
      upserts: input.upserts,
      deletes: input.deletes,
    });
    if (entries.length === 0) return null;

    const tree = await createTree(token, input.repo, head?.treeSha ?? null, entries);
    if (!tree.sha) throw new Error("GitHub did not return a tree SHA.");

    // No-op: the resulting tree matches the current HEAD tree, so committing
    // would only produce an empty commit. Skip it.
    if (head && tree.sha === head.treeSha) return null;

    const commitSha = await createCommit(token, input.repo, {
      message: input.message,
      treeSha: tree.sha,
      parents: head ? [head.commitSha] : [],
    });

    if (head) {
      await updateBranchRef(token, input.repo, commitSha);
    } else {
      await createBranchRef(token, input.repo, commitSha);
    }

    return { commitSha, blobShaByPath: collectBlobShas(tree, input.upserts) };
  };

  try {
    return await attempt();
  } catch (error) {
    // The branch head moved under us (e.g. a concurrent push). Rebuild the tree
    // on the new base and retry exactly once before surfacing the failure.
    if (!(error instanceof GitRefConflictError)) throw error;
    return await attempt();
  }
}
