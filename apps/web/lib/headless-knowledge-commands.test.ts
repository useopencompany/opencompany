import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitHeadlessWikiTransactions } from "./headless-knowledge-collections";
import {
  addHeadlessWikiTimelineEntry,
  createHeadlessBrainDocument,
  createHeadlessSkill,
  listHeadlessBrainSourceItems,
  updateHeadlessSkill,
} from "./headless-knowledge-commands";

vi.mock("./headless-knowledge-collections", () => ({
  awaitHeadlessWikiTransactions: vi.fn(async () => undefined),
}));

const meta = { apiVersion: "v1", protocolVersion: "1.0.0" };
const createdAt = "2026-08-12T08:00:00.000Z";
const skill = {
  id: "skill_1",
  slug: "visual-review",
  name: "Visual Review",
  description: "Review visual artifacts.",
  instructions: "Inspect the rendered output.",
  status: "active",
  source: null,
  createdAt,
  updatedAt: createdAt,
} as const;

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

  it("uses canonical Skill create and update resources", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init));
      return Response.json({ data: skill, meta });
    });
    const options = { baseUrl: "https://api.example.test", fetch: fetchMock as typeof fetch };

    await createHeadlessSkill({ name: "Visual Review", description: skill.description }, options);
    await updateHeadlessSkill(
      skill.slug,
      {
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        status: skill.status,
      },
      options,
    );

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["POST /v1/skills", "PATCH /v1/skills/visual-review"],
    );
    expect(requests[0]?.headers.get("idempotency-key")).toMatch(/^web-skill:/u);
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
      updateHeadlessSkill(
        skill.slug,
        {
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
          status: skill.status,
        },
        { baseUrl: "https://api.example.test", fetch: fetchMock as typeof fetch },
      ),
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
