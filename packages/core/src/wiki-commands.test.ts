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
      result: {
        nodes: [],
        depth: "unlimited",
        shown: 0,
        total: 0,
        truncated: false,
        hint: expect.stringContaining("empty"),
      },
    });
  });

  it("automatically limits large trees to root entries and makes the omission explicit", async () => {
    const nodes = Array.from({ length: 41 }, (_, index) => ({
      slug: `page-${index}`,
      path: index === 0 ? "projects" : `projects/page-${index}`,
      title: `Page ${index}`,
      kind: "other" as const,
      nodeType: index === 0 ? ("folder" as const) : ("page" as const),
      sizeBytes: 0,
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      childCount: index === 0 ? 40 : 0,
    }));
    const { repository } = fakeRepository({ getTree: async () => nodes });
    const service = new WikiCommandApplicationService(repository);

    const output = await run(service, readActor, { command: "tree" });

    expect(output).toEqual({
      ok: true,
      result: {
        nodes: [
          {
            path: "projects/",
            type: "folder",
            title: "Page 0",
            children: 40,
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        depth: 0,
        shown: 1,
        total: 41,
        truncated: true,
        hint: expect.stringContaining("Showing depth 0"),
      },
    });
  });

  it("honors an explicit tree depth and reports how much remains hidden", async () => {
    const nodes = [
      {
        slug: "projects",
        path: "projects",
        title: "Projects",
        kind: "other" as const,
        nodeType: "folder" as const,
        sizeBytes: 0,
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        childCount: 1,
      },
      {
        slug: "website",
        path: "projects/website",
        title: "Website",
        kind: "project" as const,
        nodeType: "folder" as const,
        sizeBytes: 0,
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        childCount: 1,
      },
      {
        slug: "launch",
        path: "projects/website/launch",
        title: "Launch",
        kind: "project" as const,
        nodeType: "page" as const,
        sizeBytes: 0,
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        childCount: 0,
      },
    ];
    const { repository } = fakeRepository({ getTree: async () => nodes });
    const service = new WikiCommandApplicationService(repository);

    const output = await run(service, readActor, { command: "tree", depth: 1 });

    expect(output).toMatchObject({
      ok: true,
      result: {
        depth: 1,
        shown: 2,
        total: 3,
        truncated: true,
        hint: expect.stringContaining("1 deeper entries are omitted"),
      },
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
