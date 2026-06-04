import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));
const eventMocks = vi.hoisted(() => ({
  appendRuntimeEvent: vi.fn(async () => {}),
}));
const githubMocks = vi.hoisted(() => ({
  getGitHubInstallationToken: vi.fn(async () => "ghs_test"),
}));
const observabilityMocks = vi.hoisted(() => ({
  logger: {
    warn: vi.fn(),
  },
}));

vi.mock("./db", () => ({
  getDb: dbMocks.getDb,
}));
vi.mock("@opencompany/observability", () => ({
  createLogger: vi.fn(() => observabilityMocks.logger),
}));
vi.mock("./events", () => eventMocks);
vi.mock("./github", () => githubMocks);

import { materializeBrainForSession, syncBrainFromSandbox } from "./brain";

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("materializeBrainForSession", () => {
  it("mounts configured brain files and writes the manifest to root metadata", async () => {
    const db = createBrainDb([
      {
        path: "docs/context.md",
        content: "Known facts",
        contentHash: "hash_123",
        sizeBytes: 11,
      },
    ]);
    dbMocks.getDb.mockReturnValue(db);
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    await materializeBrainForSession({
      sandbox: sandbox as never,
      sessionId: "ses_123",
      workspaceId: "wsp_123",
      workdir: "/home/user/workspace",
      references: [{ path: "docs/context.md", type: "file" }],
    });

    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/brain/docs/context.md",
      "Known facts",
    );
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/.opencompany/brain-manifest.json",
      expect.stringContaining('"root": "brain"'),
      { user: "root" },
    );
    expect(
      sandbox.commands.run.mock.calls.some(([command]) => String(command).includes("git init")),
    ).toBe(false);
  });

  it("mounts all Brain files for the root Brain folder reference", async () => {
    const db = createBrainDb([
      {
        path: "docs/context.md",
        content: "Known facts",
        contentHash: "hash_123",
        sizeBytes: 11,
      },
      {
        path: "README.md",
        content: "Root facts",
        contentHash: "hash_456",
        sizeBytes: 10,
      },
    ]);
    dbMocks.getDb.mockReturnValue(db);
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      },
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
    };

    await materializeBrainForSession({
      sandbox: sandbox as never,
      sessionId: "ses_123",
      workspaceId: "wsp_123",
      workdir: "/home/user/workspace",
      references: [{ path: "/", type: "folder" }],
    });

    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/brain/README.md",
      "Root facts",
    );
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/brain/docs/context.md",
      "Known facts",
    );
  });
});

describe("syncBrainFromSandbox", () => {
  it("writes canonical brain content and enqueues a workspace sync job (no inline GitHub)", async () => {
    const db = createSyncDb({
      mounts: [
        {
          sessionId: "ses_123",
          workspaceId: "wsp_123",
          requestedPath: "/",
          path: "/",
          referenceType: "folder",
          baseHash: null,
          lastSyncedHash: null,
        },
      ],
      currentFiles: [],
    });
    dbMocks.getDb.mockReturnValue(db);
    const sandbox = {
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: "brain/README.md\n", stderr: "", exitCode: 0 }),
      },
      files: {
        read: vi.fn().mockResolvedValue("# Brain"),
      },
    };

    await expect(
      syncBrainFromSandbox({
        sandbox: sandbox as never,
        sessionId: "ses_123",
        workspaceId: "wsp_123",
        workdir: "/home/user/workspace",
      }),
    ).resolves.toBeUndefined();

    // Canonical content persisted as pending; GitHub is projected asynchronously
    // through the unified workspace_sync_jobs outbox.
    expect(db.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "wsp_123",
          path: "README.md",
          content: "# Brain",
          githubSyncStatus: "pending",
        }),
        expect.objectContaining({
          workspaceId: "wsp_123",
          repoPath: "brain/README.md",
          sourceKind: "brain",
          operation: "upsert",
          desiredHash: expect.any(String),
        }),
      ]),
    );
    expect(eventMocks.appendRuntimeEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        sessionId: "ses_123",
        type: "brain.file_changed",
      }),
    );
  });
});

function createBrainDb(rows: Array<Record<string, unknown>>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(rows),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  };
}

function createSyncDb(input: {
  mounts: Array<Record<string, unknown>>;
  currentFiles: Array<Record<string, unknown>>;
}) {
  const whereResults = [input.mounts];
  const limitResults = [input.currentFiles];
  const insertedValues: Array<Record<string, unknown>> = [];
  const db = {
    insertedValues,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const result = whereResults.shift() ?? [];
          return {
            then: (resolve: (value: unknown[]) => void) => resolve(result),
            limit: vi.fn(async () => limitResults.shift() ?? []),
          };
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertedValues.push(value);
        return {
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        };
      }),
    })),
  };
  return db;
}
