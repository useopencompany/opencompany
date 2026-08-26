import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitHeadlessWikiTransactions } from "./headless-knowledge-collections";
import {
  addHeadlessWikiTimelineEntry,
  approveHeadlessPluginMcp,
  archiveHeadlessPlugin,
  createHeadlessBrainDocument,
  createHeadlessWorkspaceSkill,
  deleteHeadlessPluginData,
  disableHeadlessPlugin,
  disableHeadlessSkill,
  enableHeadlessPlugin,
  enableHeadlessSkill,
  importHeadlessPlugin,
  importHeadlessSkill,
  listHeadlessBrainSourceItems,
  previewHeadlessPluginImport,
  previewHeadlessSkillImport,
  readHeadlessSkillFile,
  replaceHeadlessSkill,
  revokeHeadlessPluginMcp,
  updateHeadlessWorkspaceSkill,
} from "./headless-knowledge-commands";

vi.mock("./headless-knowledge-collections", () => ({
  awaitHeadlessWikiTransactions: vi.fn(async () => undefined),
}));

const meta = { apiVersion: "v1", protocolVersion: "1.0.0" };
const createdAt = "2026-08-12T08:00:00.000Z";
const skillDescription = "Review visual artifacts.";

describe("headless knowledge commands", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates Brain documents through the typed resource with an idempotency key", async () => {
    let upstream: Request | null = null;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      upstream = input instanceof Request ? input : new Request(input, init);
      return Response.json({ data: brainDocument(), meta }, { status: 201 });
    });

    await createHeadlessBrainDocument(
      "brain_alpha",
      { folderPath: "Projects", fileName: "Launch.md" },
      { baseUrl: "https://api.example.test", fetch: fetchMock as typeof fetch },
    );

    const sent = upstream as unknown as Request;
    expect(sent.method).toBe("POST");
    expect(new URL(sent.url).pathname).toBe("/v1/brains/brain_alpha/documents");
    expect(sent.headers.get("idempotency-key")).toMatch(/^web-brain-document:/u);
    await expect(sent.json()).resolves.toEqual({
      folderPath: "Projects",
      fileName: "Launch.md",
    });
  });

  it("reconciles Wiki timeline writes against the fixed timeline projection", async () => {
    let upstream: Request | null = null;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      upstream = input instanceof Request ? input : new Request(input, init);
      return Response.json({
        data: {
          entry: {
            id: "wiki_entry_1",
            pageId: "wiki_page_1",
            at: createdAt,
            text: "Decision recorded.",
            createdAt,
          },
          transactionId: 72,
        },
        meta,
      });
    });

    await addHeadlessWikiTimelineEntry(
      "launch-plan",
      { text: "Decision recorded." },
      {
        baseUrl: "https://api.example.test",
        fetch: fetchMock as typeof fetch,
        scopeKey: "workspace_1",
      },
    );

    const sent = upstream as unknown as Request;
    expect(new URL(sent.url).pathname).toBe("/v1/wiki/pages/launch-plan/timeline");
    expect(sent.headers.get("idempotency-key")).toMatch(/^web-wiki-timeline:/u);
    expect(awaitHeadlessWikiTransactions).toHaveBeenCalledWith([72], {
      scopeKey: "workspace_1",
      target: "timeline",
    });
  });

  it("loads bounded source metadata through the selected Brain resource", async () => {
    let upstream: Request | null = null;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      upstream = input instanceof Request ? input : new Request(input, init);
      return Response.json({ data: [], meta });
    });

    await listHeadlessBrainSourceItems("brain_alpha", ["source_1", "source_2"], {
      baseUrl: "https://api.example.test",
      fetch: fetchMock as typeof fetch,
    });

    const url = new URL((upstream as unknown as Request).url);
    expect(url.pathname).toBe("/v1/brains/brain_alpha/source-items");
    expect(url.searchParams.get("ids")).toBe("source_1,source_2");

    await expect(
      listHeadlessBrainSourceItems(
        "brain_alpha",
        Array.from({ length: 101 }, (_, i) => `s_${i}`),
      ),
    ).rejects.toThrow("limited to 100 ids");
  });

  it("previews and imports external Skills through the typed resources", async () => {
    const requests: Request[] = [];
    const resolvedCommit = "a".repeat(40);
    const integrity = `sha256:${"b".repeat(64)}`;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return new URL(request.url).pathname.endsWith("/preview")
        ? Response.json({
            data: {
              status: "resolved",
              name: "visual-review",
              description: skillDescription,
              source: {
                type: "github",
                url: "https://github.com/o/r",
                ref: "main",
                path: "",
                resolvedCommit,
              },
              integrity,
              files: [{ path: "SKILL.md", sizeBytes: 128 }],
              fileCount: 1,
              totalBytes: 128,
            },
            meta,
          })
        : Response.json(
            { data: { installation: { name: "visual-review" }, replayed: false }, meta },
            { status: 201 },
          );
    });
    const options = { baseUrl: "https://api.example.test", fetch: fetchMock as typeof fetch };

    await previewHeadlessSkillImport({ url: "github.com/o/r" }, options);
    await importHeadlessSkill(
      {
        url: "github.com/o/r",
        expectedResolvedCommit: resolvedCommit,
        expectedIntegrity: integrity,
      },
      options,
    );

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["POST /v1/skills/imports/preview", "POST /v1/skills/imports"],
    );
    expect(requests[1]?.headers.get("idempotency-key")).toMatch(/^web-skill-import:/u);
  });

  it("creates and updates workspace-authored Skills through standard Skill resources", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return Response.json(
        {
          data:
            request.method === "POST"
              ? { installation: { name: "investigate-bug" }, replayed: false }
              : { name: "investigate-bug" },
          meta,
        },
        { status: request.method === "POST" ? 201 : 200 },
      );
    });
    const options = { baseUrl: "https://api.example.test", fetch: fetchMock as typeof fetch };

    await createHeadlessWorkspaceSkill(
      {
        name: "investigate-bug",
        description: "Reproduce and diagnose reported bugs.",
        instructions: "Reproduce the issue first.",
      },
      options,
    );
    await updateHeadlessWorkspaceSkill(
      "investigate-bug",
      {
        description: "Reproduce and diagnose reported bugs.",
        instructions: "Reproduce the issue, then identify the root cause.",
      },
      options,
    );

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["POST /v1/skills", "PATCH /v1/skills/investigate-bug"],
    );
    expect(requests[0]?.headers.get("idempotency-key")).toMatch(/^web-workspace-skill:/u);
  });

  it("uses installation actions and bounded file reads", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return Response.json({ data: {}, meta });
    });
    const options = { baseUrl: "https://api.example.test", fetch: fetchMock as typeof fetch };
    const command = {
      url: "github.com/o/r",
      expectedResolvedCommit: "a".repeat(40),
      expectedIntegrity: `sha256:${"b".repeat(64)}`,
    };

    await enableHeadlessSkill("visual-review", options);
    await disableHeadlessSkill("visual-review", options);
    await replaceHeadlessSkill("visual-review", command, options);
    await readHeadlessSkillFile(
      "visual-review",
      { path: "references/guide.md", offset: 12, maxBytes: 64 },
      options,
    );

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        "POST /v1/skills/visual-review/enable",
        "POST /v1/skills/visual-review/disable",
        "POST /v1/skills/visual-review/replace",
        "GET /v1/skills/visual-review/files/read",
      ],
    );
    const fileUrl = new URL(requests[3]!.url);
    expect(fileUrl.searchParams.get("path")).toBe("references/guide.md");
    expect(fileUrl.searchParams.get("offset")).toBe("12");
    expect(fileUrl.searchParams.get("maxBytes")).toBe("64");
  });

  it("uses the typed Plugin preview, install, lifecycle, and data deletion resources", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return Response.json({ data: {}, meta }, { status: request.method === "POST" ? 201 : 200 });
    });
    const options = { baseUrl: "https://api.example.test", fetch: fetchMock as typeof fetch };
    const command = {
      url: "github.com/example/plugins",
      expectedResolvedCommit: "a".repeat(40),
      expectedIntegrity: `sha256:${"b".repeat(64)}`,
    };

    await previewHeadlessPluginImport({ url: command.url }, options);
    await importHeadlessPlugin(command, options);
    await enableHeadlessPlugin("quality-tools", options);
    await disableHeadlessPlugin("quality-tools", options);
    await approveHeadlessPluginMcp("quality-tools", command.expectedIntegrity, options);
    await revokeHeadlessPluginMcp("quality-tools", options);
    await deleteHeadlessPluginData("quality-tools", options);
    await archiveHeadlessPlugin("quality-tools", options);

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        "POST /v1/plugins/imports/preview",
        "POST /v1/plugins/imports",
        "POST /v1/plugins/quality-tools/enable",
        "POST /v1/plugins/quality-tools/disable",
        "POST /v1/plugins/quality-tools/mcp/approve",
        "POST /v1/plugins/quality-tools/mcp/revoke",
        "POST /v1/plugins/quality-tools/data/delete",
        "POST /v1/plugins/quality-tools/archive",
      ],
    );
    expect(requests[1]?.headers.get("idempotency-key")).toMatch(/^web-plugin-import:/u);
  });

  it("surfaces canonical errors with the request id", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "conflict",
            message: "The Skill is imported and immutable.",
            requestId: "request_1",
            retryable: false,
          },
          meta,
        },
        { status: 409 },
      ),
    );

    await expect(
      disableHeadlessSkill("visual-review", {
        baseUrl: "https://api.example.test",
        fetch: fetchMock as typeof fetch,
      }),
    ).rejects.toThrow("The Skill is imported and immutable. (request request_1)");
  });
});

function brainDocument() {
  return {
    id: "brain_document_1",
    brainId: "brain_alpha",
    folderPath: "Projects",
    path: "Projects/Launch.md",
    title: "Launch",
    content: "",
    body: "",
    timeline: [],
    format: "markdown",
    mimeType: "text/markdown",
    originalFileName: null,
    assetSizeBytes: null,
    relations: [],
    sources: [],
    kind: "page",
    type: "note",
    status: "active",
    aliases: [],
    contentHash: "a".repeat(64),
    sizeBytes: 0,
    createdByActorId: "actor_1",
    createdAt,
    updatedAt: createdAt,
  };
}
