import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: dbMocks.getDb,
}));

import { materializeBrainForSession } from "./brain";

afterEach(() => {
  vi.resetAllMocks();
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
