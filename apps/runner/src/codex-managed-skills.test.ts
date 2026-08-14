import { describe, expect, it, vi } from "vitest";
import {
  materializeClaudeSkillSnapshotsForSession,
  materializeCodexSkillSnapshotsForSession,
} from "./codex-managed-skills";

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
  return (sandbox.files.write.mock.calls[0]?.[0] as Array<{ path: string; data: string }>).filter(
    ({ path }) => !path.endsWith("/.opencompany-managed-skills.json"),
  );
}

function writtenManifest(sandbox: ReturnType<typeof fakeSandbox>) {
  expect(sandbox.files.write).toHaveBeenCalledTimes(1);
  const writes = sandbox.files.write.mock.calls[0]?.[0] as Array<{ path: string; data: string }>;
  return writes.find(({ path }) => path.endsWith("/.opencompany-managed-skills.json"));
}

describe("materializeCodexSkillSnapshotsForSession", () => {
  it("materializes skill snapshots with supporting files under the managed skills root", async () => {
    const sandbox = fakeSandbox();

    const result = await materializeCodexSkillSnapshotsForSession({
      sandbox: sandbox as never,
      codexWorkRoot: "/home/user/workspace/codex",
      skills: [
        {
          id: "improve-codebase-architecture",
          files: [
            { path: "SKILL.md", content: "skill body" },
            { path: "LANGUAGE.md", content: "secondary" },
          ],
        },
      ],
    });

    expect(result.count).toBe(1);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(writtenSkillFiles(sandbox)).toEqual(
      expect.arrayContaining([
        {
          path: "/home/user/workspace/codex/.agents/skills/improve-codebase-architecture/SKILL.md",
          data: "skill body",
        },
        {
          path: "/home/user/workspace/codex/.agents/skills/improve-codebase-architecture/LANGUAGE.md",
          data: "secondary",
        },
      ]),
    );
    expect(writtenManifest(sandbox)).toEqual({
      path: "/home/user/workspace/codex/.agents/skills/.opencompany-managed-skills.json",
      data: JSON.stringify({ version: 1, skillIds: ["improve-codebase-architecture"] }, null, 2),
    });
    const commands = sandbox.commands.run.mock.calls.map(([command]) => String(command));
    expect(commands[0]).toContain("mkdir -p");
    expect(commands[0]).toContain("/home/user/workspace/codex/.agents/skills");
    expect(commands[1]).toContain("rm -rf");
    expect(commands[1]).toContain(
      "/home/user/workspace/codex/.agents/skills/improve-codebase-architecture",
    );
    expect(commands.some((command) => command.includes("chmod 444"))).toBe(true);
  });

  it("writes an empty manifest without removing anything when no skills are enabled", async () => {
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
    expect(commands[0]).toContain("mkdir -p");
    expect(commands.some((command) => command.includes("rm -rf"))).toBe(false);
    expect(commands).toHaveLength(3);
  });

  it("reconciles only opencompany-managed Codex skill ids from the manifest", async () => {
    const sandbox = fakeSandbox();
    sandbox.files.read.mockResolvedValue(
      JSON.stringify({ version: 1, skillIds: ["old-managed", "brand-voice"] }),
    );

    await materializeCodexSkillSnapshotsForSession({
      sandbox: sandbox as never,
      codexWorkRoot: "/home/user/workspace/codex",
      skills: [{ id: "brand-voice", files: [{ path: "SKILL.md", content: "Body." }] }],
    });

    const commands = sandbox.commands.run.mock.calls.map(([command]) => String(command));
    expect(commands[1]).toContain("/home/user/workspace/codex/.agents/skills/old-managed");
    expect(commands[1]).toContain("/home/user/workspace/codex/.agents/skills/brand-voice");
    expect(commands[1]).not.toContain(
      "/home/user/workspace/codex/.agents/skills/native-user-skill",
    );
    expect(commands[1]).not.toContain("rm -rf '/home/user/workspace/codex/.agents/skills' &&");
  });

  it("returns a different fingerprint when materialized skill contents change", async () => {
    const first = await materializeCodexSkillSnapshotsForSession({
      sandbox: fakeSandbox() as never,
      codexWorkRoot: "/home/user/workspace/codex",
      skills: [{ id: "brand-voice", files: [{ path: "SKILL.md", content: "Body." }] }],
    });
    const second = await materializeCodexSkillSnapshotsForSession({
      sandbox: fakeSandbox() as never,
      codexWorkRoot: "/home/user/workspace/codex",
      skills: [{ id: "brand-voice", files: [{ path: "SKILL.md", content: "Updated body." }] }],
    });

    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("rejects unsafe skill ids before touching the sandbox", async () => {
    const sandbox = fakeSandbox();

    await expect(
      materializeCodexSkillSnapshotsForSession({
        sandbox: sandbox as never,
        codexWorkRoot: "/home/user/workspace/codex",
        skills: [{ id: "../escape", files: [{ path: "SKILL.md", content: "Body." }] }],
      }),
    ).rejects.toThrow("Cannot materialize Codex skill with unsafe id: ../escape");
    expect(sandbox.commands.run).not.toHaveBeenCalled();
    expect(sandbox.files.write).not.toHaveBeenCalled();
  });
});

describe("materializeClaudeSkillSnapshotsForSession", () => {
  it("materializes snapshots where Claude Code scans project skills", async () => {
    const sandbox = fakeSandbox();

    const result = await materializeClaudeSkillSnapshotsForSession({
      sandbox: sandbox as never,
      claudeWorkRoot: "/home/user/opencompany-goat/claude-chat",
      skills: [
        {
          id: "product-work",
          files: [{ path: "SKILL.md", content: "product instructions" }],
        },
      ],
    });

    expect(result.count).toBe(1);
    expect(writtenSkillFiles(sandbox)).toEqual([
      {
        path: "/home/user/opencompany-goat/claude-chat/.claude/skills/product-work/SKILL.md",
        data: "product instructions",
      },
    ]);
    expect(writtenManifest(sandbox)).toEqual({
      path: "/home/user/opencompany-goat/claude-chat/.claude/skills/.opencompany-managed-skills.json",
      data: JSON.stringify({ version: 1, skillIds: ["product-work"] }, null, 2),
    });
  });
});
