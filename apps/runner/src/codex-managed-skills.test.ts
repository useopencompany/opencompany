import { describe, expect, it, vi } from "vitest";
import {
  materializeClaudeSkillSnapshotsForSession,
  materializeCodexSkillSnapshotsForSession,
} from "./codex-managed-skills";

const encoder = new TextEncoder();

function bytes(value: string) {
  return encoder.encode(value);
}

function fakeSandbox() {
  return {
    commands: { run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }) },
    files: {
      read: vi.fn().mockRejectedValue(new Error("missing")),
      write: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function writtenSkillFiles(sandbox: ReturnType<typeof fakeSandbox>) {
  expect(sandbox.files.write).toHaveBeenCalledTimes(1);
  expect(sandbox.files.write).toHaveBeenCalledWith(expect.any(Array), { user: "root" });
  const writes = sandbox.files.write.mock.calls[0]?.[0] as Array<{
    path: string;
    data: string | ArrayBuffer;
  }>;
  return writes
    .filter(({ path }) => !path.endsWith("/.opencompany-managed-skills.json"))
    .map(({ path, data }) => ({
      path,
      data: typeof data === "string" ? bytes(data) : new Uint8Array(data),
    }));
}

function writtenManifest(sandbox: ReturnType<typeof fakeSandbox>) {
  expect(sandbox.files.write).toHaveBeenCalledTimes(1);
  const writes = sandbox.files.write.mock.calls[0]?.[0] as Array<{
    path: string;
    data: string | ArrayBuffer;
  }>;
  return writes.find(({ path }) => path.endsWith("/.opencompany-managed-skills.json"));
}

describe("materializeCodexSkillSnapshotsForSession", () => {
  it("materializes every raw byte and exact executable mode under the declared Skill name", async () => {
    const sandbox = fakeSandbox();
    const exactSkillDocument = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...bytes("---\r\nname: byte-golden\r\ndescription: Exact bytes.\r\n---\r\nBody"),
    ]);
    const invalidUtf8 = Uint8Array.of(0, 255, 254, 128, 1);

    const result = await materializeCodexSkillSnapshotsForSession({
      sandbox: sandbox as never,
      codexWorkRoot: "/home/user/workspace/codex",
      skills: [
        {
          name: "byte-golden",
          files: [
            { path: "SKILL.md", content: exactSkillDocument, executable: false },
            { path: "references/invalid.bin", content: invalidUtf8, executable: false },
            { path: "scripts/run.sh", content: bytes("#!/bin/sh\r\nprintf ok"), executable: true },
            { path: "empty.txt", content: new Uint8Array(), executable: false },
          ],
        },
      ],
    });

    expect(result.count).toBe(1);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(writtenSkillFiles(sandbox)).toEqual([
      {
        path: "/home/user/workspace/codex/.agents/skills/byte-golden/SKILL.md",
        data: exactSkillDocument,
      },
      {
        path: "/home/user/workspace/codex/.agents/skills/byte-golden/references/invalid.bin",
        data: invalidUtf8,
      },
      {
        path: "/home/user/workspace/codex/.agents/skills/byte-golden/scripts/run.sh",
        data: bytes("#!/bin/sh\r\nprintf ok"),
      },
      {
        path: "/home/user/workspace/codex/.agents/skills/byte-golden/empty.txt",
        data: new Uint8Array(),
      },
    ]);
    expect(writtenManifest(sandbox)).toEqual({
      path: "/home/user/workspace/codex/.agents/skills/.opencompany-managed-skills.json",
      data: JSON.stringify({ version: 1, skillIds: ["byte-golden"] }, null, 2),
    });
    const commands = sandbox.commands.run.mock.calls.map(([command]) => String(command));
    expect(commands[0]).toContain(
      "test \"$(realpath -m -- '/home/user/workspace/codex/.agents')\" = '/home/user/workspace/codex/.agents'",
    );
    expect(commands[0]).toContain("test ! -L '/home/user/workspace/codex/.agents'");
    expect(commands[0]!.indexOf("realpath -m")).toBeLessThan(commands[0]!.indexOf("mkdir -p"));
    expect(commands[0]).toContain("mkdir -p");
    expect(commands[0]).toContain("/home/user/workspace/codex/.agents/skills");
    expect(commands[0]).toContain("rm -rf");
    expect(commands[0]).toContain("/home/user/workspace/codex/.agents/skills/byte-golden");
    expect(commands.some((command) => command.includes("-type f -exec chmod 444"))).toBe(true);
    expect(
      commands.some(
        (command) => command.includes("chmod 555") && command.includes("scripts/run.sh"),
      ),
    ).toBe(true);
    expect(commands.at(-1)).toContain("chmod 555 '/home/user/workspace/codex/.agents/skills'");
  });

  it("writes and locks an empty managed parent when no Skills are active", async () => {
    const sandbox = fakeSandbox();

    const result = await materializeCodexSkillSnapshotsForSession({
      sandbox: sandbox as never,
      codexWorkRoot: "/home/user/workspace/codex",
      skills: [],
    });

    expect(result.count).toBe(0);
    expect(writtenSkillFiles(sandbox)).toEqual([]);
    expect(writtenManifest(sandbox)).toEqual({
      path: "/home/user/workspace/codex/.agents/skills/.opencompany-managed-skills.json",
      data: JSON.stringify({ version: 1, skillIds: [] }, null, 2),
    });
    const commands = sandbox.commands.run.mock.calls.map(([command]) => String(command));
    expect(commands.some((command) => command.includes("rm -rf"))).toBe(false);
    expect(commands.at(-1)).toContain("chmod 555 '/home/user/workspace/codex/.agents/skills'");
    expect(commands).toHaveLength(4);
  });

  it("reconciles only opencompany-managed Skill names from the manifest", async () => {
    const sandbox = fakeSandbox();
    sandbox.files.read.mockResolvedValue(
      JSON.stringify({ version: 1, skillIds: ["old-managed", "brand-voice"] }),
    );

    await materializeCodexSkillSnapshotsForSession({
      sandbox: sandbox as never,
      codexWorkRoot: "/home/user/workspace/codex",
      skills: [
        {
          name: "brand-voice",
          files: [{ path: "SKILL.md", content: bytes("Body."), executable: false }],
        },
      ],
    });

    const commands = sandbox.commands.run.mock.calls.map(([command]) => String(command));
    expect(commands[0]).toContain("/home/user/workspace/codex/.agents/skills/old-managed");
    expect(commands[0]).toContain("/home/user/workspace/codex/.agents/skills/brand-voice");
    expect(commands[0]).not.toContain(
      "/home/user/workspace/codex/.agents/skills/native-user-skill",
    );
    expect(commands[0]).not.toContain("rm -rf '/home/user/workspace/codex/.agents/skills' &&");
  });

  it("fingerprints raw contents and executable modes", async () => {
    const materialize = (content: Uint8Array, executable: boolean) =>
      materializeCodexSkillSnapshotsForSession({
        sandbox: fakeSandbox() as never,
        codexWorkRoot: "/home/user/workspace/codex",
        skills: [
          {
            name: "brand-voice",
            files: [{ path: "SKILL.md", content, executable }],
          },
        ],
      });
    const first = await materialize(bytes("Body."), false);
    const changedBytes = await materialize(Uint8Array.of(...bytes("Body."), 0), false);
    const changedMode = await materialize(bytes("Body."), true);

    expect(first.fingerprint).not.toBe(changedBytes.fingerprint);
    expect(first.fingerprint).not.toBe(changedMode.fingerprint);
  });

  it.each([
    "../escape",
    "/absolute",
    "nested/../../escape",
    "nested\\escape",
  ])("rejects unsafe stored path %s before touching the sandbox", async (unsafePath) => {
    const sandbox = fakeSandbox();

    await expect(
      materializeCodexSkillSnapshotsForSession({
        sandbox: sandbox as never,
        codexWorkRoot: "/home/user/workspace/codex",
        skills: [
          {
            name: "safe-skill",
            files: [{ path: unsafePath, content: bytes("Body."), executable: false }],
          },
        ],
      }),
    ).rejects.toThrow("Cannot materialize Skill file with unsafe path");
    expect(sandbox.commands.run).not.toHaveBeenCalled();
    expect(sandbox.files.write).not.toHaveBeenCalled();
  });

  it("rejects unsafe Skill names before touching the sandbox", async () => {
    const sandbox = fakeSandbox();

    await expect(
      materializeCodexSkillSnapshotsForSession({
        sandbox: sandbox as never,
        codexWorkRoot: "/home/user/workspace/codex",
        skills: [
          {
            name: "../escape",
            files: [{ path: "SKILL.md", content: bytes("Body."), executable: false }],
          },
        ],
      }),
    ).rejects.toThrow("Cannot materialize Skill with unsafe name: ../escape");
    expect(sandbox.commands.run).not.toHaveBeenCalled();
    expect(sandbox.files.write).not.toHaveBeenCalled();
  });
});

describe("materializeClaudeSkillSnapshotsForSession", () => {
  it("materializes raw bundles where Claude Code scans project Skills", async () => {
    const sandbox = fakeSandbox();
    const document = bytes("exact content without a trailing newline");

    const result = await materializeClaudeSkillSnapshotsForSession({
      sandbox: sandbox as never,
      claudeWorkRoot: "/home/user/opencompany-goat/claude-chat",
      skills: [
        {
          name: "product-work",
          files: [{ path: "SKILL.md", content: document, executable: false }],
        },
      ],
    });

    expect(result.count).toBe(1);
    expect(writtenSkillFiles(sandbox)).toEqual([
      {
        path: "/home/user/opencompany-goat/claude-chat/.claude/skills/product-work/SKILL.md",
        data: document,
      },
    ]);
    expect(writtenManifest(sandbox)).toEqual({
      path: "/home/user/opencompany-goat/claude-chat/.claude/skills/.opencompany-managed-skills.json",
      data: JSON.stringify({ version: 1, skillIds: ["product-work"] }, null, 2),
    });
  });
});
