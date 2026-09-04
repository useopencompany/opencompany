import type { Actor } from "@opencompany/core";
import { listWikiIngestActivityRows } from "@opencompany/db/wiki-ingest";
import {
  deleteWikiSource,
  listWikiSourcesForWorkspace,
  setWikiSourceEnabled,
  upsertWikiSource,
} from "@opencompany/db/wiki-sources";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWikiSourceService } from "./wiki-sources";

vi.mock("@opencompany/db/wiki-sources", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteWikiSource: vi.fn(async () => true),
  listWikiSourcesForWorkspace: vi.fn(async () => []),
  setWikiSourceEnabled: vi.fn(async () => true),
  upsertWikiSource: vi.fn(async () => ({ id: "gwscfg_1", created: true })),
}));

vi.mock("@opencompany/db/wiki-ingest", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWikiIngestActivityRows: vi.fn(async () => []),
}));

const admin = actor({ role: "admin" });
const member = actor({ role: "member" });

describe("Wiki source service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listWikiSourcesForWorkspace).mockResolvedValue([]);
    vi.mocked(listWikiIngestActivityRows).mockResolvedValue([]);
  });

  it("lists only the actor's workspace and derives member-safe capabilities", async () => {
    vi.mocked(listWikiSourcesForWorkspace).mockResolvedValueOnce([
      sourceRow({
        userWorkosId: "user_2",
        integrationWorkspaceId: null,
      }),
      sourceRow({
        id: "gwscfg_workspace",
        provider: "github",
        integrationId: "integration_workspace",
        integrationWorkspaceId: "workspace_1",
      }),
      sourceRow({
        id: "gwscfg_retired_slack",
        provider: "slack",
        integrationId: "integration_slack",
      }),
    ] as never);
    const service = createWikiSourceService({ db: integrationDb([]) });

    await expect(service.list(member)).resolves.toMatchObject([
      {
        id: "gwscfg_1",
        ownerKind: "user",
        isOwn: false,
        canConfigure: false,
        canToggle: false,
        canDelete: false,
      },
    ]);
    expect(listWikiSourcesForWorkspace).toHaveBeenCalledWith("workspace_1", expect.anything());
  });

  it("hides retired Slack and GitHub activity rows", async () => {
    vi.mocked(listWikiIngestActivityRows).mockResolvedValueOnce([
      activityRow({ sourceProvider: "slack", sourceType: "conversation" }),
      activityRow({ id: "gwjob_github", sourceProvider: "github", sourceType: "activity" }),
      activityRow({ id: "gwjob_gmail", sourceProvider: "gmail", sourceType: "thread" }),
    ] as never);
    const service = createWikiSourceService({ db: integrationDb([]) });

    await expect(service.listActivity(member, { limit: 20 })).resolves.toMatchObject({
      items: [{ id: "gwjob_gmail", provider: "gmail" }],
    });
  });

  it("requires Wiki permissions for reads and writes", async () => {
    const service = createWikiSourceService({ db: integrationDb([]) });
    const previewDisabled = actor({ permissions: [] });

    await expect(service.list(previewDisabled)).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.listActivity(previewDisabled, { limit: 20 })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      service.upsert(previewDisabled, {
        integrationId: "integration_1",
        provider: "gmail",
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(listWikiSourcesForWorkspace).not.toHaveBeenCalled();
    expect(upsertWikiSource).not.toHaveBeenCalled();
  });

  it("rejects malformed activity cursors before querying persistence", async () => {
    const service = createWikiSourceService({ db: integrationDb([]) });

    await expect(
      service.listActivity(member, { limit: 20, cursor: "not-a-valid-cursor" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(listWikiIngestActivityRows).not.toHaveBeenCalled();
  });

  it("returns paginated activity with sanitized reasons and page mutations", async () => {
    vi.mocked(listWikiIngestActivityRows).mockResolvedValueOnce([
      activityRow({
        result: {
          pages: [
            { path: "projects/launch", title: "Launch", action: "updated" },
            { path: "ignored", title: "Ignored", action: "bogus" },
            { path: "../settings", title: "Unsafe", action: "updated" },
          ],
        },
      }),
      activityRow({
        id: "gwjob_older",
        status: "skipped",
        skipReason: "Routine chatter",
        createdAt: new Date("2026-08-23T09:00:00.000Z"),
      }),
    ] as never);
    const service = createWikiSourceService({ db: integrationDb([]) });

    await expect(service.listActivity(member, { limit: 1 })).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: "gwjob_1",
          outcome: "succeeded",
          reason: null,
          pages: [{ path: "projects/launch", title: "Launch", action: "updated" }],
        }),
      ],
      nextCursor: expect.any(String),
    });
    expect(listWikiIngestActivityRows).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      limit: 2,
      before: null,
      db: expect.anything(),
    });
  });

  it("recovers touched pages from pre-Step-7 wiki traces", async () => {
    vi.mocked(listWikiIngestActivityRows).mockResolvedValueOnce([
      activityRow({
        result: {
          trace: {
            toolCalls: [
              {
                command: "write",
                status: "completed",
                mutating: true,
                inputPreview: '{"command":"write","path":"people/ada"}',
                outputPreview: '{"action":"created","path":"people/ada","title":"Ada Lovelace"}',
              },
            ],
          },
        },
      }),
    ] as never);
    const service = createWikiSourceService({ db: integrationDb([]) });

    await expect(service.listActivity(member, { limit: 20 })).resolves.toMatchObject({
      items: [
        {
          pages: [{ path: "people/ada", title: "Ada Lovelace", action: "created" }],
        },
      ],
    });
  });

  it("upserts only an owned connection and carries actor workspace identity to persistence", async () => {
    vi.mocked(listWikiSourcesForWorkspace)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([sourceRow()] as never);
    const db = integrationDb([
      {
        id: "integration_1",
        provider: "gmail",
        userWorkosId: "user_1",
        workspaceId: null,
        status: "connected",
      },
    ]);
    const service = createWikiSourceService({ db });

    await expect(
      service.upsert(member, {
        integrationId: "integration_1",
        provider: "gmail",
        enabled: true,
      }),
    ).resolves.toMatchObject({ id: "gwscfg_1", isOwn: true, canToggle: true });
    expect(upsertWikiSource).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      provider: "gmail",
      integrationId: "integration_1",
      userWorkosId: "user_1",
      createdByWorkosId: "user_1",
      enabled: true,
      db,
    });
  });

  it("reserves workspace-owned source configuration for workspace admins", async () => {
    const service = createWikiSourceService({ db: integrationDb([]) });

    await expect(
      service.upsert(member, {
        integrationId: "integration_jamie",
        provider: "jamie",
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(upsertWikiSource).not.toHaveBeenCalled();
  });

  it("workspace-scopes toggles and lets admins pause a member-owned source", async () => {
    const otherMemberSource = sourceRow({ userWorkosId: "user_2" });
    vi.mocked(listWikiSourcesForWorkspace)
      .mockResolvedValueOnce([otherMemberSource] as never)
      .mockResolvedValueOnce([{ ...otherMemberSource, enabled: false }] as never);
    const service = createWikiSourceService({ db: integrationDb([]) });

    await expect(service.setEnabled(admin, "gwscfg_1", false)).resolves.toMatchObject({
      enabled: false,
      canToggle: true,
    });
    expect(setWikiSourceEnabled).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      sourceId: "gwscfg_1",
      enabled: false,
      db: expect.anything(),
    });

    vi.mocked(listWikiSourcesForWorkspace).mockResolvedValueOnce([]);
    await expect(service.setEnabled(admin, "gwscfg_other_workspace", false)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("does not let a member mutate another member's source", async () => {
    vi.mocked(listWikiSourcesForWorkspace).mockResolvedValueOnce([
      sourceRow({ userWorkosId: "user_2" }),
    ] as never);
    const service = createWikiSourceService({ db: integrationDb([]) });

    await expect(service.remove(member, "gwscfg_1")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(deleteWikiSource).not.toHaveBeenCalled();
  });
});

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user_1",
    workspaceId: "workspace_1",
    role: "member",
    permissions: ["wiki:read", "wiki:write"],
    authenticationMethod: "session",
    ...overrides,
  };
}

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "gwscfg_1",
    workspaceId: "workspace_1",
    provider: "gmail" as const,
    integrationId: "integration_1",
    userWorkosId: "user_1",
    enabled: true,
    config: {},
    integrationStatus: "connected" as const,
    integrationAccountName: null,
    integrationAccountEmail: "ada@example.com",
    integrationConnectionLabel: null,
    integrationWorkspaceId: null,
    ownerName: "Ada Lovelace",
    ownerEmail: "ada@example.com",
    ownerAvatarUrl: null,
    ...overrides,
  };
}

function integrationDb(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { select: vi.fn(() => ({ from })) };
}

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "gwjob_1",
    sourceProvider: "gmail" as const,
    sourceType: "thread" as const,
    title: "Launch update",
    occurredAt: new Date("2026-08-24T08:00:00.000Z"),
    status: "succeeded" as const,
    attempts: 1,
    lastError: null,
    skipReason: null,
    result: {},
    completedAt: new Date("2026-08-24T09:01:00.000Z"),
    createdAt: new Date("2026-08-24T09:00:00.000Z"),
    updatedAt: new Date("2026-08-24T09:01:00.000Z"),
    ...overrides,
  };
}
