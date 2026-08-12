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
}));

vi.mock("@opencompany/db/goat-workspaces", () => ({
  getGoatBrainAccess: mocks.getBrainAccess,
}));
vi.mock("@opencompany/db/goat-brain-import", async (importActual) => ({
  ...(await importActual<typeof import("@opencompany/db/goat-brain-import")>()),
  startGoatBrainImportRunIdempotent: mocks.startRun,
  confirmGoatBrainImport: mocks.confirmRun,
  cancelGoatBrainImport: mocks.cancelRun,
  retryGoatBrainImportDiscovery: mocks.retryRun,
}));

const { GoatBrainImportApplicationService } = await import("./brain-imports");

const member: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "member",
  permissions: ["brain:read"],
  authenticationMethod: "session",
};
const admin: Actor = { ...member, role: "admin" };

const connectedGitHub = {
  integration: { integrationId: "integration_gh" },
};
const disconnected = { integration: { integrationId: null } };

function sourcesDetails(overrides: Record<string, unknown> = {}) {
  return {
    viewer: { actorId: "user_1", isAdmin: true },
    sources: [] as Array<Record<string, unknown>>,
    ownAccounts: {},
    github: connectedGitHub,
    jamie: disconnected,
    granola: disconnected,
    fathom: disconnected,
    gmail: disconnected,
    slack: disconnected,
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
          provider: "github",
          repos: [
            { id: "repo_1", fullName: "acme/api", private: true },
            { id: "repo_2", fullName: "acme/web", private: false },
          ],
        }) as never),
  );
  return {
    service: new GoatBrainImportApplicationService({}, { list, listOptions } as never),
    list,
    listOptions,
  };
}

describe("GoatBrainImportApplicationService", () => {
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

  it("normalizes the selection server-side and binds GitHub scope to listed repositories", async () => {
    const { service: imports, listOptions } = service();

    const result = await imports.start(admin, "brain_1", {
      idempotencyKey: "key-1",
      companyUrl: "acme.com",
      sourceSelection: {
        public_web: { enabled: true },
        github: {
          enabled: true,
          integrationId: "integration_gh",
          config: {
            repos: [{ fullName: "acme/api" }, { fullName: "not-listed/repo" }],
          },
        },
        slack: { enabled: false },
      },
    });

    expect(result).toMatchObject({ importRunId: "gbimp_1", status: "discovering" });
    expect(listOptions).toHaveBeenCalledWith(admin, "integration_gh", { provider: "github" });
    const persisted = mocks.startRun.mock.calls[0]?.[0] as {
      sourceSelection: Record<string, { enabled: boolean; config?: Record<string, unknown> }>;
    };
    expect(persisted.sourceSelection.public_web).toEqual({ enabled: true });
    expect(persisted.sourceSelection.github?.config?.repos).toEqual([
      { id: "repo_1", fullName: "acme/api" },
    ]);
    expect(Array.isArray(persisted.sourceSelection.github?.config?.events)).toBe(true);
    expect(persisted.sourceSelection.slack).toEqual({ enabled: false });
    expect(persisted.sourceSelection.jamie).toEqual({ enabled: false });
  });

  it("requires a connected integration for an enabled provider", async () => {
    const { service: imports } = service();

    await expect(
      imports.start(admin, "brain_1", {
        idempotencyKey: "key-1",
        companyUrl: "acme.com",
        sourceSelection: {
          slack: { enabled: true, integrationId: "integration_slack" },
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      message: "Connect Slack in your settings first.",
    } satisfies Partial<CoreError>);
    expect(mocks.startRun).not.toHaveBeenCalled();
  });

  it("requires configured scope for GitHub, Slack, and Linear sources", async () => {
    const { service: imports } = service();

    await expect(
      imports.start(admin, "brain_1", {
        idempotencyKey: "key-1",
        companyUrl: "acme.com",
        sourceSelection: {
          github: {
            enabled: true,
            integrationId: "integration_gh",
            config: { repos: [{ fullName: "not-listed/repo" }] },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      message: "Select at least one GitHub repository.",
    } satisfies Partial<CoreError>);

    const configuredSlack = service({
      list: async () =>
        sourcesDetails({
          slack: { integration: { integrationId: "integration_slack" } },
          sources: [
            {
              provider: "slack",
              integrationId: "integration_slack",
              canConfigure: true,
              config: { channels: [], dms: [] },
            },
          ],
        }),
    });
    await expect(
      configuredSlack.service.start(admin, "brain_1", {
        idempotencyKey: "key-2",
        companyUrl: "acme.com",
        sourceSelection: {
          slack: { enabled: true, integrationId: "integration_slack" },
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      message: "Select at least one Slack channel or DM in Brain Settings first.",
    } satisfies Partial<CoreError>);
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
      imports.confirm(admin, "brain_1", "gbimp_1", ["public_web", "github", "github"]),
    ).resolves.toEqual({ importRunId: "gbimp_1", status: "ingesting", replayed: false });
    expect(mocks.confirmRun).toHaveBeenCalledWith(
      expect.objectContaining({
        importRunId: "gbimp_1",
        brainRef: "brain_1",
        enabledProviders: ["public_web", "github"],
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
