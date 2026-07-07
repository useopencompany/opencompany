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

  it("expands capability ids to their grantable runtime tools, deduped against explicit names", () => {
    const grant = resolveSubagentGrant({
      requestedTools: ["exa", "exa_search", "read_file"],
      enabledTools: ["read_file", "exa_search", "exa_contents", "exa_answer", "web_fetch"],
      personalAgent: false,
    });

    expect(grant).toMatchObject({ ok: true });
    if (!grant.ok) throw new Error(grant.error);
    expect(grant.tools.map((tool) => tool.name)).toEqual([
      "exa_search",
      "exa_contents",
      "exa_answer",
      "web_fetch",
      "read_file",
    ]);
  });

  it("only expands a capability to tools that are enabled and grantable", () => {
    const grant = resolveSubagentGrant({
      requestedTools: ["exa"],
      enabledTools: ["read_file", "exa_search"],
      personalAgent: false,
    });

    expect(grant).toMatchObject({ ok: true });
    if (!grant.ok) throw new Error(grant.error);
    expect(grant.tools.map((tool) => tool.name)).toEqual(["exa_search"]);
  });

  it("rejects dispatcher tools with a targeted correction instead of the grantable list", () => {
    const grant = resolveSubagentGrant({
      requestedTools: ["use_tool"],
      enabledTools: ["read_file", "exa_search"],
      personalAgent: false,
    });

    expect(grant).toMatchObject({ ok: false });
    if (grant.ok) throw new Error("expected failure");
    expect(grant.error).toContain('"use_tool"');
    expect(grant.error).toContain("capability id");
    expect(grant.error).not.toContain("Grantable tools are:");
  });

  it("rejects a capability id whose tools are not grantable here", () => {
    const grant = resolveSubagentGrant({
      requestedTools: ["exa"],
      enabledTools: ["read_file"],
      personalAgent: false,
    });

    expect(grant).toMatchObject({ ok: false });
    if (grant.ok) throw new Error("expected failure");
    expect(grant.error).toContain('"exa"');
    expect(grant.error).toContain("not enabled");
  });

  it("rejects an expansion that exceeds the granted-tool cap", () => {
    const grant = resolveSubagentGrant({
      requestedTools: ["exa", "youtube", "gmail"],
      enabledTools: [
        "exa_search",
        "exa_contents",
        "exa_answer",
        "web_fetch",
        "youtube_search",
        "youtube_get_video",
        "youtube_get_transcript",
        "youtube_get_channel",
        "youtube_list_channel_videos",
        "gmail_list_messages",
        "gmail_get_message",
        "gmail_search",
        "gmail_list_threads",
        "gmail_get_thread",
        "gmail_list_labels",
      ],
      personalAgent: false,
    });

    expect(grant).toMatchObject({ ok: false });
    if (grant.ok) throw new Error("expected failure");
    expect(grant.error).toContain("at most 12 tools");
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
      ],
      personalAgent: false,
    });

    expect(grant).toMatchObject({ ok: true });
    if (!grant.ok) throw new Error(grant.error);
    expect(grant.tools).toHaveLength(12);
  });
});
