import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insertedValues: undefined as unknown,
  conflictSet: undefined as unknown,
  loadCredential: vi.fn(),
  saveCredential: vi.fn(),
  markStatus: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    insert: () => ({
      values: (values: unknown) => {
        mocks.insertedValues = values;
        return {
          onConflictDoUpdate: (config: { set: unknown }) => {
            mocks.conflictSet = config.set;
            return {
              returning: async () => [{ id: "gint_attio" }],
            };
          },
        };
      },
    }),
  }),
}));
vi.mock("@opencompany/db/integrations", () => ({
  loadGoatIntegrationCredential: mocks.loadCredential,
  saveGoatIntegrationCredential: mocks.saveCredential,
  markGoatIntegrationStatus: mocks.markStatus,
}));
vi.mock("@opencompany/core/app-url", () => ({
  getGoatAppUrl: () => "https://goat.example",
}));

import {
  connectGoatAttioIntegration,
  hasGoatAttioCommentWriteScopes,
  hasGoatAttioListConfigurationWriteScope,
  hasGoatAttioListReadScopes,
  hasGoatAttioListWriteScopes,
  hasGoatAttioRecordWriteScopes,
  parseGoatAttioScopes,
  validateGoatAttioApiKey,
} from "@opencompany/core/integrations/attio";

beforeEach(() => {
  mocks.insertedValues = undefined;
  mocks.conflictSet = undefined;
  mocks.loadCredential.mockReset();
  mocks.loadCredential.mockResolvedValue(null);
  mocks.saveCredential.mockReset();
  mocks.saveCredential.mockResolvedValue(undefined);
  mocks.markStatus.mockReset();
  mocks.markStatus.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Attio API key scope handling", () => {
  it("parses, deduplicates, and normalizes the space-delimited /self scope", () => {
    expect(
      parseGoatAttioScopes(
        " note:read-write  object_configuration:read note:read-write record_permission:read-write ",
      ),
    ).toEqual(["note:read-write", "object_configuration:read", "record_permission:read-write"]);
    expect(
      parseGoatAttioScopes([
        " list_configuration:read-write list_entry:read-write ",
        "object_configuration:read-write",
      ]),
    ).toEqual([
      "list_configuration:read-write",
      "list_entry:read-write",
      "object_configuration:read-write",
    ]);
    expect(parseGoatAttioScopes(undefined)).toEqual([]);
  });

  it("requires both list capabilities while accepting read-write variants", () => {
    expect(hasGoatAttioListReadScopes([])).toBe(false);
    expect(hasGoatAttioListReadScopes(["list_configuration:read"])).toBe(false);
    expect(hasGoatAttioListReadScopes(["list_configuration:read", "list_entry:read"])).toBe(true);
    expect(
      hasGoatAttioListReadScopes(["list_configuration:read-write", "list_entry:read-write"]),
    ).toBe(true);
  });

  it("requires explicit record and list-entry write scopes for chat updates", () => {
    expect(
      hasGoatAttioRecordWriteScopes(["object_configuration:read", "record_permission:read-write"]),
    ).toBe(true);
    expect(
      hasGoatAttioRecordWriteScopes(["object_configuration:read", "record_permission:read"]),
    ).toBe(false);
    expect(hasGoatAttioListWriteScopes(["list_configuration:read", "list_entry:read-write"])).toBe(
      true,
    );
    expect(hasGoatAttioListWriteScopes(["list_configuration:read", "list_entry:read"])).toBe(false);
    expect(hasGoatAttioListConfigurationWriteScope(["list_configuration:read"])).toBe(false);
    expect(hasGoatAttioListConfigurationWriteScope(["list_configuration:read-write"])).toBe(true);
    expect(
      hasGoatAttioCommentWriteScopes([
        "comment:read-write",
        "object_configuration:read",
        "record_permission:read",
      ]),
    ).toBe(true);
    expect(
      hasGoatAttioCommentWriteScopes([
        "comment:read",
        "object_configuration:read",
        "record_permission:read",
      ]),
    ).toBe(false);
  });

  it("returns Attio scopes with the validated workspace identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          active: true,
          workspace_id: "workspace_1",
          workspace_name: "Acme",
          workspace_slug: "acme",
          authorized_by_workspace_member_id: "member_1",
          scope: [
            "object_configuration:read record_permission:read-write note:read-write webhook:read-write",
          ],
        }),
      ),
    );
    await expect(validateGoatAttioApiKey("attio_test_api_key")).resolves.toEqual({
      ok: true,
      identity: {
        workspaceId: "workspace_1",
        workspaceName: "Acme",
        workspaceSlug: "acme",
        authorizedByWorkspaceMemberId: "member_1",
        scopes: [
          "note:read-write",
          "object_configuration:read",
          "record_permission:read-write",
          "webhook:read-write",
        ],
      },
    });
  });

  it("persists validated scopes on both insert and reconnect", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          data: [
            { id: { object_id: "object_people" }, api_slug: "people" },
            { id: { object_id: "object_companies" }, api_slug: "companies" },
            { id: { object_id: "object_deals" }, api_slug: "deals" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          data: {
            id: { webhook_id: "webhook_1" },
            secret: "webhook_secret",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const scopes = [
      "object_configuration:read",
      "record_permission:read-write",
      "note:read-write",
      "webhook:read-write",
    ];
    await connectGoatAttioIntegration({
      userWorkosId: "user_1",
      apiKey: "attio_test_api_key",
      identity: {
        workspaceId: "workspace_1",
        workspaceName: "Acme",
        workspaceSlug: "acme",
        authorizedByWorkspaceMemberId: "member_1",
        scopes,
      },
      now: new Date("2026-07-21T00:00:00.000Z"),
    });

    expect(mocks.insertedValues).toEqual(expect.objectContaining({ scopes }));
    expect(mocks.conflictSet).toEqual(expect.objectContaining({ scopes }));
    expect(mocks.saveCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        integrationId: "gint_attio",
        payload: expect.objectContaining({
          apiKey: "attio_test_api_key",
          authorizedByWorkspaceMemberId: "member_1",
          webhookId: "webhook_1",
        }),
      }),
    );
  });
});

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
