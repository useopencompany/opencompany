import type { Actor, CoreError } from "@opencompany/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBrainAccess: vi.fn(async () => ({ brain: { workspaceId: "workspace_1" } })),
  startRun: vi.fn(
    async (input: { sourceSelection: unknown }) =>
      ({
        run: { id: "gbimp_1", status: "discovering", sourceSelection: input.sourceSelection },
        idempotentReplay: false,
      }) as never,
  ),
  confirmRun: vi.fn(async () => ({ importRunId: "gbimp_1", enqueued: 0 })),
  cancelRun: vi.fn(async () => ({ importRunId: "gbimp_1", skippedJobs: 0 })),
  retryRun: vi.fn(async () => ({ importRunId: "gbimp_1", deletedCandidates: 0 })),
  legacyBrainEnabled: vi.fn(async () => false),
  startWikiRun: vi.fn(async (_input: unknown) => ({
    run: { id: "gbimp_wiki", status: "discovering" },
    idempotentReplay: false,
  })),
  confirmWikiRun: vi.fn(async () => ({ importRunId: "gbimp_wiki", enqueued: 0 })),
  cancelWikiRun: vi.fn(async () => ({ importRunId: "gbimp_wiki", skippedJobs: 0 })),
  retryWikiRun: vi.fn(async () => ({ importRunId: "gbimp_wiki", deletedCandidates: 0 })),
}));

vi.mock("@opencompany/db/workspaces", () => ({
  getBrainAccess: mocks.getBrainAccess,
  isLegacyBrainEnabledForWorkspace: mocks.legacyBrainEnabled,
}));
vi.mock("@opencompany/db/brain-import", async (importActual) => ({
  ...(await importActual<typeof import("@opencompany/db/brain-import")>()),
  startBrainImportRunIdempotent: mocks.startRun,
  confirmBrainImport: mocks.confirmRun,
  cancelBrainImport: mocks.cancelRun,
  retryBrainImportDiscovery: mocks.retryRun,
  startWikiImportRunIdempotent: mocks.startWikiRun,
  confirmWikiImport: mocks.confirmWikiRun,
  cancelWikiImport: mocks.cancelWikiRun,
  retryWikiImportDiscovery: mocks.retryWikiRun,
}));

const { BrainImportApplicationService, WikiImportApplicationService } = await import(
  "./brain-imports"
);

const member: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "member",
  permissions: ["brain:read"],
  authenticationMethod: "session",
};
const admin: Actor = { ...member, role: "admin" };
const wikiAdmin: Actor = {
  ...admin,
  permissions: ["wiki:read", "wiki:write"],
};

const disconnected = { integration: { integrationId: null } };

function sourcesDetails(overrides: Record<string, unknown> = {}) {
  return {
    viewer: { actorId: "user_1", isAdmin: true },
    sources: [] as Array<Record<string, unknown>>,
    ownAccounts: {},
    jamie: disconnected,
    granola: disconnected,
    fathom: disconnected,
    gmail: disconnected,
    linear: disconnected,
    googleDrive: disconnected,
    hubspot: disconnected,
    attio: disconnected,
    ...overrides,
  } as never;
}

function service(input?: {
  list?: () => Promise<never>;
  listOptions?: (actor: Actor, integrationId: string, command: unknown) => Promise<never>;
}) {
  const list = vi.fn(input?.list ?? (async () => sourcesDetails()));
  const listOptions = vi.fn(
    input?.listOptions ??
      (async () =>
        ({
          provider: "linear",
          teams: [{ id: "team_1", name: "Engineering", key: "ENG" }],
          partial: false,
        }) as never),
  );
  return {
    service: new BrainImportApplicationService({}, { list, listOptions } as never),
    list,
    listOptions,
  };
}

describe("BrainImportApplicationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBrainAccess.mockResolvedValue({ brain: { workspaceId: "workspace_1" } } as never);
  });

  it("requires a workspace admin with access to the brain", async () => {
    const { service: imports } = service();

    await expect(
      imports.start(member, "brain_1", {
        idempotencyKey: "key-1",
        companyUrl: "acme.com",
        sourceSelection: {},
      }),
    ).rejects.toMatchObject({ code: "forbidden" } satisfies Partial<CoreError>);

    mocks.getBrainAccess.mockResolvedValue({ brain: { workspaceId: "workspace_other" } } as never);
    await expect(imports.cancel(admin, "brain_1", "gbimp_1")).rejects.toMatchObject({
      code: "not_found",
    } satisfies Partial<CoreError>);
    expect(mocks.cancelRun).not.toHaveBeenCalled();
  });

  it("rejects an invalid company website before reserving the command", async () => {
    const { service: imports } = service();

    await expect(
      imports.start(admin, "brain_1", {
        idempotencyKey: "key-1",
        companyUrl: "http://localhost",
        sourceSelection: {},
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" } satisfies Partial<CoreError>);
    expect(mocks.startRun).not.toHaveBeenCalled();
  });

  it("requires a connected integration for an enabled provider", async () => {
    const { service: imports } = service();

    await expect(
      imports.start(admin, "brain_1", {
        idempotencyKey: "key-1",
        companyUrl: "acme.com",
        sourceSelection: {
          gmail: { enabled: true, integrationId: "integration_gmail" },
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      message: "Connect Gmail in your settings first.",
    } satisfies Partial<CoreError>);
    expect(mocks.startRun).not.toHaveBeenCalled();
  });

  it("reuses the stored source configuration and defaults Gmail events", async () => {
    const { service: imports, listOptions } = service({
      list: async () =>
        sourcesDetails({
          gmail: { integration: { integrationId: "integration_gmail" } },
          sources: [
            {
              provider: "gmail",
              integrationId: "integration_gmail",
              canConfigure: true,
              config: {},
            },
          ],
        }),
    });

    await imports.start(admin, "brain_1", {
      idempotencyKey: "key-1",
      companyUrl: "acme.com",
      sourceSelection: {
        gmail: { enabled: true, integrationId: "integration_gmail" },
      },
    });

    expect(listOptions).not.toHaveBeenCalled();
    const persisted = mocks.startRun.mock.calls[0]?.[0] as {
      sourceSelection: Record<string, { config?: Record<string, unknown> }>;
    };
    expect(persisted.sourceSelection.gmail?.config?.events).toEqual([
      { id: "email_received" },
      { id: "email_sent" },
    ]);
  });

  it("passes lifecycle commands through with sanitized providers", async () => {
    const { service: imports } = service();

    await expect(
      imports.confirm(admin, "brain_1", "gbimp_1", ["public_web", "github", "public_web"]),
    ).resolves.toEqual({ importRunId: "gbimp_1", status: "ingesting", replayed: false });
    expect(mocks.confirmRun).toHaveBeenCalledWith(
      expect.objectContaining({
        importRunId: "gbimp_1",
        brainRef: "brain_1",
        enabledProviders: ["public_web"],
        actingUserWorkosId: "user_1",
      }),
    );

    await expect(imports.cancel(admin, "brain_1", "gbimp_1")).resolves.toMatchObject({
      status: "canceled",
    });
    await expect(imports.retry(admin, "brain_1", "gbimp_1")).resolves.toMatchObject({
      status: "discovering",
    });
  });
});

describe("WikiImportApplicationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.legacyBrainEnabled.mockResolvedValue(false);
  });

  it("binds a Wiki import to configured source rows and the acting workspace", async () => {
    const list = vi.fn(
      async () =>
        [
          {
            provider: "linear",
            integrationId: "integration_linear",
            integrationStatus: "connected",
            canConfigure: true,
            enabled: true,
            config: { teams: [{ id: "team_1", name: "Engineering" }] },
          },
        ] as never,
    );
    const service = new WikiImportApplicationService({}, { list });

    await expect(
      service.start(wikiAdmin, {
        idempotencyKey: "wiki-1",
        companyUrl: "acme.com",
        sourceSelection: {
          public_web: { enabled: true },
          linear: { enabled: true, integrationId: "integration_linear" },
          fathom: { enabled: true, integrationId: "integration_fathom" },
        },
      }),
    ).resolves.toMatchObject({ importRunId: "gbimp_wiki", status: "discovering" });
    expect(mocks.startWikiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: wikiAdmin,
        companyUrl: "https://acme.com",
        sourceSelection: expect.objectContaining({
          public_web: { enabled: true },
          linear: expect.objectContaining({ integrationId: "integration_linear" }),
        }),
      }),
    );
    const call = mocks.startWikiRun.mock.calls[0]?.[0] as {
      sourceSelection: Record<string, unknown>;
    };
    expect(call.sourceSelection.fathom).toBeUndefined();
  });

  it("rejects members and legacy Brain workspaces", async () => {
    const service = new WikiImportApplicationService({}, { list: vi.fn(async () => []) });
    await expect(
      service.start(
        { ...wikiAdmin, role: "member" },
        {
          idempotencyKey: "wiki-1",
          companyUrl: "acme.com",
          sourceSelection: {},
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    mocks.legacyBrainEnabled.mockResolvedValue(true);
    await expect(service.cancel(wikiAdmin, "gbimp_wiki")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("preserves created-by attribution through confirmation", async () => {
    const service = new WikiImportApplicationService({}, { list: vi.fn(async () => []) });
    await service.confirm(wikiAdmin, "gbimp_wiki", ["public_web", "public_web", "fathom"]);
    expect(mocks.confirmWikiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        importRunId: "gbimp_wiki",
        workspaceId: "workspace_1",
        actingUserWorkosId: "user_1",
        enabledProviders: ["public_web"],
      }),
    );
  });
});
