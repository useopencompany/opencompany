import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
  const insertQuery = { kind: "insert" };
  const updateQuery = { kind: "update" };
  const insertValues = vi.fn(() => insertQuery);
  const updateWhere = vi.fn(() => updateQuery);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const update = vi.fn(() => ({ set: updateSet }));
  const batch = vi.fn(async () => []);

  return {
    batch,
    db: { batch, insert, update },
    insert,
    insertQuery,
    insertValues,
    update,
    updateQuery,
    updateSet,
    updateWhere,
  };
});

vi.mock("@opencompany/db/client", () => ({
  getDb: () => dbMocks.db,
}));

vi.mock("@opencompany/db/brain-read", () => ({
  searchBrain: vi.fn(),
  getBrainDocuments: vi.fn(),
  getBrainTimeline: vi.fn(),
  listBrainDocuments: vi.fn(),
}));

import { renderBrainToolCommand, runBrainToolForUser } from "@opencompany/agent/brain-cli";
import {
  getBrainDocuments,
  getBrainTimeline,
  listBrainDocuments,
  searchBrain,
} from "@opencompany/db/brain-read";
import { brainToolRuns, users } from "@opencompany/db/product-schema";

const BASE_INPUT = {
  brainRef: "goat_brain_user_1",
  userWorkosId: "user_1",
  gatewayApiKey: "gateway_test",
  sourceRef: "goat-chat:user_message_1",
};

describe("runBrainToolForUser", () => {
  it("does not silently ignore stdin for create truth", () => {
    expect(
      renderBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "opencompany",
            title: "opencompany",
            type: "company",
            json: true,
          },
          stdin: "opencompany is a company.",
        },
        "goat-chat:user_message_1",
      ),
    ).toEqual({
      argv: [
        "create",
        "--id",
        "opencompany",
        "--title",
        "opencompany",
        "--type",
        "company",
        "--json",
        "--truth-stdin",
        "--source-ref",
        "goat-chat:user_message_1",
      ],
      stdin: "opencompany is a company.",
    });
  });

  it("rejects create without an explicit type", () => {
    expect(() =>
      renderBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "opencompany",
            title: "opencompany",
            truth: "opencompany is a company.",
          },
        },
        "goat-chat:user_message_1",
      ),
    ).toThrow("brain create requires a type.");
    expect(() =>
      renderBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "opencompany",
            title: "opencompany",
            truth: "opencompany is a company.",
          },
        },
        "goat-chat:user_message_1",
      ),
    ).toThrow('Relevant help command: { command: "help", flags: { topic: "create" } }.');
  });

  it("rejects create without compiled truth", () => {
    expect(() =>
      renderBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "opencompany",
            title: "opencompany",
            type: "company",
          },
        },
        "goat-chat:user_message_1",
      ),
    ).toThrow("brain create requires compiled truth");
  });

  it("allows create in any free-form folder", () => {
    expect(
      renderBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "opencompany",
            folder: "accounts/customers",
            title: "opencompany",
            type: "company",
            truth: "opencompany is a company.",
          },
        },
        "goat-chat:user_message_1",
      ).argv,
    ).toContain("accounts/customers");
  });

  it("rejects create with an invalid kind", () => {
    expect(() =>
      renderBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "ev-opencompany-chat",
            kind: "snapshot",
            title: "opencompany chat",
            type: "source",
            truth: "opencompany was discussed in chat.",
          },
        },
        "goat-chat:user_message_1",
      ),
    ).toThrow('brain create kind must be "page" or "evidence"');

    expect(
      renderBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "ev-opencompany-chat",
            kind: "evidence",
            folder: "evidence",
            title: "opencompany chat",
            type: "source",
            truth: "opencompany was discussed in chat.",
          },
        },
        "goat-chat:user_message_1",
      ).argv,
    ).toContain("evidence");
  });

  it("renders brain help invocations", () => {
    expect(
      renderBrainToolCommand(
        {
          command: "help",
          flags: { topic: "create" },
        },
        "goat-chat:user_message_1",
      ),
    ).toEqual({
      argv: ["help", "create"],
    });
  });

  it("passes includeMerged through for list and query", () => {
    expect(
      renderBrainToolCommand(
        {
          command: "query",
          flags: { text: "Sarah Chen", includeMerged: true, json: true },
        },
        "goat-chat:user_message_1",
      ).argv,
    ).toEqual(["query", "--text", "Sarah Chen", "--include-merged", "--json"]);

    expect(
      renderBrainToolCommand(
        {
          command: "list",
          flags: { folder: "people", includeMerged: true, json: true },
        },
        "goat-chat:user_message_1",
      ).argv,
    ).toEqual(["list", "--folder", "people", "--include-merged", "--json"]);
  });

  it("renders append-evidence as an evidence-record command", () => {
    expect(
      renderBrainToolCommand(
        {
          command: "append-evidence",
          flags: {
            id: "opencompany",
            type: "source",
            body: "Acme asked for pricing.",
            json: true,
          },
        },
        "goat-chat:user_message_1",
      ).argv,
    ).toEqual([
      "append-evidence",
      "--id",
      "opencompany",
      "--type",
      "source",
      "--body",
      "Acme asked for pricing.",
      "--json",
      "--source-ref",
      "goat-chat:user_message_1",
    ]);
  });

  it("returns a helpful error for unsupported create entity types", async () => {
    const output = await runBrainToolForUser({
      ...BASE_INPUT,
      toolInput: {
        command: "create",
        flags: {
          id: "jordan-lee",
          title: "Jordan Lee",
          type: "candidate",
          json: true,
        },
      },
    });

    expect(output).toMatchObject({
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: expect.stringContaining(
        'Unsupported opencompany Brain entity type "candidate". Use one of: person, company, project, meeting, concept, source, analysis, note.',
      ),
    });
    expect(output.error).toContain('Relevant help command: { command: "help"');
  });

  it("does not expose ingest through the chat tool", async () => {
    const output = await runBrainToolForUser({
      ...BASE_INPUT,
      toolInput: {
        command: "ingest",
        flags: { textStdin: true, json: true },
        stdin: "Remember this.",
      } as never,
    });

    expect(output).toMatchObject({
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: expect.stringContaining('Unsupported brain command "ingest".'),
    });
    expect(output.error).toContain("For command-specific usage");
  });
});

describe("read plane commands", () => {
  beforeEach(() => {
    dbMocks.batch.mockClear();
    dbMocks.insert.mockClear();
    dbMocks.insertValues.mockClear();
    dbMocks.update.mockClear();
    dbMocks.updateSet.mockClear();
    dbMocks.updateWhere.mockClear();
    vi.mocked(searchBrain).mockReset();
    vi.mocked(getBrainDocuments).mockReset();
    vi.mocked(getBrainTimeline).mockReset();
    vi.mocked(listBrainDocuments).mockReset();
  });

  const HIT = {
    id: "ada",
    title: "Ada",
    type: "person",
    kind: "page",
    folder: "team/gtm",
    status: "active",
    updatedAt: "2026-07-01T00:00:00.000Z",
    score: 0.91,
    signals: ["lexical", "vector"],
    snippet: "Ada leads GTM.",
    neighbors: [
      {
        id: "acme",
        title: "Acme",
        kind: "page",
        type: "company",
        folder: "companies",
        status: "active",
        relationType: "works_at",
        sourceKind: "relation",
        direction: "out" as const,
      },
      {
        id: "ev-acme-email",
        title: "Acme email",
        kind: "evidence",
        type: "source",
        folder: "evidence/email",
        status: "active",
        relationType: "cites",
        sourceKind: "wiki_link",
        direction: "out" as const,
      },
    ],
  };

  it("serves query from the read module with mapped options", async () => {
    vi.mocked(searchBrain).mockResolvedValue([HIT as never]);

    const output = await runBrainToolForUser({
      ...BASE_INPUT,
      toolInput: {
        command: "query",
        flags: {
          text: "who runs gtm",
          folder: "team",
          type: "person",
          since: "last 6 hours",
          limit: "5",
          hops: 1,
          lexicalOnly: true,
          graphDirection: "out",
        },
      },
    });

    expect(searchBrain).toHaveBeenCalledWith(
      expect.objectContaining({ brainRef: "goat_brain_user_1", gatewayApiKey: "gateway_test" }),
      {
        text: "who runs gtm",
        folder: "team",
        type: "person",
        kind: "page",
        since: "last 6 hours",
        limit: 6,
        offset: 0,
        hops: 1,
        lexicalOnly: true,
      },
    );
    expect(output.ok).toBe(true);
    expect(output.stdout).toBeUndefined();
    expect(output.parsed).toEqual({
      hits: [HIT],
      mode: "search",
      scope: { kind: "page" },
      pagination: {
        limit: 5,
        offset: 0,
        returned: 1,
        hasMore: false,
      },
    });
    expect(output.traceId).toMatch(/^goat_brain_run_/);
    expect(dbMocks.insert).toHaveBeenCalledWith(brainToolRuns);
    expect(dbMocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        brainRef: "goat_brain_user_1",
        sourceRef: "goat-chat:user_message_1",
        action: "query",
        ok: true,
      }),
    );
    expect(dbMocks.batch).not.toHaveBeenCalled();
    expect(dbMocks.update).not.toHaveBeenCalled();
  });

  it("records MCP queries and setup completion in a non-interactive transaction", async () => {
    vi.mocked(searchBrain).mockResolvedValue([HIT as never]);

    const output = await runBrainToolForUser({
      ...BASE_INPUT,
      sourceRef: "mcp:chatgpt",
      toolInput: { command: "query", flags: { text: "who runs gtm" } },
    });

    expect(output.ok).toBe(true);
    expect(dbMocks.batch).toHaveBeenCalledWith([dbMocks.insertQuery, dbMocks.updateQuery]);
    expect(dbMocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        brainRef: "goat_brain_user_1",
        sourceRef: "mcp:chatgpt",
        action: "query",
        ok: true,
      }),
    );
    expect(dbMocks.update).toHaveBeenCalledWith(users);
    expect(dbMocks.updateSet).toHaveBeenCalledWith({
      mcpSetupCompletedAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  it("serves get for multiple ids and reports missing ones", async () => {
    vi.mocked(getBrainDocuments).mockResolvedValue({
      documents: [
        {
          requestedId: "ada lovelace",
          id: "ada",
          resolvedVia: "alias",
          title: "Ada",
          folder: "team/gtm",
          kind: "page",
          type: "person",
          status: "active",
          aliases: ["Ada Lovelace"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
          compiledTruth: "Ada leads GTM.",
          timeline: [{ at: "2026-06-01T00:00:00.000Z", evidenceId: "ev-1", body: "Joined." }],
          timelineTotal: 1,
          sources: [],
          links: [
            {
              id: "acme",
              title: "Acme",
              kind: "page",
              type: "company",
              folder: "companies",
              status: "active",
              relationType: "works_at",
              sourceKind: "relation",
              direction: "out",
            },
          ],
        },
      ] as never,
      missing: ["ghost"],
    });

    const output = await runBrainToolForUser({
      ...BASE_INPUT,
      toolInput: {
        command: "get",
        flags: { id: ["ada lovelace", "ghost"] },
      },
    });

    expect(getBrainDocuments).toHaveBeenCalledWith(expect.anything(), ["ada lovelace", "ghost"]);
    expect(output.ok).toBe(true);
    expect(output.stdout).toBeUndefined();
    expect(output.parsed).toMatchObject({
      documents: [expect.objectContaining({ id: "ada" })],
      missing: ["ghost"],
    });
  });

  it("fails get with a surface-neutral message and no write-command manual", async () => {
    vi.mocked(getBrainDocuments).mockResolvedValue({ documents: [], missing: ["ghost"] });

    const output = await runBrainToolForUser({
      ...BASE_INPUT,
      toolInput: { command: "get", flags: { id: "ghost" } },
    });

    expect(output.ok).toBe(false);
    expect(output.error).toContain('No brain doc found with id "ghost"');
    expect(output.error).toContain("Search for it to find the right id.");
    // Read errors no longer append the CLI manual (which documents create/rewrite/merge/delete).
    expect(output.error).not.toContain("append-evidence");
    expect(output.error).not.toContain("Use brain as { command, flags, stdin? }");
  });

  it("marks a recency-only browse as mode: browse and threads verbosity flags", async () => {
    vi.mocked(searchBrain).mockResolvedValue([]);

    const output = await runBrainToolForUser({
      ...BASE_INPUT,
      toolInput: {
        command: "query",
        flags: { since: "2d", includeNeighbors: false, snippetChars: 150 },
      },
    });

    expect(searchBrain).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "page",
        since: "2d",
        limit: 11,
        offset: 0,
        includeNeighbors: false,
        snippetChars: 150,
      }),
    );
    expect(output.parsed).toEqual({
      hits: [],
      mode: "browse",
      scope: { kind: "page" },
      pagination: {
        limit: 10,
        offset: 0,
        returned: 0,
        hasMore: false,
      },
    });
  });

  it("returns an explicit continuation when more query matches are available", async () => {
    vi.mocked(searchBrain).mockResolvedValue(
      Array.from({ length: 11 }, (_, index) => ({
        ...HIT,
        id: `person-${index + 1}`,
        title: `Person ${index + 1}`,
      })) as never,
    );

    const output = await runBrainToolForUser({
      ...BASE_INPUT,
      toolInput: {
        command: "query",
        flags: { text: "team", offset: 20 },
      },
    });

    expect(searchBrain).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        text: "team",
        kind: "page",
        limit: 11,
        offset: 20,
      }),
    );
    expect(output.parsed).toMatchObject({
      hits: expect.any(Array),
      scope: { kind: "page" },
      pagination: {
        limit: 10,
        offset: 20,
        returned: 10,
        hasMore: true,
        nextOffset: 30,
        instruction: expect.stringContaining("offset set to 30"),
      },
    });
    expect((output.parsed as { hits: unknown[] }).hits).toHaveLength(10);
    expect(output.stdout).toBeUndefined();
  });

  it("serves timeline and list from the read module", async () => {
    vi.mocked(getBrainTimeline).mockResolvedValue({
      id: "ada",
      entries: [
        {
          at: "2026-06-01T00:00:00.000Z",
          evidenceId: "ev-1",
          summary: "Joined.",
          detail: "",
          sourceRef: "jamie:meeting:1",
          sourceTitle: "Kickoff",
        },
      ],
    });
    vi.mocked(listBrainDocuments).mockResolvedValue([
      {
        id: "ada",
        title: "Ada",
        type: "person",
        kind: "page",
        folder: "team/gtm",
        status: "active",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);

    const timeline = await runBrainToolForUser({
      ...BASE_INPUT,
      toolInput: { command: "timeline", flags: { id: "ada", limit: 10 } },
    });
    expect(getBrainTimeline).toHaveBeenCalledWith(expect.anything(), "ada", { limit: 10 });
    expect(timeline.ok).toBe(true);
    expect(timeline.stdout).toBeUndefined();
    expect(timeline.parsed).toMatchObject({
      id: "ada",
      entries: [expect.objectContaining({ sourceRef: "jamie:meeting:1" })],
    });

    const list = await runBrainToolForUser({
      ...BASE_INPUT,
      toolInput: { command: "list", flags: { type: "person", limit: 20 } },
    });
    expect(listBrainDocuments).toHaveBeenCalledWith(expect.anything(), {
      type: "person",
      limit: 20,
    });
    expect(list.ok).toBe(true);
    expect(list.stdout).toBeUndefined();
    expect(list.parsed).toEqual({
      documents: [
        expect.objectContaining({
          id: "ada",
          type: "person",
        }),
      ],
    });
  });

  it("rejects invalid read flags before touching the module", async () => {
    const output = await runBrainToolForUser({
      ...BASE_INPUT,
      toolInput: { command: "query", flags: { text: "x", kind: "wiki" } },
    });
    expect(output.ok).toBe(false);
    expect(output.error).toContain('kind must be "page" or "evidence"');
    expect(searchBrain).not.toHaveBeenCalled();

    const invalidOffset = await runBrainToolForUser({
      ...BASE_INPUT,
      toolInput: { command: "query", flags: { text: "x", offset: -1 } },
    });
    expect(invalidOffset.ok).toBe(false);
    expect(invalidOffset.error).toContain("offset must be a non-negative integer");

    const malformedOffset = await runBrainToolForUser({
      ...BASE_INPUT,
      toolInput: { command: "query", flags: { text: "x", offset: "later" } },
    });
    expect(malformedOffset.ok).toBe(false);
    expect(malformedOffset.error).toContain("offset must be a non-negative integer");
  });
});
