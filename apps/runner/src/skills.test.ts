import { AGENT_SELF_EDIT_SKILL_ID } from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { materializeSkillsForSession } from "./skills";

describe("materializeSkillsForSession", () => {
  it("writes enabled skill files read-only under ./skills as root", async () => {
    const sandbox = {
      commands: { run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }) },
      files: { write: vi.fn().mockResolvedValue(undefined) },
    };

    await materializeSkillsForSession({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace",
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
});
