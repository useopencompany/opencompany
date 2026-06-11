import { describe, expect, it } from "vitest";
import { formatTranscriptLines, transcriptAccessAllowed } from "./fetch-transcript-tool";

const caller = {
  workspaceId: "ws_1",
  userId: "user_1",
  agentId: "agent_personal",
  parentSessionId: "ses_parent",
};

describe("transcriptAccessAllowed", () => {
  it("allows the memory-keeper to read its spawned parent across agent ids", () => {
    // The memory-keeper runs under the personal agent id, but its parent session may be the same
    // agent; the parentSessionId match is what authorizes reading a session it did not itself own.
    const target = { workspaceId: "ws_1", userId: "user_1", agentId: "agent_other" };
    expect(transcriptAccessAllowed(caller, target, "ses_parent")).toBe(true);
  });

  it("allows a live agent to read its own past session (same agent id)", () => {
    const target = { workspaceId: "ws_1", userId: "user_1", agentId: "agent_personal" };
    expect(transcriptAccessAllowed(caller, target, "ses_other")).toBe(true);
  });

  it("denies a different agent's session that is not the caller's parent", () => {
    const target = { workspaceId: "ws_1", userId: "user_1", agentId: "agent_other" };
    expect(transcriptAccessAllowed(caller, target, "ses_other")).toBe(false);
  });

  it("denies cross-user access", () => {
    const target = { workspaceId: "ws_1", userId: "user_2", agentId: "agent_personal" };
    expect(transcriptAccessAllowed(caller, target, "ses_other")).toBe(false);
  });

  it("denies cross-workspace access", () => {
    const target = { workspaceId: "ws_2", userId: "user_1", agentId: "agent_personal" };
    expect(transcriptAccessAllowed(caller, target, "ses_parent")).toBe(false);
  });
});

describe("formatTranscriptLines", () => {
  it("formats roles and joins, dropping empty content", () => {
    expect(
      formatTranscriptLines([
        { role: "user", content: "  Hello  " },
        { role: "assistant", content: "Hi there" },
        { role: "assistant", content: "   " },
        { role: "tool", content: "result" },
      ]),
    ).toEqual(["User: Hello", "Assistant: Hi there", "Tool: result"]);
  });

  it("returns an empty list for an empty transcript", () => {
    expect(formatTranscriptLines([])).toEqual([]);
  });
});
