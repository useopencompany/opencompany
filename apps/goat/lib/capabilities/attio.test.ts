import type { LanguageModelUsage, ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbRows: [] as unknown[],
  loadCredential: vi.fn(),
  markStatus: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => mocks.dbRows }),
        }),
      }),
    }),
  }),
}));
vi.mock("@opencompany/db/goat-integrations", () => ({
  loadGoatIntegrationCredential: mocks.loadCredential,
  markGoatIntegrationStatus: mocks.markStatus,
}));
vi.mock("@/lib/integrations/attio", () => ({
  GOAT_ATTIO_API_BASE_URL: "https://api.attio.test/v2",
}));

import { attioCapability, compactAttioNote, compactAttioRecord } from "@/lib/capabilities/attio";
import {
  GoatCapabilityAuthError,
  type GoatCapabilityOperation,
  type GoatCapabilityWorkerContext,
  type ResolvedGoatCapability,
} from "@/lib/capabilities/types";
import { runGoatCapabilityWorker } from "@/lib/capabilities/worker";

const CONTEXT: GoatCapabilityWorkerContext = {
  userWorkosId: "user_1",
  signal: new AbortController().signal,
  currentDate: new Date("2026-07-21T12:00:00.000Z"),
  userContext: {
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    timezone: "Europe/London",
  },
};
const WRITE_SCOPES = [
  "object_configuration:read",
  "record_permission:read-write",
  "note:read-write",
];

beforeEach(() => {
  mocks.dbRows = [connectedRow(WRITE_SCOPES)];
  mocks.loadCredential.mockReset();
  mocks.loadCredential.mockResolvedValue({
    payload: {
      apiKey: "attio_secret_key",
      workspaceId: "workspace_1",
      webhookId: null,
      webhookSecret: null,
      objectIdBySlug: {
        person: "object_people",
        company: "object_companies",
        deal: "object_deals",
      },
      createdAt: "2026-07-21T00:00:00.000Z",
    },
  });
  mocks.markStatus.mockReset();
  mocks.markStatus.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("attio capability resolution and tools", () => {
  it("revalidates legacy unknown-scope connections before deciding create access", async () => {
    mocks.dbRows = [connectedRow([])];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          active: true,
          workspace_id: "workspace_1",
          scope:
            "object_configuration:read-write record_permission:read-write note:read-write list_configuration:read-write list_entry:read-write",
        }),
      ),
    );
    const resolved = await attioCapability.resolve("user_1");
    expect(resolved?.operations).toEqual(["read", "create"]);
    expect(resolved?.indexLine).toContain("CAN create");
  });

  it("keeps legacy connections read-only when live scope validation fails", async () => {
    mocks.dbRows = [connectedRow([])];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    const resolved = await attioCapability.resolve("user_1");
    expect(resolved?.operations).toEqual(["read"]);
    expect(resolved?.indexLine).toContain("resaved with read-write scopes");
  });

  it("isolates credential loading to the connected user and integration", async () => {
    const resolved = await attioCapability.resolve("user_1");
    await resolved?.createTools(CONTEXT, "read");
    expect(mocks.loadCredential).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      integrationId: "gint_attio",
      provider: "attio",
      kind: "api_key",
    });
  });

  it("gives read workers no creation tools and scope-gates create workers", async () => {
    const read = await createResolvedTools("read");
    expect(Object.keys(read)).toEqual([
      "attio_search_records",
      "attio_list_records",
      "attio_list_lists",
      "attio_list_entries",
      "attio_get_record",
      "attio_list_notes",
      "attio_get_note",
    ]);

    mocks.dbRows = [
      connectedRow(["object_configuration:read", "record_permission:read", "note:read-write"]),
    ];
    const noteCreate = await createResolvedTools("create");
    expect(Object.keys(noteCreate)).toContain("attio_create_note");
    expect(Object.keys(noteCreate)).not.toContain("attio_create_person");

    mocks.dbRows = [connectedRow(["object_configuration:read", "record_permission:read-write"])];
    const recordCreate = await createResolvedTools("create");
    expect(Object.keys(recordCreate)).toEqual(
      expect.arrayContaining(["attio_create_person", "attio_create_company", "attio_create_deal"]),
    );
    expect(Object.keys(recordCreate)).not.toContain("attio_create_note");
  });

  it("sends bounded search input and compacts provider records into entity envelopes", async () => {
    const fetchMock = vi.fn(async (...request: [RequestInfo | URL, RequestInit?]) => {
      void request;
      return jsonResponse({
        data: [
          {
            id: { object_id: "object_people", record_id: "rec_ada" },
            web_url: "https://app.attio.com/acme/people/rec_ada",
            values: {
              name: [{ attribute_type: "personal-name", full_name: "Ada Lovelace" }],
              description: [{ value: "x".repeat(800) }],
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tools = await createResolvedTools("read");
    const result = await executeTool(tools, "attio_search_records", {
      query: " Ada ",
      objects: ["people"],
      limit: 999,
    });

    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe("https://api.attio.test/v2/objects/records/search");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      query: "Ada",
      objects: ["people"],
      request_as: { type: "workspace" },
      limit: 25,
    });
    expect(JSON.stringify(result)).not.toContain("attio_secret_key");
    expect(result).toMatchObject({
      records: [
        {
          id: "rec_ada",
          object: "people",
          title: "Ada Lovelace",
          entity: {
            type: "attio_record",
            id: "people:rec_ada",
            url: "https://app.attio.com/acme/people/rec_ada",
          },
        },
      ],
    });
    const description = (result as { records: Array<{ properties: Record<string, string> }> })
      .records[0]?.properties.description;
    expect(description?.length).toBe(500);
  });

  it("filters search to objects enabled in the connected Attio workspace", async () => {
    mocks.loadCredential.mockResolvedValueOnce({
      payload: {
        apiKey: "attio_secret_key",
        objectIdBySlug: {
          person: "object_people",
          company: "object_companies",
        },
      },
    });
    const fetchMock = vi.fn(async (...request: [RequestInfo | URL, RequestInit?]) => {
      void request;
      return jsonResponse({ data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tools = await createResolvedTools("read");

    await executeTool(tools, "attio_search_records", {
      query: "Partner",
      objects: ["people", "companies", "deals"],
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      objects: ["people", "companies"],
      request_as: { type: "workspace" },
    });
    await expect(
      executeTool(tools, "attio_get_record", { object: "deals", recordId: "deal_1" }),
    ).rejects.toThrow("deals object is not enabled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("compacts Attio's beta search result shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            {
              id: { object_id: "object_people", record_id: "person_1" },
              object_slug: "people",
              record_text: "Bela Wiertz",
              email_addresses: ["bela@example.com"],
              phone_numbers: ["+4912345"],
            },
          ],
        }),
      ),
    );

    await expect(
      executeTool(await createResolvedTools("read"), "attio_search_records", {
        query: "Bela",
        objects: ["people"],
      }),
    ).resolves.toMatchObject({
      records: [
        {
          id: "person_1",
          object: "people",
          title: "Bela Wiertz",
          properties: {
            email_addresses: "bela@example.com",
            phone_numbers: "+4912345",
          },
        },
      ],
    });
  });

  it("lists records not interacted with since a cutoff and preserves interaction timestamps", async () => {
    const fetchMock = vi.fn(async (...request: [RequestInfo | URL, RequestInit?]) => {
      void request;
      return jsonResponse({
        data: [
          {
            id: { object_id: "object_people", record_id: "person_1" },
            values: {
              name: [{ attribute_type: "personal-name", full_name: "Ada Lovelace" }],
              last_interaction: [
                {
                  attribute_type: "interaction",
                  interaction_type: "email",
                  interacted_at: "2026-07-10T09:00:00.000Z",
                  active_until: null,
                },
              ],
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool(await createResolvedTools("read"), "attio_list_records", {
      object: "people",
      notInteractedSince: "2026-07-16T12:00:00Z",
      limit: 5,
      offset: 2,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.attio.test/v2/objects/people/records/query",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      filter: {
        $not: {
          last_interaction: { interacted_at: { $gte: "2026-07-16T12:00:00.000Z" } },
        },
      },
      sorts: [{ direction: "desc", attribute: "last_interaction", field: "interacted_at" }],
      limit: 5,
      offset: 2,
    });
    expect(result).toMatchObject({
      records: [
        {
          title: "Ada Lovelace",
          properties: { last_interaction: "2026-07-10T09:00:00.000Z (email)" },
        },
      ],
      nextOffset: 7,
    });
  });

  it("lists Attio lists and enriches list entries with their parent records", async () => {
    const list = {
      id: { list_id: "list_1" },
      api_slug: "leads",
      name: "YT Partnerships",
      parent_object: ["companies"],
    };
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/lists")) return jsonResponse({ data: [list] });
      if (value.endsWith("/lists/leads")) return jsonResponse({ data: list });
      if (value.endsWith("/lists/leads/entries/query")) {
        return jsonResponse({
          data: [
            {
              id: { entry_id: "entry_1" },
              parent_object: "companies",
              parent_record_id: "company_1",
              entry_values: {},
            },
          ],
        });
      }
      expect(value).toContain("/objects/companies/records/query");
      expect(JSON.parse(String(init?.body))).toEqual({
        filter: { record_id: { $in: ["company_1"] } },
        limit: 1,
        offset: 0,
      });
      return jsonResponse({
        data: [
          {
            id: { object_id: "object_companies", record_id: "company_1" },
            values: { name: [{ attribute_type: "text", value: "Acme" }] },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tools = await createResolvedTools("read");

    await expect(executeTool(tools, "attio_list_lists", {})).resolves.toMatchObject({
      lists: [{ apiSlug: "leads", name: "YT Partnerships", parentObject: "companies" }],
    });
    await expect(
      executeTool(tools, "attio_list_entries", { list: "leads", limit: 10 }),
    ).resolves.toMatchObject({
      list: { apiSlug: "leads", name: "YT Partnerships" },
      entries: [{ id: "entry_1", record: { id: "company_1", title: "Acme" } }],
    });
  });

  it("builds typed person, company, deal, and markdown-note request bodies", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const data =
        bodies.length === 4
          ? { id: { note_id: "note_1" }, title: "Call notes" }
          : { id: { record_id: "record_" + bodies.length }, values: {} };
      return jsonResponse({ data });
    });
    vi.stubGlobal("fetch", fetchMock);

    await executeTool(await createResolvedTools("create"), "attio_create_person", {
      fullName: "Ada Lovelace",
      email: "ada@example.com",
      jobTitle: "CTO",
      description: "Technical buyer",
      companyRecordId: "company_1",
    });
    await executeTool(await createResolvedTools("create"), "attio_create_company", {
      name: "Analytical Engines",
      domain: "analytical.example",
      description: "Computing",
    });
    await executeTool(await createResolvedTools("create"), "attio_create_deal", {
      name: "Enterprise",
      stage: "Qualified",
      value: 120000,
      companyRecordId: "company_1",
      personRecordIds: ["person_1"],
    });
    await executeTool(await createResolvedTools("create"), "attio_create_note", {
      object: "people",
      recordId: "person_1",
      title: "Call notes",
      content: "## Next step\nSend proposal.",
    });

    expect(bodies).toEqual([
      {
        data: {
          values: {
            name: "Ada Lovelace",
            email_addresses: ["ada@example.com"],
            job_title: "CTO",
            description: "Technical buyer",
            company: {
              target_object: "companies",
              target_record_id: "company_1",
            },
          },
        },
      },
      {
        data: {
          values: {
            name: "Analytical Engines",
            domains: ["analytical.example"],
            description: "Computing",
          },
        },
      },
      {
        data: {
          values: {
            name: "Enterprise",
            stage: "Qualified",
            owner: "ada@example.com",
            value: 120000,
            associated_company: {
              target_object: "companies",
              target_record_id: "company_1",
            },
            associated_people: [{ target_object: "people", target_record_id: "person_1" }],
          },
        },
      },
      {
        data: {
          parent_object: "people",
          parent_record_id: "person_1",
          title: "Call notes",
          format: "markdown",
          content: "## Next step\nSend proposal.",
        },
      },
    ]);
  });

  it("allows one successful mutation, deduplicates its exact retry, and blocks another", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: { id: { record_id: "rec_1" }, values: {} } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tools = await createResolvedTools("create");
    const first = await executeTool(tools, "attio_create_person", { fullName: "Ada" });
    const retry = await executeTool(tools, "attio_create_person", { fullName: "Ada" });
    expect(retry).toEqual(first);
    await expect(
      executeTool(tools, "attio_create_company", { name: "Different creation" }),
    ).rejects.toThrow("already completed one Attio creation");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks only 401 responses for reauthorization and guides missing-scope 403s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(
      executeTool(await createResolvedTools("read"), "attio_get_record", {
        object: "people",
        recordId: "rec_1",
      }),
    ).rejects.toBeInstanceOf(GoatCapabilityAuthError);
    expect(mocks.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "needs_reauth", integrationId: "gint_attio" }),
    );

    mocks.markStatus.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    await expect(
      executeTool(await createResolvedTools("read"), "attio_get_record", {
        object: "people",
        recordId: "rec_1",
      }),
    ).rejects.toThrow("missing a required scope");
    expect(mocks.markStatus).not.toHaveBeenCalled();
  });

  it("propagates chat aborts and bounds note content", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tools = await createResolvedTools("read", { ...CONTEXT, signal: controller.signal });
    const pending = executeTool(tools, "attio_get_note", { noteId: "note_1" });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const compact = compactAttioNote({
      id: { note_id: "note_1" },
      content_plaintext: "x".repeat(10_000),
    });
    expect(compact.content?.length).toBe(8_000);
  });

  it("returns safe provider errors without leaking response bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("private provider detail", { status: 500 })),
    );
    await expect(
      executeTool(await createResolvedTools("read"), "attio_get_record", {
        object: "people",
        recordId: "rec_1",
      }),
    ).rejects.toThrow("rejected this request (500)");
  });

  it("surfaces bounded provider timeouts without exposing credentials", async () => {
    const timeout = new Error("provider implementation detail");
    timeout.name = "TimeoutError";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw timeout;
      }),
    );
    await expect(
      executeTool(await createResolvedTools("read"), "attio_get_record", {
        object: "people",
        recordId: "rec_1",
      }),
    ).rejects.toThrow("The Attio request timed out.");
  });
});

describe("Attio worker integration", () => {
  it("drives search then record retrieval through the real worker toolkit", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            data: [
              {
                id: { object_id: "object_people", record_id: "rec_ada" },
                values: {
                  name: [{ attribute_type: "personal-name", full_name: "Ada Lovelace" }],
                },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: {
              id: { record_id: "rec_ada" },
              web_url: "https://app.attio.com/acme/people/rec_ada",
              values: {
                name: [{ attribute_type: "personal-name", full_name: "Ada Lovelace" }],
              },
            },
          }),
        ),
    );
    const result = await runIntegrationWorker(
      "read",
      async (tools) => {
        await executeTool(tools, "attio_search_records", {
          query: "Ada",
          objects: ["people"],
        });
        await executeTool(tools, "attio_get_record", {
          object: "people",
          recordId: "rec_ada",
        });
        return "Ada Lovelace is the matching person.";
      },
      {
        summary: "Ada Lovelace is the matching person.",
        entities: [
          {
            type: "attio_record",
            id: "people:rec_ada",
            url: "https://app.attio.com/acme/people/rec_ada",
            title: "Ada Lovelace",
          },
        ],
      },
    );
    expect(result.envelope.entities[0]?.id).toBe("people:rec_ada");
  });

  it("creates a person and returns its record entity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: {
            id: { record_id: "rec_new" },
            web_url: "https://app.attio.com/acme/people/rec_new",
            values: { name: [{ attribute_type: "personal-name", full_name: "Grace Hopper" }] },
          },
        }),
      ),
    );
    const result = await runIntegrationWorker(
      "create",
      async (tools) => {
        expect(Object.keys(tools)).toContain("attio_create_person");
        await executeTool(tools, "attio_create_person", {
          fullName: "Grace Hopper",
          email: "grace@example.com",
        });
        return "Created Grace Hopper.";
      },
      {
        summary: "Created Grace Hopper.",
        entities: [
          {
            type: "attio_record",
            id: "people:rec_new",
            url: "https://app.attio.com/acme/people/rec_new",
            title: "Grace Hopper",
          },
        ],
      },
    );
    expect(result.debug.operation).toBe("create");
    expect(result.envelope.entities[0]?.url).toContain("rec_new");
  });

  it("looks up a record before creating one note", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            data: {
              id: { record_id: "deal_1" },
              values: { name: [{ value: "Enterprise" }] },
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: {
              id: { note_id: "note_new" },
              title: "Next steps",
              web_url: "https://app.attio.com/acme/notes/note_new",
            },
          }),
        ),
    );
    const result = await runIntegrationWorker(
      "create",
      async (tools) => {
        await executeTool(tools, "attio_get_record", {
          object: "deals",
          recordId: "deal_1",
        });
        await executeTool(tools, "attio_create_note", {
          object: "deals",
          recordId: "deal_1",
          title: "Next steps",
          content: "Send the proposal.",
        });
        return "Created the note.";
      },
      {
        summary: "Created the note.",
        entities: [
          {
            type: "attio_note",
            id: "note_new",
            url: "https://app.attio.com/acme/notes/note_new",
            title: "Next steps",
          },
        ],
      },
    );
    expect(result.envelope.entities[0]?.id).toBe("note_new");
  });

  it("exposes no creation tools to a read worker", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await runIntegrationWorker(
      "read",
      async (tools) => {
        expect(Object.keys(tools).some((name) => name.startsWith("attio_create_"))).toBe(false);
        return "No lookup needed.";
      },
      {
        summary: "No lookup needed.",
        entities: [],
      },
    );
  });
});

function connectedRow(scopes: string[]) {
  return {
    id: "gint_attio",
    status: "connected",
    connectionLabel: "Acme",
    scopes,
  };
}

async function createResolvedTools(
  operation: GoatCapabilityOperation,
  context: GoatCapabilityWorkerContext = CONTEXT,
) {
  const resolved = await attioCapability.resolve(context.userWorkosId);
  if (!resolved) throw new Error("Expected Attio to resolve.");
  return (await resolved.createTools(context, operation)).tools;
}

async function executeTool(tools: ToolSet, name: string, args: unknown): Promise<unknown> {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error("Missing tool " + name + ".");
  return await execute(args as never, { toolCallId: "tool_1", messages: [] } as never);
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function usage(): LanguageModelUsage {
  return {
    inputTokens: 1,
    inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: 1,
    outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
    totalTokens: 2,
  };
}

async function runIntegrationWorker(
  operation: GoatCapabilityOperation,
  decide: (tools: ToolSet) => Promise<string>,
  envelope: { summary: string; entities: Array<Record<string, string>> },
) {
  const resolved = await attioCapability.resolve("user_1");
  if (!resolved) throw new Error("Expected Attio to resolve.");
  const capability: ResolvedGoatCapability = {
    id: "attio",
    workerModel: "openai/gpt-5.4-mini",
    ...resolved,
  };
  return await runGoatCapabilityWorker({
    capability,
    operation,
    request: operation === "create" ? "Explicitly create the requested Attio item." : "Find Ada.",
    context: CONTEXT,
    gatewayApiKey: "gateway_test",
    attribution: { user: "goat-test", tags: ["app:goat"] },
    generateTextImpl: (async (options: unknown) => {
      const typed = options as {
        tools: ToolSet;
        system: string;
        onStepFinish?: (step: { usage: LanguageModelUsage }) => void;
      };
      if (operation === "create") expect(typed.system).toContain("focused create worker");
      else expect(typed.system).toContain("All tools are read-only");
      const text = await decide(typed.tools);
      typed.onStepFinish?.({ usage: usage() });
      return { text, finishReason: "stop", steps: [] };
    }) as never,
    generateObjectImpl: (async () => ({
      object: { ...envelope, error: null },
      usage: usage(),
    })) as never,
  });
}

describe("compaction helpers", () => {
  it("drops unsafe urls and preserves stable ids", () => {
    const record = compactAttioRecord({
      id: { record_id: "rec_1" },
      web_url: "javascript:alert(1)",
      values: { name: [{ value: "Acme" }] },
    });
    expect(record.entity).toEqual({
      type: "attio_record",
      id: "people:rec_1",
      title: "Acme",
    });
  });
});
