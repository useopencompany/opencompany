import { AGENT_SELF_EDIT_SKILL_ID, MEMORY_SKILL_ID } from "@opencompany/agent-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadExternalSkillFiles } = vi.hoisted(() => ({ loadExternalSkillFiles: vi.fn() }));
vi.mock("./skill-snapshots", () => ({ loadExternalSkillFiles }));

import { materializeSkillsForSession } from "./skills";

const externalSkill = {
  id: "improve-codebase-architecture",
  name: "Improve Codebase Architecture",
  description: "x",
  source: {
    type: "github" as const,
    url: "https://github.com/mattpocock/skills",
    ref: "main",
    path: "skills/improve-codebase-architecture",
  },
};

describe("materializeSkillsForSession", () => {
  beforeEach(() => {
    loadExternalSkillFiles.mockReset();
    loadExternalSkillFiles.mockResolvedValue([]);
  });

  function fakeSandbox() {
    return {
      commands: { run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }) },
      files: { write: vi.fn().mockResolvedValue(undefined) },
    };
  }

  it("writes enabled skill files read-only under ./skills as root", async () => {
    const sandbox = fakeSandbox();

    await materializeSkillsForSession({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      workspaceId: "ws_1",
      config: { skills: [] },
    });

    // The default self-edit skill is materialized even without an explicit config entry.
    expect(sandbox.files.write).toHaveBeenCalledWith(
      `/home/user/workspace/skills/${AGENT_SELF_EDIT_SKILL_ID}/SKILL.md`,
      expect.stringContaining("update_agent_file"),
      { user: "root" },
    );

    // The tree is reset, root-owned, and locked to read-only (555 dirs / 444 files).
    const commands = sandbox.commands.run.mock.calls.map(([command]) => String(command));
    expect(commands.some((command) => command.includes("rm -rf"))).toBe(true);
    expect(commands.some((command) => command.includes("chmod 444"))).toBe(true);
    expect(commands.some((command) => command.includes("chmod 555"))).toBe(true);
  });

  it("delivers the bundled memory CLI alongside the memory skill", async () => {
    const sandbox = fakeSandbox();

    await materializeSkillsForSession({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      workspaceId: "ws_1",
      config: { skills: [] },
    });

    const memoryJs = sandbox.files.write.mock.calls.find(
      ([path]) => path === `/home/user/workspace/skills/${MEMORY_SKILL_ID}/memory.js`,
    );
    expect(memoryJs).toBeDefined();
    // The bundle is the self-contained CLI (minisearch inlined), written as root.
    expect(String(memoryJs?.[1] ?? "")).toContain("append-evidence");
    expect(memoryJs?.[2]).toEqual({ user: "root" });
  });

  it("materializes external skill files (incl. secondary files) alongside built-ins", async () => {
    const sandbox = fakeSandbox();
    loadExternalSkillFiles.mockResolvedValue([
      {
        id: "improve-codebase-architecture",
        files: [
          { path: "SKILL.md", content: "skill body" },
          { path: "LANGUAGE.md", content: "secondary" },
        ],
      },
    ]);

    await materializeSkillsForSession({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      workspaceId: "ws_1",
      config: { skills: [externalSkill] },
    });

    expect(loadExternalSkillFiles).toHaveBeenCalledWith("ws_1", [externalSkill]);
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/skills/improve-codebase-architecture/SKILL.md",
      "skill body",
      { user: "root" },
    );
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/skills/improve-codebase-architecture/LANGUAGE.md",
      "secondary",
      { user: "root" },
    );
  });
});
