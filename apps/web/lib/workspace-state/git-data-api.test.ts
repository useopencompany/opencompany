import { beforeEach, describe, expect, it, vi } from "vitest";
import { commitWorkspaceChanges } from "@/lib/workspace-state/git-data-api";

vi.mock("@/lib/workspace-state/github", () => ({
  getWorkspaceGitHubInstallationToken: vi.fn(async () => "ghs_test"),
}));

const repo = { fullName: "opencompany/test", defaultBranch: "main" };

type RouteResponse = { status?: number; body?: unknown };

// Minimal GitHub Git Data API stub: routes by `${method} ${pathname}`. Each
// route is a queue so repeated calls (e.g. the 422 rebuild) can return different
// responses per attempt.
function installFetch(routes: Record<string, RouteResponse[]>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const routeQueues = Object.fromEntries(
    Object.entries(routes).map(([key, queue]) => [key, [...queue]]),
  );
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const pathname = new URL(url).pathname;
    const key = `${method} ${pathname}`;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url: pathname, body });
    const queue = routeQueues[key];
    const route = queue?.shift();
    if (!route) throw new Error(`Unexpected request: ${key}`);
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.body ?? {},
      text: async () => JSON.stringify(route.body ?? {}),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

const HEAD = {
  "GET /repos/opencompany/test/git/ref/heads/main": [{ body: { object: { sha: "commit_1" } } }],
  "GET /repos/opencompany/test/git/commits/commit_1": [{ body: { tree: { sha: "tree_1" } } }],
};

describe("commitWorkspaceChanges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("commits many file changes as a single commit and preserves base_tree", async () => {
    const { calls } = installFetch({
      ...HEAD,
      "GET /repos/opencompany/test/git/trees/tree_1": [
        { body: { tree: [{ path: "brain/old.md", sha: "blob_old", type: "blob" }] } },
      ],
      "POST /repos/opencompany/test/git/trees": [
        {
          body: {
            sha: "tree_2",
            tree: [
              { path: "brain/a.md", sha: "blob_a", type: "blob" },
              { path: "agents/leo.agent", sha: "blob_leo", type: "blob" },
            ],
          },
        },
      ],
      "POST /repos/opencompany/test/git/commits": [{ body: { sha: "commit_2" } }],
      "PATCH /repos/opencompany/test/git/refs/heads/main": [{ body: {} }],
    });

    const result = await commitWorkspaceChanges({
      repo,
      message: "Update 2 workspace files",
      upserts: [
        { path: "brain/a.md", content: "A" },
        { path: "agents/leo.agent", content: "leo" },
      ],
      deletes: [{ path: "brain/old.md" }],
    });

    expect(result).not.toBeNull();
    expect(result?.commitSha).toBe("commit_2");
    expect(result?.blobShaByPath.get("brain/a.md")).toBe("blob_a");
    expect(result?.blobShaByPath.get("agents/leo.agent")).toBe("blob_leo");

    // Exactly one commit + one ref update for the whole batch.
    expect(calls.filter((c) => c.url.endsWith("/git/commits") && c.method === "POST")).toHaveLength(
      1,
    );
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);

    // base_tree MUST be passed (omitting it would wipe the repo).
    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"));
    expect((treeCall?.body as { base_tree?: string }).base_tree).toBe("tree_1");
    // Upserts inline content; the delete is a null-sha tree entry.
    const entries = (treeCall?.body as { tree: Array<Record<string, unknown>> }).tree;
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "brain/a.md", content: "A" }),
        expect.objectContaining({ path: "brain/old.md", sha: null }),
      ]),
    );
  });

  it("skips the commit when the resulting tree equals HEAD (no-op)", async () => {
    const { calls } = installFetch({
      ...HEAD,
      // Tree create returns the SAME sha as the current HEAD tree → nothing changed.
      "POST /repos/opencompany/test/git/trees": [{ body: { sha: "tree_1", tree: [] } }],
    });

    const result = await commitWorkspaceChanges({
      repo,
      message: "noop",
      upserts: [{ path: "brain/a.md", content: "A" }],
      deletes: [],
    });

    expect(result).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/git/commits"))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("creates the first commit and ref for an empty repo (no base_tree)", async () => {
    const { calls } = installFetch({
      "GET /repos/opencompany/test/git/ref/heads/main": [{ status: 404, body: {} }],
      "POST /repos/opencompany/test/git/trees": [
        { body: { sha: "tree_new", tree: [{ path: "brain/a.md", sha: "blob_a", type: "blob" }] } },
      ],
      "POST /repos/opencompany/test/git/commits": [{ body: { sha: "commit_first" } }],
      "POST /repos/opencompany/test/git/refs": [{ body: {} }],
    });

    const result = await commitWorkspaceChanges({
      repo,
      message: "init",
      upserts: [{ path: "brain/a.md", content: "A" }],
      deletes: [],
    });

    expect(result?.commitSha).toBe("commit_first");
    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"));
    expect((treeCall?.body as { base_tree?: string }).base_tree).toBeUndefined();
    const commitCall = calls.find((c) => c.url.endsWith("/git/commits"));
    expect((commitCall?.body as { parents: string[] }).parents).toEqual([]);
    // Ref is created (POST /git/refs), not patched.
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/git/refs") && c.method === "POST")).toBe(true);
  });

  it("rebuilds once against the new HEAD when the ref update conflicts (422)", async () => {
    installFetch({
      "GET /repos/opencompany/test/git/ref/heads/main": [
        { body: { object: { sha: "commit_1" } } },
        { body: { object: { sha: "commit_x" } } },
      ],
      "GET /repos/opencompany/test/git/commits/commit_1": [{ body: { tree: { sha: "tree_1" } } }],
      "GET /repos/opencompany/test/git/commits/commit_x": [{ body: { tree: { sha: "tree_x" } } }],
      "POST /repos/opencompany/test/git/trees": [
        { body: { sha: "tree_2", tree: [{ path: "brain/a.md", sha: "blob_a", type: "blob" }] } },
        { body: { sha: "tree_3", tree: [{ path: "brain/a.md", sha: "blob_a2", type: "blob" }] } },
      ],
      "POST /repos/opencompany/test/git/commits": [
        { body: { sha: "commit_2" } },
        { body: { sha: "commit_3" } },
      ],
      "PATCH /repos/opencompany/test/git/refs/heads/main": [
        { status: 422, body: { message: "ref moved" } },
        { body: {} },
      ],
    });

    const result = await commitWorkspaceChanges({
      repo,
      message: "retry",
      upserts: [{ path: "brain/a.md", content: "A" }],
      deletes: [],
    });

    // Second attempt rebuilt on tree_x and succeeded.
    expect(result?.commitSha).toBe("commit_3");
    expect(result?.blobShaByPath.get("brain/a.md")).toBe("blob_a2");
  });

  it("skips stale delete entries that are already absent from the base tree", async () => {
    const { calls } = installFetch({
      ...HEAD,
      "GET /repos/opencompany/test/git/trees/tree_1": [
        { body: { tree: [{ path: "brain/other.md", sha: "blob_other", type: "blob" }] } },
      ],
    });

    const result = await commitWorkspaceChanges({
      repo,
      message: "delete stale",
      upserts: [],
      deletes: [{ path: "brain/missing.md" }],
    });

    expect(result).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/git/trees") && c.method === "POST")).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/git/commits"))).toBe(false);
  });

  it("filters missing deletes while still committing upserts", async () => {
    const { calls } = installFetch({
      ...HEAD,
      "GET /repos/opencompany/test/git/trees/tree_1": [
        { body: { tree: [{ path: "brain/old.md", sha: "blob_old", type: "blob" }] } },
      ],
      "POST /repos/opencompany/test/git/trees": [
        {
          body: {
            sha: "tree_2",
            tree: [{ path: "brain/a.md", sha: "blob_a", type: "blob" }],
          },
        },
      ],
      "POST /repos/opencompany/test/git/commits": [{ body: { sha: "commit_2" } }],
      "PATCH /repos/opencompany/test/git/refs/heads/main": [{ body: {} }],
    });

    const result = await commitWorkspaceChanges({
      repo,
      message: "update and delete",
      upserts: [{ path: "brain/a.md", content: "A" }],
      deletes: [{ path: "brain/missing.md" }, { path: "brain/old.md" }],
    });

    expect(result?.commitSha).toBe("commit_2");
    const treeCall = calls.find((c) => c.url.endsWith("/git/trees") && c.method === "POST");
    const entries = (treeCall?.body as { tree: Array<Record<string, unknown>> }).tree;
    expect(entries).toEqual([
      expect.objectContaining({ path: "brain/a.md", content: "A" }),
      expect.objectContaining({ path: "brain/old.md", sha: null }),
    ]);
  });

  it("does not retry non-ref GitHub 422 responses", async () => {
    const { calls } = installFetch({
      ...HEAD,
      "POST /repos/opencompany/test/git/trees": [
        { status: 422, body: { message: "GitRPC::BadObjectState" } },
      ],
    });

    await expect(
      commitWorkspaceChanges({
        repo,
        message: "bad tree",
        upserts: [{ path: "brain/a.md", content: "A" }],
        deletes: [],
      }),
    ).rejects.toThrow("GitHub Git Data API request failed with 422");

    expect(calls.filter((c) => c.url.endsWith("/git/trees") && c.method === "POST")).toHaveLength(
      1,
    );
  });

  it("returns null without any request when there are no changes", async () => {
    const { calls } = installFetch({});
    const result = await commitWorkspaceChanges({
      repo,
      message: "empty",
      upserts: [],
      deletes: [],
    });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
