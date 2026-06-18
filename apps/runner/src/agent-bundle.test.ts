import { createHash } from "node:crypto";
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

import {
  MAX_AGENT_BUNDLE_FILE_BYTES,
  materializeAgentBundleForSession,
  syncAgentBundleFromSandbox,
} from "./agent-bundle";

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function sha256(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// The sync listing command emits sha256sum output: "<hash>  <path>" per file.
function hashLine(path: string, content: string) {
  return `${sha256(content)}  ${path}`;
}

function writtenSandboxFiles(sandbox: ReturnType<typeof createSandbox>) {
  expect(sandbox.files.write).toHaveBeenCalledTimes(1);
  expect(sandbox.files.write).toHaveBeenCalledWith(expect.any(Array), { user: "user" });
  return sandbox.files.write.mock.calls[0]?.[0] as Array<{ path: string; data: string }>;
}

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

    const writes = writtenSandboxFiles(sandbox);
    expect(writes).toEqual(
      expect.arrayContaining([
        { path: "/home/user/workspace/agent/memory.md", data: "Sales memory" },
        { path: "/home/user/workspace/agent/playbooks/discovery.md", data: "Discovery" },
      ]),
    );
    expect(writes).not.toEqual(
      expect.arrayContaining([
        { path: "/home/user/workspace/agent/memory.md", data: "Support memory" },
      ]),
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
    const commands = sandbox.commands.run.mock.calls.map(([command]) => String(command));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBe(
      "rm -rf '/home/user/workspace/agent' && mkdir -p '/home/user/workspace/agent'",
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "rm -rf '/home/user/workspace/agent' && mkdir -p '/home/user/workspace/agent'",
      { user: "user", timeoutMs: 30_000 },
    );
    expect(commands.filter((command) => command.startsWith("mkdir -p "))).toHaveLength(0);
  });

  it("promotes memory/ and personal-brain/ to top-level roots for personal sessions", async () => {
    const db = createAgentBundleDb({
      selectResults: [
        [{ path: "agents/personal-abc/personal-abc.agent" }],
        [
          {
            path: "agents/personal-abc/memory/notes.md",
            content: "Memory notes",
            contentHash: "hash_mem",
            sizeBytes: 12,
          },
          {
            path: "agents/personal-abc/personal-brain/idea.md",
            content: "An idea",
            contentHash: "hash_brain",
            sizeBytes: 7,
          },
          {
            path: "agents/personal-abc/soul.md",
            content: "Soul",
            contentHash: "hash_soul",
            sizeBytes: 4,
          },
        ],
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const sandbox = createSandbox({ commandStdout: "", fileReads: {} });

    await materializeAgentBundleForSession({
      sandbox: sandbox as never,
      sessionId: "ses_p",
      workspaceId: "wsp_p",
      agentId: "agt_personal",
      workdir: "/home/user/workspace",
      personal: true,
    });

    // memory/ and personal-brain/ land at the top level; everything else stays under agent/.
    expect(writtenSandboxFiles(sandbox)).toEqual(
      expect.arrayContaining([
        { path: "/home/user/workspace/memory/notes.md", data: "Memory notes" },
        { path: "/home/user/workspace/personal-brain/idea.md", data: "An idea" },
        { path: "/home/user/workspace/agent/soul.md", data: "Soul" },
      ]),
    );
    expect(db.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestedPath: "memory/notes.md",
          path: "agents/personal-abc/memory/notes.md",
        }),
        expect.objectContaining({
          requestedPath: "personal-brain/idea.md",
          path: "agents/personal-abc/personal-brain/idea.md",
        }),
        expect.objectContaining({
          requestedPath: "agent/soul.md",
          path: "agents/personal-abc/soul.md",
        }),
      ]),
    );
    const commands = sandbox.commands.run.mock.calls.map(([command]) => String(command));
    expect(commands).toEqual([
      "rm -rf '/home/user/workspace/agent' '/home/user/workspace/memory' '/home/user/workspace/personal-brain' && mkdir -p '/home/user/workspace/agent' '/home/user/workspace/memory' '/home/user/workspace/personal-brain'",
    ]);
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "rm -rf '/home/user/workspace/agent' '/home/user/workspace/memory' '/home/user/workspace/personal-brain' && mkdir -p '/home/user/workspace/agent' '/home/user/workspace/memory' '/home/user/workspace/personal-brain'",
      { user: "user", timeoutMs: 30_000 },
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

    const writes = writtenSandboxFiles(sandbox);
    expect(writes).toEqual(
      expect.arrayContaining([{ path: "/home/user/workspace/agent/user.md", data: "" }]),
    );
    // memory.md is no longer auto-created — durable facts live in structured memory.
    expect(writes).not.toEqual(
      expect.arrayContaining([{ path: "/home/user/workspace/agent/memory.md", data: "" }]),
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

  it("drops oversized files loudly while mounting but no longer caps at 80 files", async () => {
    const bundleRows = [
      {
        path: "agents/sales/memory.md",
        content: "Sales memory",
        contentHash: "hash_memory",
        sizeBytes: 12,
      },
      {
        path: "agents/sales/playbooks/oversized.md",
        content: "x".repeat(MAX_AGENT_BUNDLE_FILE_BYTES + 1),
        contentHash: "hash_oversized",
        sizeBytes: MAX_AGENT_BUNDLE_FILE_BYTES + 1,
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

    const writes = writtenSandboxFiles(sandbox);
    expect(writes).toEqual(
      expect.arrayContaining([
        { path: "/home/user/workspace/agent/memory.md", data: "Sales memory" },
        { path: "/home/user/workspace/agent/zz-084.md", data: "File 84" },
      ]),
    );
    expect(writes).not.toEqual(
      expect.arrayContaining([
        { path: "/home/user/workspace/agent/playbooks/oversized.md", data: expect.any(String) },
      ]),
    );
    expect(observabilityMocks.logger.warn).toHaveBeenCalledWith(
      "Agent bundle materialization dropped files over bundle caps",
      expect.objectContaining({
        dropped_count: 1,
        sample_paths: ["agents/sales/playbooks/oversized.md"],
      }),
    );
  });

  it("mounts personal-brain and agent files before memory when the file cap is exceeded", async () => {
    const bundleRows = [
      ...Array.from({ length: 1000 }, (_, index) => ({
        path: `agents/personal-abc/memory/evidence/ev-${String(index).padStart(4, "0")}.md`,
        content: `Evidence ${index}`,
        contentHash: `hash_ev_${index}`,
        sizeBytes: 8,
      })),
      {
        path: "agents/personal-abc/personal-brain/idea.md",
        content: "An idea",
        contentHash: "hash_brain",
        sizeBytes: 7,
      },
      {
        path: "agents/personal-abc/user.md",
        content: "Profile",
        contentHash: "hash_user",
        sizeBytes: 7,
      },
    ];
    const db = createAgentBundleDb({
      selectResults: [[{ path: "agents/personal-abc/personal-abc.agent" }], bundleRows],
    });
    dbMocks.getDb.mockReturnValue(db);
    const sandbox = createSandbox({ commandStdout: "", fileReads: {} });

    await materializeAgentBundleForSession({
      sandbox: sandbox as never,
      sessionId: "ses_p",
      workspaceId: "wsp_p",
      agentId: "agt_personal",
      workdir: "/home/user/workspace",
      personal: true,
    });

    const writes = writtenSandboxFiles(sandbox);
    // personal-brain and the profile beat memory evidence for cap slots; the two
    // alphabetically-last evidence files are the ones dropped.
    expect(writes).toEqual(
      expect.arrayContaining([
        { path: "/home/user/workspace/personal-brain/idea.md", data: "An idea" },
        { path: "/home/user/workspace/agent/user.md", data: "Profile" },
        { path: "/home/user/workspace/memory/evidence/ev-0997.md", data: "Evidence 997" },
      ]),
    );
    expect(writes).not.toEqual(
      expect.arrayContaining([
        { path: "/home/user/workspace/memory/evidence/ev-0998.md", data: expect.any(String) },
        { path: "/home/user/workspace/memory/evidence/ev-0999.md", data: expect.any(String) },
      ]),
    );
    expect(observabilityMocks.logger.warn).toHaveBeenCalledWith(
      "Agent bundle materialization dropped files over bundle caps",
      expect.objectContaining({ dropped_count: 2 }),
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
      commandStdout: `${hashLine("agent/memory.md", "New memory")}\n`,
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
      commandStdout: `${hashLine("agent/playbooks/deep/discovery.md", "Deep discovery")}\n`,
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

  it("drops oversized files loudly but no longer caps at 80 files", async () => {
    const big = "x".repeat(MAX_AGENT_BUNDLE_FILE_BYTES + 1);
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
        [],
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const commandStdout = [
      hashLine("agent/big.md", big),
      ...Array.from({ length: 82 }, (_, index) =>
        hashLine(`agent/file-${String(index).padStart(3, "0")}.md`, `File ${index}`),
      ),
    ].join("\n");
    const sandbox = createSandbox({
      commandStdout: `${commandStdout}\n`,
      fileReads: {
        "/home/user/workspace/agent/big.md": big,
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
          path: "agents/sales/file-079.md",
          content: "File 79",
        }),
        expect.objectContaining({
          path: "agents/sales/file-081.md",
          content: "File 81",
        }),
      ]),
    );
    expect(db.insertedValues).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "agents/sales/big.md" })]),
    );
    expect(observabilityMocks.logger.warn).toHaveBeenCalledWith(
      "Agent bundle sync dropped files over bundle caps",
      expect.objectContaining({
        dropped_count: 1,
        sample_paths: ["agents/sales/big.md"],
      }),
    );
  });

  it("syncs personal-brain writes before memory evidence when the file cap is exceeded", async () => {
    const db = createAgentBundleDb({
      selectResults: [
        [{ path: "agents/personal-abc/personal-abc.agent" }],
        [
          {
            sessionId: "ses_p",
            workspaceId: "wsp_p",
            requestedPath: "memory/seed.md",
            path: "agents/personal-abc/memory/seed.md",
            referenceType: "file",
            baseHash: sha256("Seed"),
            lastSyncedHash: sha256("Seed"),
          },
        ],
        [],
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    // 1 unchanged memory file + 1000 new evidence files + 1 new personal-brain file = 1002
    // bundle files; the cap (1000) forces two drops. Priority ordering must drop the
    // alphabetically-last evidence files, never the personal-brain write.
    const evidence = Array.from({ length: 1000 }, (_, index) => ({
      sandboxPath: `memory/evidence/ev-${String(index).padStart(4, "0")}.md`,
      content: `Evidence ${index}`,
    }));
    const commandStdout = [
      hashLine("memory/seed.md", "Seed"),
      hashLine("personal-brain/manifestation.md", "My manifestation"),
      ...evidence.map((file) => hashLine(file.sandboxPath, file.content)),
    ].join("\n");
    const sandbox = createSandbox({
      commandStdout: `${commandStdout}\n`,
      fileReads: {
        "/home/user/workspace/personal-brain/manifestation.md": "My manifestation",
        ...Object.fromEntries(
          evidence.map((file) => [`/home/user/workspace/${file.sandboxPath}`, file.content]),
        ),
      },
    });

    await syncAgentBundleFromSandbox({
      sandbox: sandbox as never,
      sessionId: "ses_p",
      workspaceId: "wsp_p",
      agentId: "agt_personal",
      workdir: "/home/user/workspace",
      personal: true,
    });

    expect(db.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "agents/personal-abc/personal-brain/manifestation.md",
          content: "My manifestation",
        }),
      ]),
    );
    expect(db.insertedValues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "agents/personal-abc/memory/evidence/ev-0999.md" }),
      ]),
    );
    // The unchanged file is never read back; only changed files cost a sandbox round-trip.
    expect(sandbox.files.read).not.toHaveBeenCalledWith("/home/user/workspace/memory/seed.md");
    expect(observabilityMocks.logger.warn).toHaveBeenCalledWith(
      "Agent bundle sync dropped files over bundle caps",
      expect.objectContaining({
        dropped_count: 2,
        sample_paths: [
          "agents/personal-abc/memory/evidence/ev-0998.md",
          "agents/personal-abc/memory/evidence/ev-0999.md",
        ],
      }),
    );
  });

  it("skips reading files whose in-sandbox hash matches the last synced hash", async () => {
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
            baseHash: sha256("Same memory"),
            lastSyncedHash: sha256("Same memory"),
          },
        ],
        [],
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const sandbox = createSandbox({
      commandStdout: `${hashLine("agent/memory.md", "Same memory")}\n`,
      fileReads: {
        "/home/user/workspace/agent/memory.md": "Same memory",
      },
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
      commandStdout: `${hashLine("agent/memory.md", "Local memory")}\n`,
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
      commandStdout: `${hashLine("agent/../memory.md", "escape attempt")}\n`,
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

  it("captures a version of the prior content before overwriting a personal-brain file", async () => {
    const db = createAgentBundleDb({
      selectResults: [
        [{ path: "agents/sales/sales.agent" }],
        [
          {
            sessionId: "ses_123",
            workspaceId: "wsp_123",
            requestedPath: "agent/notes.md",
            path: "agents/sales/notes.md",
            referenceType: "file",
            baseHash: sha256("Old notes"),
            lastSyncedHash: sha256("Old notes"),
          },
        ],
        [
          {
            path: "agents/sales/notes.md",
            content: "Old notes",
            contentHash: sha256("Old notes"),
            sizeBytes: 9,
          },
        ],
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const sandbox = createSandbox({
      commandStdout: `${hashLine("agent/notes.md", "New notes")}\n`,
      fileReads: {
        "/home/user/workspace/agent/notes.md": "New notes",
      },
    });

    await syncAgentBundleFromSandbox({
      sandbox: sandbox as never,
      sessionId: "ses_123",
      workspaceId: "wsp_123",
      agentId: "agt_sales",
      workdir: "/home/user/workspace",
    });

    // The displaced bytes ("Old notes") are preserved before the row is rewritten.
    expect(db.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "personal",
          agentId: "agt_sales",
          path: "agents/sales/notes.md",
          content: "Old notes",
          operation: "overwrite",
          sessionId: "ses_123",
        }),
      ]),
    );
  });

  it("captures a version of the deleted content before removing a personal-brain file", async () => {
    const db = createAgentBundleDb({
      selectResults: [
        [{ path: "agents/sales/sales.agent" }],
        [
          {
            sessionId: "ses_123",
            workspaceId: "wsp_123",
            requestedPath: "agent/notes.md",
            path: "agents/sales/notes.md",
            referenceType: "file",
            baseHash: sha256("Old notes"),
            lastSyncedHash: sha256("Old notes"),
          },
        ],
        [
          {
            path: "agents/sales/notes.md",
            content: "Old notes",
            contentHash: sha256("Old notes"),
            sizeBytes: 9,
          },
        ],
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    // Empty sandbox listing => the mounted file was removed in-sandbox.
    const sandbox = createSandbox({ commandStdout: "", fileReads: {} });

    await syncAgentBundleFromSandbox({
      sandbox: sandbox as never,
      sessionId: "ses_123",
      workspaceId: "wsp_123",
      agentId: "agt_sales",
      workdir: "/home/user/workspace",
    });

    // Deletion still propagates, but the content is recoverable from a version row.
    expect(db.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "personal",
          agentId: "agt_sales",
          path: "agents/sales/notes.md",
          content: "Old notes",
          operation: "delete",
          sessionId: "ses_123",
        }),
      ]),
    );
  });

  it("surfaces a cap_exceeded event instead of silently dropping an over-cap personal-brain file", async () => {
    const big = "x".repeat(MAX_AGENT_BUNDLE_FILE_BYTES + 1);
    const db = createAgentBundleDb({
      selectResults: [
        [{ path: "agents/sales/sales.agent" }],
        [
          {
            sessionId: "ses_123",
            workspaceId: "wsp_123",
            requestedPath: "agent/huge.md",
            path: "agents/sales/huge.md",
            referenceType: "file",
            baseHash: "hash_x",
            lastSyncedHash: "hash_x",
          },
        ],
        [],
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const sandbox = createSandbox({
      commandStdout: `${hashLine("agent/huge.md", big)}\n`,
      fileReads: { "/home/user/workspace/agent/huge.md": big },
    });

    await syncAgentBundleFromSandbox({
      sandbox: sandbox as never,
      sessionId: "ses_123",
      workspaceId: "wsp_123",
      agentId: "agt_sales",
      workdir: "/home/user/workspace",
    });

    // The drop is announced to the user instead of being a silent logger.warn.
    expect(eventMocks.appendRuntimeEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        sessionId: "ses_123",
        type: "agent_bundle.cap_exceeded",
        payload: expect.objectContaining({
          droppedPaths: ["agents/sales/huge.md"],
          droppedCount: 1,
        }),
      }),
    );
    // And the over-cap file is not persisted.
    expect(db.insertedValues).not.toContainEqual(
      expect.objectContaining({ path: "agents/sales/huge.md" }),
    );
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
