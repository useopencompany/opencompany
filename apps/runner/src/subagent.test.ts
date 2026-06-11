import { describe, expect, it } from "vitest";
import { resolveSubagentGrant } from "./subagent";

describe("resolveSubagentGrant", () => {
  it("defaults to read and research tools while excluding write and shell tools", () => {
    const grant = resolveSubagentGrant({
      enabledTools: ["read_file", "list_files", "write_file", "edit_file", "shell", "exa_search"],
      personalAgent: false,
    });

    expect(grant).toMatchObject({ ok: true });
    if (!grant.ok) throw new Error(grant.error);
    expect(grant.tools.map((tool) => tool.name)).toEqual(["read_file", "list_files", "exa_search"]);
  });

  it("rejects never-grantable and unavailable tools with the grantable set", () => {
    const grant = resolveSubagentGrant({
      requestedTools: ["delegate_to_agent", "read_file", "not_a_tool"],
      enabledTools: ["read_file", "delegate_to_agent"],
      personalAgent: false,
    });

    expect(grant).toEqual({
      ok: false,
      error: expect.stringContaining("Cannot grant"),
    });
    if (!grant.ok) {
      expect(grant.error).toContain('"delegate_to_agent"');
      expect(grant.error).toContain('"not_a_tool"');
      expect(grant.error).toContain("read_file");
    }
  });

  it("allows explicit shell grants but leaves policy enforcement to execution", () => {
    const grant = resolveSubagentGrant({
      requestedTools: ["shell"],
      enabledTools: ["shell", "read_file"],
      personalAgent: false,
    });

    expect(grant).toMatchObject({ ok: true });
    if (!grant.ok) throw new Error(grant.error);
    expect(grant.tools.map((tool) => tool.name)).toEqual(["shell"]);
  });

  it("caps the omitted-tools default grant instead of returning an error", () => {
    const grant = resolveSubagentGrant({
      enabledTools: [
        "read_file",
        "list_files",
        "git_diff",
        "recall",
        "fetch_transcript",
        "exa_search",
        "exa_contents",
        "exa_answer",
        "web_fetch",
        "x_search_posts",
        "x_get_profile",
        "x_get_user_posts",
        "x_get_discussion",
        "x_get_trends",
      ],
      personalAgent: false,
    });

    expect(grant).toMatchObject({ ok: true });
    if (!grant.ok) throw new Error(grant.error);
    expect(grant.tools).toHaveLength(12);
  });
});
