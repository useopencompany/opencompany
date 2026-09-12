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
    commands: {
      // The fingerprint probe (the only command using stat) must fail like a missing marker
      // would, so the suite keeps exercising the full reconcile path by default.
      run: vi.fn().mockImplementation(async (command: string) => {
        if (String(command).includes("stat -c")) throw new Error("marker missing");
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    },
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
    const [probe, reset, ...rest] = sandbox.commands.run.mock.calls.map(([command]) =>
      String(command),
    );
    expect(probe).toContain("stat -c");
    expect(reset).toContain(
      "test \"$(realpath -m -- '/home/user/workspace/codex/.agents')\" = '/home/user/workspace/codex/.agents'",
    );
    expect(reset).toContain("test ! -L '/home/user/workspace/codex/.agents'");
    expect(reset!.indexOf("realpath -m")).toBeLessThan(reset!.indexOf("mkdir -p"));
    expect(reset).toContain("mkdir -p");
    expect(reset).toContain("/home/user/workspace/codex/.agents/skills");
    expect(reset).toContain("rm -rf");
    expect(reset).toContain("/home/user/workspace/codex/.agents/skills/byte-golden");
    // The completion marker is invalidated before the first destructive step so a crash
    // mid-reconcile can never leave a sealed marker over a partial tree.
    expect(reset!.indexOf(".opencompany-managed-skills.json.sha256")).toBeGreaterThan(-1);
    expect(reset!.indexOf("rm -f")).toBeLessThan(reset!.indexOf("rm -rf"));
    expect(rest.some((command) => command.includes("-type f -exec chmod 444"))).toBe(true);
    expect(
      rest.some((command) => command.includes("chmod 555") && command.includes("scripts/run.sh")),
    ).toBe(true);
    expect(rest.at(-2)).toContain("chmod 555 '/home/user/workspace/codex/.agents/skills'");
    // Sealing runs strictly after the tree is locked read-only.
    expect(rest.at(-1)).toContain(
      "chmod 444 '/home/user/workspace/codex/.agents/skills/.opencompany-managed-skills.json.sha256'",
    );
    expect(rest.at(-1)).toContain(`printf '%s' '${result.fingerprint}'`);
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
    expect(commands.at(-2)).toContain("chmod 555 '/home/user/workspace/codex/.agents/skills'");
    expect(commands.at(-1)).toContain("chmod 444");
    expect(commands).toHaveLength(6);
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
    expect(commands[1]).toContain("/home/user/workspace/codex/.agents/skills/old-managed");
    expect(commands[1]).toContain("/home/user/workspace/codex/.agents/skills/brand-voice");
    expect(commands[1]).not.toContain(
      "/home/user/workspace/codex/.agents/skills/native-user-skill",
    );
    expect(commands[1]).not.toContain("rm -rf '/home/user/workspace/codex/.agents/skills' &&");
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

  it.each(["../escape", "/absolute", "nested/../../escape", "nested\\escape"])(
    "rejects unsafe stored path %s before touching the sandbox",
    async (unsafePath) => {
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
    },
  );

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

describe("managed skill tree fingerprint skip", () => {
  const skills = [
    {
      name: "brand-voice",
      files: [{ path: "SKILL.md", content: bytes("Body."), executable: false }],
    },
  ];

  it("skips the rewrite when the sealed marker matches the desired fingerprint", async () => {
    const sandbox = fakeSandbox();
    sandbox.commands.run.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    const result = await materializeCodexSkillSnapshotsForSession({
      sandbox: sandbox as never,
      codexWorkRoot: "/home/user/workspace/codex",
      skills,
    });

    expect(result.skipped).toBe(true);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(sandbox.files.write).not.toHaveBeenCalled();
    expect(sandbox.files.read).not.toHaveBeenCalled();
    expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
    const probe = String(sandbox.commands.run.mock.calls[0]?.[0]);
    expect(probe).toContain("test ! -L '/home/user/workspace/codex/.agents'");
    expect(probe).toContain(
      "'/home/user/workspace/codex/.agents/skills/.opencompany-managed-skills.json.sha256'",
    );
    expect(probe).toContain('test "$(stat -c %u:%g:%a --');
    expect(probe).toContain('= "0:0:444"');
    expect(probe).toContain(`= '${result.fingerprint}'`);
    expect(sandbox.commands.run).toHaveBeenCalledWith(expect.any(String), {
      user: "root",
      timeoutMs: 30_000,
    });
  });

  it("rebuilds and reseals when the marker probe fails", async () => {
    const sandbox = fakeSandbox();

    const result = await materializeCodexSkillSnapshotsForSession({
      sandbox: sandbox as never,
      codexWorkRoot: "/home/user/workspace/codex",
      skills,
    });

    expect(result.skipped).toBe(false);
    expect(sandbox.files.write).toHaveBeenCalledTimes(1);
    const commands = sandbox.commands.run.mock.calls.map(([command]) => String(command));
    expect(commands.at(-1)).toContain(`printf '%s' '${result.fingerprint}'`);
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
