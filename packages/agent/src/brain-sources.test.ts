import type { Actor } from "@opencompany/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureProductEvent: vi.fn(async () => undefined),
  deleteSource: vi.fn(async () => true),
  getBrainAccess: vi.fn(async () => ({ brain: { workspaceId: "workspace_1" } })),
  getDefaultBrain: vi.fn(async () => null),
  getDriveFile: vi.fn(async () => ({
    id: "file_1",
    name: "Plan",
    mimeType: "text/plain",
    driveId: null,
    webViewLink: "https://drive.google.com/file/d/file_1/view",
    parents: [],
    modifiedTime: null,
    version: null,
    trashed: false,
    canDownload: true,
  })),
  getDriveToken: vi.fn(async () => "cursor_1"),
  hasAnySource: vi.fn(async () => false),
  listDriveFiles: vi.fn(async () => ({ files: [], nextPageToken: null })),
  listPersonalAccounts: vi.fn(async () => []),
  listSharedDrives: vi.fn(async () => []),
  listSources: vi.fn(async () => []),
  loadDriveAccount: vi.fn(async (_userId: string, _integrationId: string, db: unknown) => ({
    integrationId: "integration_1",
    userWorkosId: "user_1",
    accountEmail: "owner@example.com",
    db,
  })),
  setEnabled: vi.fn(async () => true),
  upsertCursor: vi.fn(async () => undefined),
  upsertSource: vi.fn(async () => ({ id: "source_1", created: false })),
}));

vi.mock("@opencompany/analytics/product/server", () => ({
  captureProductServerEvent: mocks.captureProductEvent,
}));
vi.mock("@opencompany/db/brain-sources", () => ({
  deleteBrainSource: mocks.deleteSource,
  hasAnyBrainSourceForIntegration: mocks.hasAnySource,
  listBrainSourcesForBrain: mocks.listSources,
  listPersonalIntegrationAccounts: mocks.listPersonalAccounts,
  setBrainSourceEnabled: mocks.setEnabled,
  upsertBrainSource: mocks.upsertSource,
}));
vi.mock("@opencompany/db/workspaces", () => ({
  getDefaultBrainForUser: mocks.getDefaultBrain,
  getBrainAccess: mocks.getBrainAccess,
}));
vi.mock("@opencompany/db/google-drive", async (importActual) => ({
  ...(await importActual<typeof import("@opencompany/db/google-drive")>()),
  upsertGoogleDriveSyncCursor: mocks.upsertCursor,
}));
vi.mock("./app-url", () => ({ getAppUrl: () => "https://app.example.com" }));
vi.mock("./integrations/google-drive-source", async (importActual) => ({
  ...(await importActual<typeof import("./integrations/google-drive-source")>()),
  getGoogleDriveFile: mocks.getDriveFile,
  getGoogleDriveStartPageToken: mocks.getDriveToken,
  listGoogleDriveFiles: mocks.listDriveFiles,
  listGoogleSharedDrives: mocks.listSharedDrives,
  loadOwnGoogleDriveAccount: mocks.loadDriveAccount,
}));

const { BrainSourceApplicationService } = await import("./brain-sources");
const { GoogleDriveReconnectRequiredError } = await import("./integrations/google-drive-source");

const member: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "member",
  permissions: ["brain:read"],
  authenticationMethod: "session",
};
const admin: Actor = { ...member, role: "admin" };

describe("BrainSourceApplicationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBrainAccess.mockResolvedValue({ brain: { workspaceId: "workspace_1" } } as never);
    mocks.upsertSource.mockResolvedValue({ id: "source_1", created: false });
  });

  it("lets a member toggle their own personal source", async () => {
    const service = new BrainSourceApplicationService(
      queuedDb([
        {
          id: "source_1",
          provider: "gmail",
          userWorkosId: member.userId,
          integrationWorkspaceId: null,
        },
      ]),
    );

    await expect(
      service.set(member, "brain_1", "integration_1", {
        operation: "set_enabled",
        provider: "gmail",
        enabled: false,
      }),
    ).resolves.toBeUndefined();
    expect(mocks.setEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        brainRef: "brain_1",
        sourceId: "source_1",
        enabled: false,
      }),
    );
  });

  it("prevents a member from toggling another member's personal source", async () => {
    const service = new BrainSourceApplicationService(
      queuedDb([
        {
          id: "source_1",
          provider: "gmail",
          userWorkosId: "user_2",
          integrationWorkspaceId: null,
        },
      ]),
    );

    await expect(
      service.set(member, "brain_1", "integration_1", {
        operation: "set_enabled",
        provider: "gmail",
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it("lets a workspace admin pause a member-owned source without editing its config", async () => {
    const service = new BrainSourceApplicationService(
      queuedDb([
        {
          id: "source_1",
          provider: "gmail",
          userWorkosId: "user_2",
          integrationWorkspaceId: null,
        },
      ]),
    );

    await service.set(admin, "brain_1", "integration_1", {
      operation: "set_enabled",
      provider: "gmail",
      enabled: false,
    });
    expect(mocks.setEnabled).toHaveBeenCalledOnce();
  });

  it("hides a Brain when canonical access resolves it in another workspace", async () => {
    mocks.getBrainAccess.mockResolvedValueOnce({
      brain: { workspaceId: "workspace_2" },
    } as never);
    const db = queuedDb();
    const service = new BrainSourceApplicationService(db);

    await expect(service.list(member, "brain_other")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("makes removal idempotent when no source row exists", async () => {
    const service = new BrainSourceApplicationService(queuedDb([]));
    await expect(service.remove(member, "brain_1", "integration_1")).resolves.toBeUndefined();
    expect(mocks.deleteSource).not.toHaveBeenCalled();
  });

  it("hides retired Slack sources from Brain settings", async () => {
    mocks.listSources.mockResolvedValueOnce([
      {
        id: "source_slack",
        provider: "slack",
        integrationId: "integration_slack",
        userWorkosId: member.userId,
        integrationWorkspaceId: null,
        enabled: true,
        ownerName: "Ada",
        ownerEmail: "ada@example.com",
        ownerAvatarUrl: null,
        integrationAccountEmail: "ada@example.com",
        integrationAccountName: "Ada",
        integrationConnectionLabel: "Acme",
        integrationStatus: "connected",
        config: {},
      },
    ] as never);
    const service = new BrainSourceApplicationService(queuedDb([]));

    await expect(service.list(member, "brain_1")).resolves.toMatchObject({ sources: [] });
  });

  it("persists every Drive cursor before the source selection timestamp", async () => {
    const order: string[] = [];
    mocks.upsertCursor.mockImplementationOnce(async () => {
      order.push("cursor");
      return undefined;
    });
    mocks.upsertSource.mockImplementationOnce(async () => {
      order.push("source");
      return { id: "source_1", created: false };
    });
    const service = new BrainSourceApplicationService(
      queuedDb(
        [
          {
            id: "integration_1",
            provider: "google_drive",
            userWorkosId: member.userId,
            workspaceId: null,
            externalId: "owner@example.com",
            status: "connected",
            accountName: null,
            accountEmail: "owner@example.com",
            connectionLabel: null,
            statusReason: null,
          },
        ],
        [],
      ),
    );

    await service.set(member, "brain_1", "integration_1", {
      operation: "configure",
      provider: "google_drive",
      enabled: true,
      resourceIds: ["file_1"],
    });

    expect(order).toEqual(["cursor", "source"]);
    expect(mocks.upsertCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        corpusKey: "user",
        pageToken: "cursor_1",
        webhookAddress: "https://app.example.com/api/webhooks/google-drive",
      }),
    );
    expect(mocks.upsertSource).toHaveBeenCalledWith(
      expect.objectContaining({
        brainRef: "brain_1",
        provider: "google_drive",
        enabled: true,
      }),
    );
  });

  it("maps expired Drive credentials to an actionable conflict", async () => {
    mocks.getDriveFile.mockRejectedValueOnce(new GoogleDriveReconnectRequiredError());
    const service = new BrainSourceApplicationService(
      queuedDb(
        [
          {
            id: "integration_1",
            provider: "google_drive",
            userWorkosId: member.userId,
            workspaceId: null,
            externalId: "owner@example.com",
            status: "needs_reauth",
            accountName: null,
            accountEmail: "owner@example.com",
            connectionLabel: null,
            statusReason: "Refresh token expired.",
          },
        ],
        [],
      ),
    );

    await expect(
      service.set(member, "brain_1", "integration_1", {
        operation: "configure",
        provider: "google_drive",
        enabled: true,
        resourceIds: ["file_1"],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Reconnect Google Drive in Settings first.",
    });
    expect(mocks.upsertCursor).not.toHaveBeenCalled();
    expect(mocks.upsertSource).not.toHaveBeenCalled();
  });

  it("keeps the latest active API-key account visible after a newer disconnected row", async () => {
    const service = new BrainSourceApplicationService(
      queuedDb([
        integrationRow({
          id: "granola_disconnected",
          provider: "granola",
          status: "disconnected",
        }),
        integrationRow({ id: "granola_active", provider: "granola", status: "connected" }),
      ]),
    );

    const details = await service.list(member, "brain_1");

    expect(details.granola.integration).toMatchObject({
      integrationId: "granola_active",
      connected: true,
      status: "connected",
    });
  });
});

function integrationRow(
  overrides: Partial<{
    id: string;
    provider: "granola";
    status: "connected" | "disconnected";
  }> = {},
) {
  return {
    id: "integration_1",
    provider: "granola" as const,
    userWorkosId: member.userId,
    workspaceId: null,
    externalId: "account@example.com",
    status: "connected" as const,
    accountName: "Account",
    accountEmail: "account@example.com",
    connectionLabel: null,
    statusReason: null,
    ...overrides,
  };
}

function queuedDb(...results: unknown[][]) {
  const queue = [...results];
  const db = {
    select: vi.fn(() => {
      const result = queue.shift() ?? [];
      const builder = {
        from: () => builder,
        innerJoin: () => builder,
        where: () => builder,
        orderBy: () => builder,
        limit: async () => result,
        then: <TResult1 = unknown[], TResult2 = never>(
          onFulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
          onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) => Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return builder;
    }),
  };
  return db;
}
