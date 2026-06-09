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

import { materializeAgentBundleForSession, syncAgentBundleFromSandbox } from "./agent-bundle";

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("materializeAgentBundleForSession", () => {
  it("mounts only files under the current agent bundle and preserves relative structure", async () => {
    const db = createAgentBundleDb({
      selectResults: [
        [{ path: "agents/sales/sales.agent" }],
        [
          {
            path: "agents/sales/memory.md",
            content: "Sales memory",
            contentHash: "hash_memory",
            sizeBytes: 12,
          },
          {
            path: "agents/sales/playbooks/discovery.md",
            content: "Discovery",
            contentHash: "hash_playbook",
            sizeBytes: 9,
          },
          {
            path: "agents/support/memory.md",
            content: "Support memory",
            contentHash: "hash_support",
            sizeBytes: 14,
          },
        ],
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const sandbox = createSandbox({
      commandStdout: "",
      fileReads: {},
    });

    await materializeAgentBundleForSession({
      sandbox: sandbox as never,
      sessionId: "ses_123",
      workspaceId: "wsp_123",
      agentId: "agt_sales",
      workdir: "/home/user/workspace",
    });

    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/agent/memory.md",
      "Sales memory",
    );
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/agent/playbooks/discovery.md",
      "Discovery",
    );
    expect(sandbox.files.write).not.toHaveBeenCalledWith(
      "/home/user/workspace/agent/memory.md",
      "Support memory",
    );
    expect(db.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestedPath: "agent/memory.md",
          path: "agents/sales/memory.md",
          baseHash: "hash_memory",
          lastSyncedHash: "hash_memory",
        }),
        expect.objectContaining({
          requestedPath: "agent/playbooks/discovery.md",
          path: "agents/sales/playbooks/discovery.md",
          baseHash: "hash_playbook",
          lastSyncedHash: "hash_playbook",
        }),
      ]),
    );
  });

  it("creates the empty profile file (user.md) and records its mount when no rows exist", async () => {
    const db = createAgentBundleDb({
      selectResults: [[{ path: "agents/sales/sales.agent" }], []],
    });
    dbMocks.getDb.mockReturnValue(db);
    const sandbox = createSandbox({
      commandStdout: "",
      fileReads: {},
    });

    await materializeAgentBundleForSession({
      sandbox: sandbox as never,
      sessionId: "ses_123",
      workspaceId: "wsp_123",
      agentId: "agt_sales",
      workdir: "/home/user/workspace",
    });

    expect(sandbox.files.write).toHaveBeenCalledWith("/home/user/workspace/agent/user.md", "");
    // memory.md is no longer auto-created — durable facts live in structured memory.
    expect(sandbox.files.write).not.toHaveBeenCalledWith(
      "/home/user/workspace/agent/memory.md",
      "",
    );
    expect(db.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestedPath: "agent/user.md",
          path: "agents/sales/user.md",
          baseHash: expect.any(String),
          lastSyncedHash: expect.any(String),
        }),
      ]),
    );
  });

  it("applies Brain-equivalent file, count, and byte limits while mounting", async () => {
    const bundleRows = [
      {
        path: "agents/sales/memory.md",
        content: "Sales memory",
        contentHash: "hash_memory",
        sizeBytes: 12,
      },
      {
        path: "agents/sales/playbooks/oversized.md",
        content: "x".repeat(256 * 1024 + 1),
        contentHash: "hash_oversized",
        sizeBytes: 256 * 1024 + 1,
      },
      ...Array.from({ length: 85 }, (_, index) => ({
        path: `agents/sales/zz-${String(index).padStart(3, "0")}.md`,
        content: `File ${index}`,
        contentHash: `hash_${index}`,
        sizeBytes: 8,
      })),
    ];
    const db = createAgentBundleDb({
      selectResults: [[{ path: "agents/sales/sales.agent" }], bundleRows],
    });
    dbMocks.getDb.mockReturnValue(db);
    const sandbox = createSandbox({
      commandStdout: "",
      fileReads: {},
    });

    await materializeAgentBundleForSession({
      sandbox: sandbox as never,
      sessionId: "ses_123",
      workspaceId: "wsp_123",
      agentId: "agt_sales",
      workdir: "/home/user/workspace",
    });

    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/agent/memory.md",
      "Sales memory",
    );
    expect(sandbox.files.write).not.toHaveBeenCalledWith(
      "/home/user/workspace/agent/playbooks/oversized.md",
      expect.any(String),
    );
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/agent/zz-078.md",
      "File 78",
    );
    expect(sandbox.files.write).not.toHaveBeenCalledWith(
      "/home/user/workspace/agent/zz-079.md",
      "File 79",
    );
  });
});

describe("syncAgentBundleFromSandbox", () => {
  it("upserts a changed memory file as pending and enqueues a workspace sync job", async () => {
    const db = createAgentBundleDb({
      selectResults: [
        [{ path: "agents/sales/sales.agent" }],
        [
          {
            sessionId: "ses_123",
            workspaceId: "wsp_123",
            requestedPath: "agent/memory.md",
            path: "agents/sales/memory.md",
            referenceType: "file",
            baseHash: "hash_old",
            lastSyncedHash: "hash_old",
          },
        ],
        [],
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const sandbox = createSandbox({
      commandStdout: "agent/memory.md\n",
      fileReads: {
        "/home/user/workspace/agent/memory.md": "New memory",
      },
    });

    await syncAgentBundleFromSandbox({
      sandbox: sandbox as never,
      sessionId: "ses_123",
      workspaceId: "wsp_123",
      agentId: "agt_sales",
      workdir: "/home/user/workspace",
    });

    expect(githubMocks.getGitHubInstallationToken).not.toHaveBeenCalled();

    expect(db.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "wsp_123",
          agentId: "agt_sales",
          path: "agents/sales/memory.md",
          content: "New memory",
          githubSyncStatus: "pending",
        }),
        expect.objectContaining({
          workspaceId: "wsp_123",
          repoPath: "agents/sales/memory.md",
          sourceKind: "agent_file",
          operation: "upsert",
          desiredHash: expect.any(String),
        }),
      ]),
    );
    expect(eventMocks.appendRuntimeEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        sessionId: "ses_123",
        type: "agent_bundle.file_changed",
        payload: expect.objectContaining({
          path: "agents/sales/memory.md",
          operation: "write",
        }),
      }),
    );
  });

  it("round-trips changed nested files back to the matching bundle path", async () => {
    const db = createAgentBundleDb({
      selectResults: [
        [{ path: "agents/sales/sales.agent" }],
        [
          {
            sessionId: "ses_123",
            workspaceId: "wsp_123",
            requestedPath: "agent/playbooks/deep/discovery.md",
            path: "agents/sales/playbooks/deep/discovery.md",
            referenceType: "file",
            baseHash: "hash_old",
            lastSyncedHash: "hash_old",
          },
        ],
        [],
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const sandbox = createSandbox({
      commandStdout: "agent/playbooks/deep/discovery.md\n",
      fileReads: {
        "/home/user/workspace/agent/playbooks/deep/discovery.md": "Deep discovery",
      },
    });

    await syncAgentBundleFromSandbox({
      sandbox: sandbox as never,
      sessionId: "ses_123",
      workspaceId: "wsp_123",
      agentId: "agt_sales",
      workdir: "/home/user/workspace",
    });

    expect(db.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "wsp_123",
          agentId: "agt_sales",
          path: "agents/sales/playbooks/deep/discovery.md",
          content: "Deep discovery",
        }),
        expect.objectContaining({
          repoPath: "agents/sales/playbooks/deep/discovery.md",
          sourceKind: "agent_file",
          operation: "upsert",
        }),
      ]),
    );
  });

  it("applies Brain-equivalent file, count, and byte limits while syncing", async () => {
    const db = createAgentBundleDb({
      selectResults: [
        [{ path: "agents/sales/sales.agent" }],
        [
          {
            sessionId: "ses_123",
            workspaceId: "wsp_123",
            requestedPath: "agent/memory.md",
            path: "agents/sales/memory.md",
            referenceType: "file",
            baseHash: "hash_memory",
            lastSyncedHash: "hash_memory",
          },
        ],
        ...Array.from({ length: 80 }, () => []),
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const commandStdout = [
      "agent/big.md",
      ...Array.from(
        { length: 82 },
        (_, index) => `agent/file-${String(index).padStart(3, "0")}.md`,
      ),
    ].join("\n");
    const sandbox = createSandbox({
      commandStdout: `${commandStdout}\n`,
      fileReads: {
        "/home/user/workspace/agent/big.md": "x".repeat(256 * 1024 + 1),
        ...Object.fromEntries(
          Array.from({ length: 82 }, (_, index) => [
            `/home/user/workspace/agent/file-${String(index).padStart(3, "0")}.md`,
            `File ${index}`,
          ]),
        ),
      },
    });

    await syncAgentBundleFromSandbox({
      sandbox: sandbox as never,
      sessionId: "ses_123",
      workspaceId: "wsp_123",
      agentId: "agt_sales",
      workdir: "/home/user/workspace",
    });

    expect(db.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "agents/sales/file-078.md",
          content: "File 78",
        }),
        expect.objectContaining({
          path: "agents/sales/file-079.md",
          content: "File 79",
        }),
      ]),
    );
    expect(db.insertedValues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "agents/sales/big.md" }),
        expect.objectContaining({ path: "agents/sales/file-080.md" }),
      ]),
    );
  });

  it("writes a conflict copy inside the current bundle when the DB row changed since mount", async () => {
    const db = createAgentBundleDb({
      selectResults: [
        [{ path: "agents/sales/sales.agent" }],
        [
          {
            sessionId: "ses_123",
            workspaceId: "wsp_123",
            requestedPath: "agent/memory.md",
            path: "agents/sales/memory.md",
            referenceType: "file",
            baseHash: "hash_base",
            lastSyncedHash: "hash_base",
          },
        ],
        [{ path: "agents/sales/memory.md", contentHash: "hash_other" }],
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const sandbox = createSandbox({
      commandStdout: "agent/memory.md\n",
      fileReads: {
        "/home/user/workspace/agent/memory.md": "Local memory",
      },
    });

    await syncAgentBundleFromSandbox({
      sandbox: sandbox as never,
      sessionId: "ses_123",
      workspaceId: "wsp_123",
      agentId: "agt_sales",
      workdir: "/home/user/workspace",
    });

    expect(db.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "wsp_123",
          agentId: "agt_sales",
          path: expect.stringMatching(/^agents\/sales\/memory\.conflict-.*\.md$/),
          content: "Local memory",
        }),
      ]),
    );
    expect(eventMocks.appendRuntimeEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        type: "agent_bundle.conflict",
        payload: expect.objectContaining({
          path: "agents/sales/memory.md",
          savedPath: expect.stringMatching(/^agents\/sales\/memory\.conflict-.*\.md$/),
          operation: "conflict_copy",
        }),
      }),
    );
  });

  it("ignores malformed sandbox paths before reading or writing", async () => {
    const db = createAgentBundleDb({
      selectResults: [
        [{ path: "agents/sales/sales.agent" }],
        [
          {
            sessionId: "ses_123",
            workspaceId: "wsp_123",
            requestedPath: "agent",
            path: "agents/sales",
            referenceType: "folder",
            baseHash: null,
            lastSyncedHash: null,
          },
        ],
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const sandbox = createSandbox({
      commandStdout: "agent/../memory.md\n",
      fileReads: {},
    });

    await syncAgentBundleFromSandbox({
      sandbox: sandbox as never,
      sessionId: "ses_123",
      workspaceId: "wsp_123",
      agentId: "agt_sales",
      workdir: "/home/user/workspace",
    });

    expect(sandbox.files.read).not.toHaveBeenCalled();
    expect(db.insertedValues).toEqual([]);
  });
});

function createAgentBundleDb(input: { selectResults: unknown[][] }) {
  const selectResults = [...input.selectResults];
  const insertedValues: Array<Record<string, unknown>> = [];
  const db = {
    insertedValues,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const result = selectResults.shift() ?? [];
          return {
            then: (resolve: (value: unknown[]) => void) => resolve(result),
            limit: vi.fn(async () => result),
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
    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
  };
  return db;
}

function createSandbox(input: { commandStdout: string; fileReads: Record<string, string> }) {
  return {
    commands: {
      run: vi.fn().mockResolvedValue({ stdout: input.commandStdout, stderr: "", exitCode: 0 }),
    },
    files: {
      read: vi.fn(async (path: string) => input.fileReads[path] ?? ""),
      write: vi.fn().mockResolvedValue(undefined),
    },
  };
}
