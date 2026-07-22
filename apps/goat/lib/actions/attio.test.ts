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
          orderBy: async () => mocks.dbRows,
        }),
      }),
    }),
  }),
}));
vi.mock("@opencompany/db/goat-integrations", () => ({
  loadGoatIntegrationCredential: mocks.loadCredential,
  markGoatIntegrationStatus: mocks.markStatus,
}));

import { resolveAttioActions } from "@/lib/actions/attio";
import {
  GoatActionAuthError,
  type GoatActionExecuteContext,
  GoatActionInvalidParamsError,
} from "@/lib/actions/types";

const CONTEXT: GoatActionExecuteContext = {
  userWorkosId: "user_1",
  signal: new AbortController().signal,
  currentDate: new Date("2026-07-22T00:00:00.000Z"),
  userTimezone: "UTC",
};

const READ_SCOPES = ["object_configuration:read", "record_permission:read"];
const LIST_READ_SCOPES = ["list_configuration:read", "list_entry:read"];
const LIST_ID = "33ebdbe9-e529-47c9-b894-0ba25e9c15c0";
const VIEW_ID = "cf7aaeb5-7507-4a84-9c26-9d36e34d7b70";
const LIST_URL = `https://app.attio.com/acme/collection/${LIST_ID}/view/${VIEW_ID}`;

beforeEach(() => {
  mocks.dbRows = [connectedRow()];
  mocks.loadCredential.mockReset();
  mocks.loadCredential.mockResolvedValue(credential());
  mocks.markStatus.mockReset();
  mocks.markStatus.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveAttioActions", () => {
  it("is absent without a connected, readable Attio workspace", async () => {
    mocks.dbRows = [];
    expect(await resolveAttioActions("user_1")).toBeNull();

    mocks.dbRows = [connectedRow({ status: "disconnected" })];
    expect(await resolveAttioActions("user_1")).toBeNull();

    mocks.dbRows = [connectedRow({ scopes: ["webhook:read-write"] })];
    expect(await resolveAttioActions("user_1")).toBeNull();
  });

  it("exposes strict read-only record search and detail descriptors", async () => {
    const catalog = await resolveAttioActions("user_1");
    expect(catalog).toMatchObject({
      id: "attio",
      label: "Attio (Acme)",
      actions: [
        {
          id: "attio.search_records",
          provider: "attio",
          params: {
            type: "object",
            additionalProperties: false,
            required: ["query"],
          },
        },
        {
          id: "attio.get_record",
          provider: "attio",
          params: {
            type: "object",
            additionalProperties: false,
            required: ["object", "record_id"],
          },
        },
      ],
    });
    const schema = catalog?.actions[0]?.params;
    expect(schema?.properties).toMatchObject({
      query: { type: "string", minLength: 1, maxLength: 256 },
      objects: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
        items: { enum: ["people", "companies", "deals"] },
      },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    });
    expect(schema?.properties).not.toHaveProperty("account");
    expect(catalog?.actions.every((action) => !/create|update|delete|write/.test(action.id))).toBe(
      true,
    );
    expect(catalog?.actions).not.toContainEqual(
      expect.objectContaining({ id: "attio.query_list" }),
    );
    expect(mocks.loadCredential).not.toHaveBeenCalled();
  });

  it("only exposes list reads when the key has both list read scopes", async () => {
    mocks.dbRows = [connectedRow({ scopes: [...READ_SCOPES, ...LIST_READ_SCOPES] })];

    const catalog = await resolveAttioActions("user_1");
    const action = catalog?.actions.find((entry) => entry.id === "attio.query_list");

    expect(action).toMatchObject({
      id: "attio.query_list",
      provider: "attio",
      params: {
        type: "object",
        additionalProperties: false,
        required: ["list"],
        properties: {
          list: { type: "string", maxLength: 2000 },
          view: { type: "string", maxLength: 2000 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
          offset: { type: "integer", minimum: 0, maximum: 10000 },
        },
      },
    });
    expect(catalog?.description).toContain("read lists");
    expect(mocks.loadCredential).not.toHaveBeenCalled();
  });
});

describe("attio.search_records", () => {
  it("searches available standard objects and returns compact, bounded records", async () => {
    const providerRecords = [
      {
        id: { object_id: "object_people", record_id: "person_1" },
        object_slug: "people",
        record_text: "Ada Lovelace",
        email_addresses: ["ada@example.com"],
        phone_numbers: ["+44 123"],
        web_url: "https://app.attio.com/acme/person/person_1",
        created_at: "2026-07-01T00:00:00.000Z",
        values: {
          name: [{ attribute_type: "personal-name", full_name: "Ada Lovelace" }],
          description: [{ attribute_type: "text", value: "x".repeat(500) }],
          unsafe_reference: [
            { attribute_type: "record-reference", target_record_id: "private_record_id" },
          ],
          one: [{ value: "1" }],
          two: [{ value: "2" }],
          three: [{ value: "3" }],
          four: [{ value: "4" }],
          five: [{ value: "5" }],
          six: [{ value: "6" }],
          seven: [{ value: "7" }],
          eight: [{ value: "8" }],
          nine: [{ value: "9" }],
        },
      },
      {
        id: { object_id: "object_companies", record_id: "company_0" },
        object_slug: "companies",
        web_url: "javascript:alert(1)",
        values: { name: [{ value: "Company 0" }] },
      },
      {
        id: { object_id: "custom_object", record_id: "custom_1" },
        object_slug: "custom_records",
        values: { name: [{ value: "Must be dropped" }] },
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: { object_id: "object_companies", record_id: `company_${index + 1}` },
        object_slug: "companies",
        values: { name: [{ value: `Company ${index + 1}` }] },
      })),
    ];
    const fetchMock = vi.fn(async (...request: [RequestInfo | URL, RequestInit?]) => {
      void request;
      return jsonResponse({ data: providerRecords });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = (await findSearchAction().then((action) =>
      action.execute({ query: "  Ada  ", objects: ["people", "companies"], limit: 2 }, CONTEXT),
    )) as {
      workspace: string;
      records: Array<{
        id: string;
        title: string;
        url?: string;
        properties: Record<string, string>;
      }>;
    };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.attio.com/v2/objects/records/search");
    expect(init).toMatchObject({
      method: "POST",
      signal: CONTEXT.signal,
      headers: expect.objectContaining({ Authorization: "Bearer attio_test_api_key" }),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "Ada",
      objects: ["people", "companies"],
      request_as: { type: "workspace" },
      limit: 2,
    });
    expect(result.workspace).toBe("Acme");
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      id: "person_1",
      title: "Ada Lovelace",
      url: "https://app.attio.com/acme/person/person_1",
      properties: {
        name: "Ada Lovelace",
        email_addresses: "ada@example.com",
        phone_numbers: "+44 123",
      },
    });
    expect(result.records[0]?.properties.description).toHaveLength(200);
    expect(result.records[0]?.properties).not.toHaveProperty("unsafe_reference");
    expect(Object.keys(result.records[0]?.properties ?? {})).toHaveLength(8);
    expect(result.records[1]).not.toHaveProperty("url");
    expect(JSON.stringify(result)).not.toContain("attio_test_api_key");
    expect(JSON.stringify(result)).not.toContain("private_record_id");
  });

  it("validates required, unknown, malformed, and unavailable parameters before the API call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const action = await findSearchAction();

    await expect(action.execute({}, CONTEXT)).rejects.toThrow('"query" is required');
    await expect(action.execute({ query: "x".repeat(257) }, CONTEXT)).rejects.toThrow(
      '"query" must be at most 256',
    );
    await expect(action.execute({ query: "Ada", limit: 0 }, CONTEXT)).rejects.toThrow(
      '"limit" must be an integer from 1 to 10',
    );
    await expect(
      action.execute({ query: "Ada", objects: ["contacts"] }, CONTEXT),
    ).rejects.toBeInstanceOf(GoatActionInvalidParamsError);
    await expect(
      action.execute({ query: "Ada", objects: ["people", "people"] }, CONTEXT),
    ).rejects.toThrow('"objects" must not contain duplicates');
    await expect(action.execute({ query: "Ada", objects: ["deals"] }, CONTEXT)).rejects.toThrow(
      "deals object is not available",
    );
    await expect(action.execute({ query: "Ada", mutate: true }, CONTEXT)).rejects.toThrow(
      'Unknown parameter: "mutate"',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps missing and rejected API keys to reconnectable authentication errors", async () => {
    mocks.loadCredential.mockResolvedValueOnce(null);
    await expect(
      findSearchAction().then((action) => action.execute({ query: "Ada" }, CONTEXT)),
    ).rejects.toMatchObject({
      name: "GoatActionAuthError",
      code: "auth_expired",
      provider: "attio",
      message: expect.stringContaining("reconnect Attio in Settings → Integrations"),
    });

    mocks.loadCredential.mockResolvedValueOnce(credential());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(
      findSearchAction().then((action) => action.execute({ query: "Ada" }, CONTEXT)),
    ).rejects.toBeInstanceOf(GoatActionAuthError);
    expect(mocks.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: "gint_attio_1",
        provider: "attio",
        status: "needs_reauth",
      }),
    );
  });

  it("returns safe provider errors without exposing response bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("private provider payload", { status: 500 })),
    );
    const error = await findSearchAction()
      .then((action) => action.execute({ query: "Ada" }, CONTEXT))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Attio API request failed (500).");
    expect((error as Error).message).not.toContain("private provider payload");
  });

  it("requires an explicit account when multiple Attio workspaces are connected", async () => {
    mocks.dbRows = [
      connectedRow({
        integrationId: "gint_attio_1",
        workspaceId: "workspace_1",
        workspaceName: "Acme",
      }),
      connectedRow({
        integrationId: "gint_attio_2",
        workspaceId: "workspace_2",
        workspaceName: "Acme",
      }),
    ];
    mocks.loadCredential.mockImplementation(async (input: { integrationId: string }) =>
      credential(input.integrationId === "gint_attio_1" ? "workspace_1" : "workspace_2"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [] })),
    );

    const catalog = await resolveAttioActions("user_1");
    const action = catalog?.actions[0];
    if (!action) throw new Error("missing attio.search_records");
    expect(action.params.required).toEqual(["query", "account"]);
    expect(action.params.properties?.account).toMatchObject({
      enum: ["Acme (workspace_1)", "Acme (workspace_2)"],
    });
    await expect(action.execute({ query: "Ada" }, CONTEXT)).rejects.toThrow(
      '"account" is required',
    );
    await expect(action.execute({ query: "Ada", account: "missing" }, CONTEXT)).rejects.toThrow(
      "No connected Attio workspace matches",
    );

    await action.execute({ query: "Ada", account: "Acme (workspace_2)" }, CONTEXT);
    expect(mocks.loadCredential).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "gint_attio_2" }),
    );
  });

  it("passes through the shared abort signal", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: RequestInfo | URL, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            if (init?.signal?.aborted) {
              reject(init.signal.reason);
              return;
            }
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const action = await findSearchAction();
    const pending = action.execute({ query: "Ada" }, { ...CONTEXT, signal: controller.signal });
    controller.abort(new Error("chat stopped"));
    await expect(pending).rejects.toThrow("chat stopped");
  });
});

describe("attio.query_list", () => {
  beforeEach(() => {
    mocks.dbRows = [connectedRow({ scopes: [...READ_SCOPES, ...LIST_READ_SCOPES] })];
  });

  it("applies a saved view from a collection URL and hydrates parent records in a batch", async () => {
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url === `https://api.attio.com/v2/lists/${LIST_ID}`) {
        return jsonResponse({
          data: {
            id: { list_id: LIST_ID },
            api_slug: "fundraising",
            name: "Fundraising",
            parent_object: ["companies"],
          },
        });
      }
      if (url === `https://api.attio.com/v2/lists/${LIST_ID}/entries/query`) {
        return jsonResponse({
          data: [
            {
              id: { entry_id: "entry_1" },
              parent_record_id: "company_1",
              parent_object: "companies",
              created_at: "2026-07-20T00:00:00.000Z",
              entry_values: {
                status: [{ attribute_type: "status", status: { title: "Contacted" } }],
                owner: [
                  {
                    attribute_type: "actor-reference",
                    referenced_actor_id: "private_actor_id",
                  },
                ],
              },
            },
            {
              id: { entry_id: "entry_2" },
              parent_record_id: "company_2",
              parent_object: "companies",
              entry_values: {
                status: [{ attribute_type: "status", status: { title: "Interested" } }],
              },
            },
          ],
        });
      }
      if (url === "https://api.attio.com/v2/objects/companies/records/query") {
        return jsonResponse({
          data: [
            {
              id: { record_id: "company_2" },
              web_url: "https://app.attio.com/acme/company/company_2",
              values: { name: [{ attribute_type: "text", value: "Beta Ventures" }] },
            },
            {
              id: { record_id: "company_1" },
              web_url: "https://app.attio.com/acme/company/company_1",
              values: {
                name: [{ attribute_type: "text", value: "Acme Capital" }],
                unsafe_reference: [
                  { attribute_type: "record-reference", target_record_id: "private_record_id" },
                ],
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected Attio request: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = (await findListAction().then((action) =>
      action.execute({ list: LIST_URL, limit: 2, offset: 3 }, CONTEXT),
    )) as {
      workspace: string;
      list: { id: string; apiSlug: string; name: string; parentObjects: string[] };
      view: { id: string };
      entries: Array<{
        id: string;
        parent: { id: string; title: string; properties: Record<string, string> };
        values: Record<string, string>;
      }>;
      hasMore: boolean;
      nextOffset?: number;
    };

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const entriesCall = fetchMock.mock.calls.find(([request]) =>
      String(request).endsWith(`/lists/${LIST_ID}/entries/query`),
    );
    expect(entriesCall?.[1]).toMatchObject({ method: "POST", signal: CONTEXT.signal });
    expect(JSON.parse(String(entriesCall?.[1]?.body))).toEqual({
      filter_view_id: VIEW_ID,
      limit: 2,
      offset: 3,
    });
    const recordsCall = fetchMock.mock.calls.find(([request]) =>
      String(request).endsWith("/objects/companies/records/query"),
    );
    expect(JSON.parse(String(recordsCall?.[1]?.body))).toEqual({
      filter: { record_id: { $in: ["company_1", "company_2"] } },
      limit: 2,
    });
    expect(result).toMatchObject({
      workspace: "Acme",
      list: {
        id: LIST_ID,
        apiSlug: "fundraising",
        name: "Fundraising",
        parentObjects: ["companies"],
      },
      view: { id: VIEW_ID },
      entries: [
        {
          id: "entry_1",
          parent: {
            id: "company_1",
            title: "Acme Capital",
            properties: { name: "Acme Capital" },
          },
          values: { status: "Contacted" },
        },
        {
          id: "entry_2",
          parent: {
            id: "company_2",
            title: "Beta Ventures",
            properties: { name: "Beta Ventures" },
          },
          values: { status: "Interested" },
        },
      ],
      hasMore: true,
      nextOffset: 5,
    });
    expect(JSON.stringify(result)).not.toContain("private_actor_id");
    expect(JSON.stringify(result)).not.toContain("private_record_id");
  });

  it("rejects invalid list references and pagination before calling Attio", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const action = await findListAction();

    await expect(action.execute({ list: "https://example.com/list" }, CONTEXT)).rejects.toThrow(
      "secure app.attio.com",
    );
    await expect(
      action.execute(
        {
          list: LIST_URL,
          view: `https://app.attio.com/acme/collection/97052eb9-e65e-443f-a297-f2d9a4a7f795/view/${VIEW_ID}`,
        },
        CONTEXT,
      ),
    ).rejects.toThrow('The "view" URL must belong to the list');
    await expect(action.execute({ list: LIST_ID, limit: 21 }, CONTEXT)).rejects.toThrow(
      '"limit" must be an integer from 1 to 20',
    );
    await expect(action.execute({ list: LIST_ID, offset: 10_001 }, CONTEXT)).rejects.toThrow(
      '"offset" must be an integer from 0 to 10000',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("attio.get_record", () => {
  it("fetches a full record and renders a larger set of typed properties", async () => {
    mocks.loadCredential.mockResolvedValue(credential("workspace_1", true));
    const values = {
      name: [{ attribute_type: "text", value: "Expansion" }],
      domain: [{ attribute_type: "domain", domain: "example.com" }],
      stage: [{ attribute_type: "status", status: { title: "In progress" } }],
      value: [{ attribute_type: "currency", currency_value: 125000 }],
      unsafe_reference: [
        { attribute_type: "record-reference", target_record_id: "private_record_id" },
      ],
      ...Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [`custom_${index}`, [{ value: `${index}` }]]),
      ),
    };
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          id: { object_id: "object_deals", record_id: "deal_1" },
          created_at: "2026-07-02T00:00:00.000Z",
          web_url: "https://app.attio.com/acme/deal/deal_1",
          values,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const action = await findGetRecordAction();
    const result = (await action.execute({ object: "deals", record_id: "deal_1" }, CONTEXT)) as {
      workspace: string;
      record: { id: string; title: string; properties: Record<string, string> };
    };

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.attio.com/v2/objects/deals/records/deal_1",
      expect.objectContaining({ method: "GET", signal: CONTEXT.signal }),
    );
    expect(result).toMatchObject({
      workspace: "Acme",
      record: {
        id: "deal_1",
        title: "Expansion",
        properties: {
          name: "Expansion",
          domain: "example.com",
          stage: "In progress",
          value: "125000",
        },
      },
    });
    expect(Object.keys(result.record.properties)).toHaveLength(24);
    expect(result.record.properties).not.toHaveProperty("unsafe_reference");
    expect(JSON.stringify(result)).not.toContain("private_record_id");
  });

  it("validates object availability and bounded record ids before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const action = await findGetRecordAction();

    await expect(action.execute({ object: "contacts", record_id: "1" }, CONTEXT)).rejects.toThrow(
      '"object" must be one of',
    );
    await expect(action.execute({ object: "deals", record_id: "1" }, CONTEXT)).rejects.toThrow(
      "deals object is not available",
    );
    await expect(
      action.execute({ object: "people", record_id: "x".repeat(201) }, CONTEXT),
    ).rejects.toThrow('"record_id" must be at most 200');
    await expect(
      action.execute({ object: "people", record_id: "1", mutate: true }, CONTEXT),
    ).rejects.toThrow('Unknown parameter: "mutate"');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

async function findSearchAction() {
  const catalog = await resolveAttioActions("user_1");
  const action = catalog?.actions.find((entry) => entry.id === "attio.search_records");
  if (!action) throw new Error("missing attio.search_records");
  return action;
}

async function findListAction() {
  const catalog = await resolveAttioActions("user_1");
  const action = catalog?.actions.find((entry) => entry.id === "attio.query_list");
  if (!action) throw new Error("missing attio.query_list");
  return action;
}

async function findGetRecordAction() {
  const catalog = await resolveAttioActions("user_1");
  const action = catalog?.actions.find((entry) => entry.id === "attio.get_record");
  if (!action) throw new Error("missing attio.get_record");
  return action;
}

function connectedRow(
  overrides: Partial<{
    integrationId: string;
    workspaceId: string;
    workspaceName: string | null;
    scopes: string[];
    status: "connected" | "needs_reauth" | "sync_failed" | "disconnected";
  }> = {},
) {
  return {
    integrationId: "gint_attio_1",
    workspaceId: "workspace_1",
    workspaceName: "Acme",
    scopes: READ_SCOPES,
    status: "connected" as const,
    ...overrides,
  };
}

function credential(workspaceId = "workspace_1", includeDeals = false) {
  return {
    payload: {
      apiKey: "attio_test_api_key",
      workspaceId,
      webhookId: null,
      webhookSecret: null,
      objectIdBySlug: {
        person: "object_people",
        company: "object_companies",
        ...(includeDeals ? { deal: "object_deals" } : {}),
      },
      createdAt: "2026-07-22T00:00:00.000Z",
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
