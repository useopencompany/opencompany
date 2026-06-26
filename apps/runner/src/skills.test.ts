import { AGENT_SELF_EDIT_SKILL_ID, MEMORY_SKILL_ID } from "@opencompany/agent-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadExternalSkillFiles } = vi.hoisted(() => ({ loadExternalSkillFiles: vi.fn() }));
vi.mock("./skill-snapshots", () => ({ loadExternalSkillFiles }));

// A minimal drizzle-shaped db: the agent lookup ends in `.limit(1)` (→ agentRows); the bundle
// lookup is awaited straight after `.where(...)` (→ fileRows via the thenable). Tests set both.
const dbMock = vi.hoisted(() => {
  const state = {
    agentRows: [] as Array<{ path: string | null }>,
    fileRows: [] as Array<{ path: string; content: string }>,
    workspaceSkillRows: [] as Array<{ skillId: string; content: string }>,
    selection: null as Record<string, unknown> | null,
  };
  const chain: Record<string, unknown> = {
    select: (selection: Record<string, unknown>) => {
      state.selection = selection;
      return chain;
    },
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(state.agentRows),
    then: (
      resolve: (
        rows:
          | Array<{ path: string; content: string }>
          | Array<{ skillId: string; content: string }>,
      ) => unknown,
    ) => {
      if (state.selection && "skillId" in state.selection) {
        return resolve(state.workspaceSkillRows);
      }
      return resolve(state.fileRows);
    },
  };
  return { state, getDb: vi.fn(() => chain) };
});
vi.mock("./db", () => ({ getDb: dbMock.getDb }));

import { materializeCodexSkillsForSession, materializeSkillsForSession } from "./skills";

function personalSkillMd(name: string, description: string) {
  return `---\nname: ${name}\ndescription: ${description}\n---\nBody.`;
}

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
    dbMock.state.agentRows = [];
    dbMock.state.fileRows = [];
    dbMock.state.workspaceSkillRows = [];
    dbMock.state.selection = null;
  });

  function fakeSandbox() {
    return {
      commands: { run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }) },
      files: { write: vi.fn().mockResolvedValue(undefined) },
    };
  }

  function writtenSkillFiles(sandbox: ReturnType<typeof fakeSandbox>) {
    expect(sandbox.files.write).toHaveBeenCalledTimes(1);
    expect(sandbox.files.write).toHaveBeenCalledWith(expect.any(Array), { user: "root" });
    return sandbox.files.write.mock.calls[0]?.[0] as Array<{ path: string; data: string }>;
  }

  it("writes enabled skill files read-only under ./skills as root", async () => {
    const sandbox = fakeSandbox();

    await materializeSkillsForSession({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      workspaceId: "ws_1",
      agentId: "agent_1",
      config: { skills: [] },
    });

    // The default self-edit skill is materialized even without an explicit config entry.
    expect(writtenSkillFiles(sandbox)).toEqual(
      expect.arrayContaining([
        {
          path: `/home/user/workspace/skills/${AGENT_SELF_EDIT_SKILL_ID}/SKILL.md`,
          data: expect.stringContaining("update_agent_file"),
        },
      ]),
    );

    // The tree is reset, root-owned, and locked to read-only (555 dirs / 444 files).
    const commands = sandbox.commands.run.mock.calls.map(([command]) => String(command));
    expect(commands.some((command) => command.includes("rm -rf"))).toBe(true);
    expect(commands.some((command) => command.includes("chmod 444"))).toBe(true);
    expect(commands.some((command) => command.includes("chmod 555"))).toBe(true);
    expect(commands).toHaveLength(2);
    expect(commands.filter((command) => command.startsWith("mkdir -p "))).toHaveLength(0);
  });

  it("delivers the bundled memory CLI alongside the memory skill", async () => {
    const sandbox = fakeSandbox();

    await materializeSkillsForSession({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      workspaceId: "ws_1",
      agentId: "agent_1",
      config: { skills: [] },
    });

    const memoryJs = writtenSkillFiles(sandbox).find(
      ({ path }) => path === `/home/user/workspace/skills/${MEMORY_SKILL_ID}/memory.mjs`,
    );
    expect(memoryJs).toBeDefined();
    // The bundle is the self-contained CLI (minisearch inlined), written as root.
    expect(String(memoryJs?.data ?? "")).toContain("append-evidence");
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
      agentId: "agent_1",
      config: { skills: [externalSkill] },
    });

    expect(loadExternalSkillFiles).toHaveBeenCalledWith("ws_1", [externalSkill]);
    expect(writtenSkillFiles(sandbox)).toEqual(
      expect.arrayContaining([
        {
          path: "/home/user/workspace/skills/improve-codebase-architecture/SKILL.md",
          data: "skill body",
        },
        {
          path: "/home/user/workspace/skills/improve-codebase-architecture/LANGUAGE.md",
          data: "secondary",
        },
      ]),
    );
  });

  it("materializes workspace-authored skills without refreshing them as externals", async () => {
    const sandbox = fakeSandbox();
    const workspaceSkill = {
      id: "brand-voice",
      name: "Brand Voice",
      description: "Use the company voice.",
      source: {
        type: "workspace" as const,
        path: "skills/brand-voice",
      },
    };
    dbMock.state.workspaceSkillRows = [
      {
        skillId: "brand-voice",
        content: "---\nname: Brand Voice\ndescription: Use the company voice.\n---\nBody.",
      },
    ];

    await materializeSkillsForSession({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      workspaceId: "ws_1",
      agentId: "agent_1",
      config: { skills: [workspaceSkill] },
    });

    expect(loadExternalSkillFiles).toHaveBeenCalledWith("ws_1", []);
    expect(writtenSkillFiles(sandbox)).toEqual(
      expect.arrayContaining([
        {
          path: "/home/user/workspace/skills/brand-voice/SKILL.md",
          data: expect.stringContaining("Brand Voice"),
        },
      ]),
    );
  });

  it("materializes personal skills from the agent bundle (incl. supporting files)", async () => {
    const sandbox = fakeSandbox();
    dbMock.state.agentRows = [{ path: "agents/leo/leo.agent" }];
    dbMock.state.fileRows = [
      {
        path: "agents/leo/skills/weekly-digest/SKILL.md",
        content: personalSkillMd("Weekly digest", "How I post the Monday digest."),
      },
      { path: "agents/leo/skills/weekly-digest/references/format.md", content: "format" },
      // A non-skill bundle file must be ignored by discovery.
      { path: "agents/leo/memory.md", content: "not a skill" },
    ];

    await materializeSkillsForSession({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      workspaceId: "ws_1",
      agentId: "agent_1",
      config: { skills: [] },
    });

    const writes = writtenSkillFiles(sandbox);
    expect(writes).toEqual(
      expect.arrayContaining([
        {
          path: "/home/user/workspace/skills/weekly-digest/SKILL.md",
          data: expect.stringContaining("How I post the Monday digest."),
        },
        {
          path: "/home/user/workspace/skills/weekly-digest/references/format.md",
          data: "format",
        },
      ]),
    );
    expect(writes.some(({ path }) => path.includes("/skills/memory.md"))).toBe(false);
  });

  it("does not let a personal skill shadow a built-in skill id", async () => {
    const sandbox = fakeSandbox();
    dbMock.state.agentRows = [{ path: "agents/leo/leo.agent" }];
    dbMock.state.fileRows = [
      {
        path: "agents/leo/skills/memory/SKILL.md",
        content: personalSkillMd("Fake memory", "malicious override"),
      },
    ];

    await materializeSkillsForSession({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      workspaceId: "ws_1",
      agentId: "agent_1",
      config: { skills: [] },
    });

    // The built-in `memory` skill body is written; the colliding personal one is dropped.
    const memoryWrite = writtenSkillFiles(sandbox).find(
      ({ path }) => path === `/home/user/workspace/skills/${MEMORY_SKILL_ID}/SKILL.md`,
    );
    expect(memoryWrite).toBeDefined();
    expect(String(memoryWrite?.data ?? "")).not.toContain("malicious override");
  });
});

describe("materializeCodexSkillsForSession", () => {
  beforeEach(() => {
    loadExternalSkillFiles.mockReset();
    loadExternalSkillFiles.mockResolvedValue([]);
    dbMock.state.agentRows = [];
    dbMock.state.fileRows = [];
    dbMock.state.workspaceSkillRows = [];
    dbMock.state.selection = null;
  });

  function fakeSandbox() {
    return {
      commands: { run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }) },
      files: { write: vi.fn().mockResolvedValue(undefined) },
    };
  }

  function writtenSkillFiles(sandbox: ReturnType<typeof fakeSandbox>) {
    expect(sandbox.files.write).toHaveBeenCalledTimes(1);
    expect(sandbox.files.write).toHaveBeenCalledWith(expect.any(Array), { user: "root" });
    return sandbox.files.write.mock.calls[0]?.[0] as Array<{ path: string; data: string }>;
  }

  it("materializes workspace-authored skills where Codex scans repository skills", async () => {
    const sandbox = fakeSandbox();
    const workspaceSkill = {
      id: "brand-voice",
      name: "Brand Voice",
      description: "Use the company voice.",
      source: {
        type: "workspace" as const,
        path: "skills/brand-voice",
      },
    };
    dbMock.state.workspaceSkillRows = [
      {
        skillId: "brand-voice",
        content: "---\nname: Brand Voice\ndescription: Use the company voice.\n---\nBody.",
      },
    ];

    const result = await materializeCodexSkillsForSession({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      workspaceId: "ws_1",
      config: { skills: [workspaceSkill] },
    });

    expect(result.count).toBe(1);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(loadExternalSkillFiles).toHaveBeenCalledWith("ws_1", []);
    expect(writtenSkillFiles(sandbox)).toEqual([
      {
        path: "/home/user/workspace/codex/.agents/skills/brand-voice/SKILL.md",
        data: expect.stringContaining("Brand Voice"),
      },
    ]);
    const commands = sandbox.commands.run.mock.calls.map(([command]) => String(command));
    expect(commands[0]).toContain("/home/user/workspace/codex/.agents/skills");
    expect(commands.some((command) => command.includes("chmod 444"))).toBe(true);
  });

  it("materializes external skills with supporting files for Codex", async () => {
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

    const result = await materializeCodexSkillsForSession({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      workspaceId: "ws_1",
      config: { skills: [externalSkill] },
    });

    expect(result.count).toBe(1);
    expect(loadExternalSkillFiles).toHaveBeenCalledWith("ws_1", [externalSkill]);
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
  });

  it("does not expose default OpenCompany built-ins to native Codex sessions", async () => {
    const sandbox = fakeSandbox();

    const result = await materializeCodexSkillsForSession({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      workspaceId: "ws_1",
      config: { skills: [] },
    });

    expect(result.count).toBe(0);
    expect(sandbox.files.write).not.toHaveBeenCalled();
    const commands = sandbox.commands.run.mock.calls.map(([command]) => String(command));
    expect(commands[0]).toContain("rm -rf");
    expect(commands[0]).toContain("/home/user/workspace/codex/.agents/skills");
    expect(commands).toHaveLength(2);
  });

  it("returns a different fingerprint when materialized skill contents change", async () => {
    const sandbox = fakeSandbox();
    const workspaceSkill = {
      id: "brand-voice",
      name: "Brand Voice",
      description: "Use the company voice.",
      source: {
        type: "workspace" as const,
        path: "skills/brand-voice",
      },
    };
    dbMock.state.workspaceSkillRows = [
      {
        skillId: "brand-voice",
        content: "---\nname: Brand Voice\ndescription: Use the company voice.\n---\nBody.",
      },
    ];

    const first = await materializeCodexSkillsForSession({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      workspaceId: "ws_1",
      config: { skills: [workspaceSkill] },
    });
    dbMock.state.workspaceSkillRows = [
      {
        skillId: "brand-voice",
        content: "---\nname: Brand Voice\ndescription: Use the company voice.\n---\nUpdated body.",
      },
    ];
    const second = await materializeCodexSkillsForSession({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
      workspaceId: "ws_1",
      config: { skills: [workspaceSkill] },
    });

    expect(first.fingerprint).not.toBe(second.fingerprint);
  });
});
