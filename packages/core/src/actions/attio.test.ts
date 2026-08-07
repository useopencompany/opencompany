import { describe, expect, it, vi } from "vitest";
import { resolveAttioActions } from "./attio";
import type { GoatActionExecuteContext, ResolvedGoatAction } from "./types";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  loadGoatIntegrationCredential: vi.fn(),
  markGoatIntegrationStatus: vi.fn(),
  requestGoatAttioApi: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@opencompany/db/integrations", () => ({
  loadGoatIntegrationCredential: mocks.loadGoatIntegrationCredential,
  markGoatIntegrationStatus: mocks.markGoatIntegrationStatus,
}));

vi.mock("../integrations/attio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../integrations/attio")>()),
  requestGoatAttioApi: mocks.requestGoatAttioApi,
}));

describe("resolveAttioActions", () => {
  it("can create a person record, add it to a list, and comment on the entry", async () => {
    mocks.getDb.mockImplementation(() =>
      fakeDb({
        connectionRows: [
          {
            integrationId: "gint_attio_1",
            workspaceId: "workspace_1",
            workspaceName: "OpenCompany",
            status: "connected",
            scopes: [
              "object_configuration:read",
              "record_permission:read-write",
              "list_configuration:read",
              "list_entry:read-write",
              "comment:read-write",
            ],
            capabilityModes: { read: "on", write: "on" },
          },
        ],
        statusRows: [
          {
            status: "connected",
            scopes: [
              "object_configuration:read",
              "record_permission:read-write",
              "list_configuration:read",
              "list_entry:read-write",
              "comment:read-write",
            ],
            capabilityModes: { read: "on", write: "on" },
          },
        ],
      }),
    );
    mocks.loadGoatIntegrationCredential.mockResolvedValue({
      payload: {
        apiKey: "attio_api_key",
        workspaceId: "workspace_1",
        authorizedByWorkspaceMemberId: "member_1",
        webhookId: null,
        webhookSecret: null,
        objectIdBySlug: {
          person: "object_people",
          company: "object_companies",
          deal: "object_deals",
        },
        createdAt: "2026-08-04T00:00:00.000Z",
      },
    });
    mocks.requestGoatAttioApi.mockImplementation(
      async (input: { path: string; method?: string }) => {
        if (input.path === "/objects/people/records" && input.method === "POST") {
          return {
            data: {
              id: {
                workspace_id: "workspace_1",
                object_id: "object_people",
                record_id: "record_tim",
              },
              web_url: "https://app.attio.com/opencompany/person/record_tim",
              values: {
                name: [
                  {
                    active_until: null,
                    attribute_type: "personal-name",
                    full_name: "Tim Draper",
                  },
                ],
              },
            },
          };
        }
        if (input.path === "/lists/youtube_guests/entries" && input.method === "PUT") {
          return {
            data: {
              id: { entry_id: "entry_tim" },
              parent_record_id: "record_tim",
              parent_object: "people",
              entry_values: {},
            },
          };
        }
        if (input.path === "/comments" && input.method === "POST") {
          return {
            data: {
              id: { comment_id: "comment_tim" },
              thread_id: "comment_tim",
              content_plaintext: "Julian can likely intro us",
              entry: { list_id: "youtube_guests", entry_id: "entry_tim" },
              author: { type: "workspace-member", id: "member_1" },
            },
          };
        }
        throw new Error(`unexpected Attio call: ${input.method ?? "GET"} ${input.path}`);
      },
    );

    const catalog = await resolveAttioActions("user_1");
    const createRecord = findAction(catalog!.actions, "attio.create_record");
    const addRecordToList = findAction(catalog!.actions, "attio.add_record_to_list");
    const createComment = findAction(catalog!.actions, "attio.create_comment");
    const context = actionContext();

    const created = await createRecord.execute(
      {
        object: "people",
        values: { name: [{ full_name: "Tim Draper" }] },
      },
      context,
    );
    expect(created).toMatchObject({
      workspace: "OpenCompany",
      record: {
        object: "people",
        id: "record_tim",
        title: "Tim Draper",
      },
    });

    const added = await addRecordToList.execute(
      {
        list: "youtube_guests",
        object: "people",
        record_id: "record_tim",
      },
      context,
    );
    expect(added).toMatchObject({
      workspace: "OpenCompany",
      list: "youtube_guests",
      entry: {
        id: "entry_tim",
        parent: { object: "people", id: "record_tim" },
      },
    });

    const commented = await createComment.execute(
      {
        list: "youtube_guests",
        entry_id: "entry_tim",
        content: "Julian can likely intro us",
      },
      context,
    );
    expect(commented).toMatchObject({
      workspace: "OpenCompany",
      comment: {
        id: "comment_tim",
        threadId: "comment_tim",
        contentPlaintext: "Julian can likely intro us",
      },
    });

    expect(mocks.requestGoatAttioApi).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/objects/people/records",
        method: "POST",
        body: { data: { values: { name: [{ full_name: "Tim Draper" }] } } },
      }),
    );
  });
});

function findAction(actions: ResolvedGoatAction[], id: string) {
  const action = actions.find((candidate) => candidate.id === id);
  if (!action) throw new Error(`Missing action ${id}`);
  return action;
}

function actionContext(): GoatActionExecuteContext {
  return {
    userWorkosId: "user_1",
    signal: new AbortController().signal,
    currentDate: new Date("2026-08-04T00:00:00.000Z"),
    userTimezone: "UTC",
  };
}

function fakeDb(input: { connectionRows: unknown[]; statusRows: unknown[] }): {
  select: ReturnType<typeof vi.fn>;
} {
  return {
    select: vi.fn(() => {
      const builder = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        orderBy: vi.fn(async () => input.connectionRows),
        limit: vi.fn(async () => input.statusRows),
      };
      return builder;
    }),
  };
}
