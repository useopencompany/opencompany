import { describe, expect, it } from "vitest";
import { type Actor, WIKI_READ_PERMISSION, WIKI_WRITE_PERMISSION } from "./actor";
import {
  type ExecuteWikiCommandInput,
  WikiCommandApplicationService,
  WikiCommandError,
  type WikiCommandRepository,
} from "./wiki-commands";

function fakeRepository(overrides: Partial<WikiCommandRepository> = {}): {
  repository: WikiCommandRepository;
  calls: Array<{ method: string; input: unknown }>;
} {
  const calls: Array<{ method: string; input: unknown }> = [];
  const record =
    <T>(method: string, result: T) =>
    async (input: unknown) => {
      calls.push({ method, input });
      return result;
    };
  const repository: WikiCommandRepository = {
    getTree: record("getTree", []),
    resolvePages: record("resolvePages", { pages: [], missing: [] }),
    getBacklinks: record("getBacklinks", []),
    grep: record("grep", []),
    search: record("search", []),
    recentChanges: record("recentChanges", []),
    listTimeline: record("listTimeline", []),
    createFolder: record("createFolder", {
      action: "created",
      path: "projects",
      title: "projects",
      createdAncestors: [],
    }),
    writePage: record("writePage", {
      action: "created",
      path: "projects/plan",
      slug: "plan",
      title: "Plan",
      createdAncestors: ["projects"],
    }),
    moveNode: record("moveNode", {
      path: "plan",
      fromPath: "projects/plan",
      movedDescendants: 0,
      rewrittenReferrers: [],
    }),
    deletePage: record("deletePage", { deletedPaths: ["projects/plan"] }),
    addTimelineEntry: record("addTimelineEntry", {
      at: new Date("2026-01-02T03:04:05.000Z"),
      text: "shipped",
    }),
    ...overrides,
  };
  return { repository, calls };
}

const actor = (permissions: readonly string[]): Actor => ({
  userId: "user_1",
  workspaceId: "ws_1",
  role: "admin",
  permissions,
  authenticationMethod: "service",
});

const readActor = actor([WIKI_READ_PERMISSION]);
const writeActor = actor([WIKI_READ_PERMISSION, WIKI_WRITE_PERMISSION]);

function run(
  service: WikiCommandApplicationService,
  actorValue: Actor,
  command: ExecuteWikiCommandInput["command"],
  idempotencyKey = "agent-wiki:turn_1:call_1",
) {
  return service.execute({ actor: actorValue, command, idempotencyKey });
}

describe("WikiCommandApplicationService", () => {
  it("requires WIKI_READ_PERMISSION for read commands", async () => {
    const { repository } = fakeRepository();
    const service = new WikiCommandApplicationService(repository);
    await expect(run(service, actor([]), { command: "tree" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("requires WIKI_WRITE_PERMISSION for write commands", async () => {
    const { repository } = fakeRepository();
    const service = new WikiCommandApplicationService(repository);
    await expect(
      run(service, readActor, { command: "write", path: "projects/plan", body: "# Plan" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("shapes an empty tree with a hint", async () => {
    const { repository } = fakeRepository();
    const service = new WikiCommandApplicationService(repository);
    const output = await run(service, readActor, { command: "tree" });
    expect(output).toEqual({
      ok: true,
      result: { nodes: [], total: 0, hint: expect.stringContaining("empty") },
    });
  });

  it("returns { ok: false } for domain validation errors instead of throwing", async () => {
    const { repository } = fakeRepository();
    const service = new WikiCommandApplicationService(repository);
    const output = await run(service, readActor, { command: "read" });
    expect(output).toEqual({ ok: false, error: 'read requires "pages" (path(s) or basename(s)).' });
  });

  it("maps repository WikiCommandError to the tool contract", async () => {
    const { repository } = fakeRepository({
      writePage: async () => {
        throw new WikiCommandError('A wiki node already exists at "projects/plan".');
      },
    });
    const service = new WikiCommandApplicationService(repository);
    const output = await run(service, writeActor, {
      command: "write",
      path: "projects/plan",
      body: "# Plan",
    });
    expect(output).toEqual({
      ok: false,
      error: 'A wiki node already exists at "projects/plan".',
    });
  });

  it("threads the idempotency key and actor identity into write commands", async () => {
    const { repository, calls } = fakeRepository();
    const service = new WikiCommandApplicationService(repository);
    await run(
      service,
      writeActor,
      { command: "write", path: "projects/plan", body: "# Plan", kind: "project" },
      "agent-wiki:turn_9:call_9",
    );
    expect(calls).toEqual([
      {
        method: "writePage",
        input: {
          workspaceId: "ws_1",
          actorWorkosId: "user_1",
          idempotencyKey: "agent-wiki:turn_9:call_9",
          path: "projects/plan",
          body: "# Plan",
          kind: "project",
        },
      },
    ]);
  });

  it("rejects an unknown kind before touching the repository", async () => {
    const { repository, calls } = fakeRepository();
    const service = new WikiCommandApplicationService(repository);
    const output = await run(service, writeActor, {
      command: "write",
      path: "projects/plan",
      body: "# Plan",
      kind: "bogus",
    });
    expect(output).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it("preserves the timeline-add output shape", async () => {
    const { repository } = fakeRepository();
    const service = new WikiCommandApplicationService(repository);
    const output = await run(service, writeActor, {
      command: "timeline-add",
      pages: "projects/plan",
      text: "shipped",
    });
    expect(output).toEqual({
      ok: true,
      result: { page: "projects/plan", at: "2026-01-02T03:04:05.000Z", text: "shipped" },
    });
  });
});
