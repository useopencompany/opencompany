import {
  applyCodexEventToUiMessageParts,
  type CodexUiMessagePart,
  createAcpEventNormalizer,
} from "@opencompany/agent-runtime";
import { describe, expect, it } from "vitest";
import { toolCallViewFromPart } from "./assistant-items";

function presentUpdates(updates: Record<string, unknown>[]) {
  const normalizer = createAcpEventNormalizer();
  let parts: CodexUiMessagePart[] = [];
  for (const update of updates) {
    const events = normalizer.normalize({
      method: "session/update",
      params: { sessionId: "session_1", update },
    });
    for (const event of events) {
      parts = applyCodexEventToUiMessageParts(parts, event).parts;
    }
  }
  return parts.map((part) => toolCallViewFromPart(part));
}

describe("ACP events through transcript presentation", () => {
  // Wire shapes from codex-acp v1.10.0's CodexToolCallMapper and Claude's native tools.
  it.each(["claude", "codex"])("shows file paths for %s edits", (engine) => {
    const path = `/home/user/opencompany-goat/${engine}-chat/opencompany/src/example.ts`;
    const providerFields =
      engine === "claude"
        ? {
            _meta: { claudeCode: { toolName: "Edit" } },
            rawInput: { file_path: path },
          }
        : {
            content: [{ type: "diff", path, oldText: "before", newText: "after" }],
          };
    const tools = presentUpdates([
      {
        sessionUpdate: "tool_call",
        toolCallId: "edit_1",
        title: "Editing files",
        kind: "edit",
        status: "completed",
        ...providerFields,
      },
    ]);
    expect(tools).toMatchObject([{ label: "Edit", detailChips: ["src/example.ts"] }]);
  });

  it.each(["claude", "codex"])("identifies file creation for %s", (engine) => {
    const path = "/workspace/opencompany/src/new.ts";
    const providerFields =
      engine === "claude"
        ? {
            _meta: { claudeCode: { toolName: "Write" } },
            rawInput: { file_path: path },
          }
        : {
            content: [{ type: "diff", path, oldText: null, newText: "new" }],
          };
    expect(
      presentUpdates([
        {
          sessionUpdate: "tool_call",
          toolCallId: "write_1",
          title: "Editing files",
          kind: "edit",
          status: "completed",
          ...providerFields,
        },
      ]),
    ).toMatchObject([{ label: "Write", detailChips: ["src/new.ts"] }]);
  });

  it("retains Codex read locations through status-only completion", () => {
    expect(
      presentUpdates([
        {
          sessionUpdate: "tool_call",
          toolCallId: "read_1",
          title: "Read file '/workspace/opencompany/package.json'",
          kind: "read",
          status: "in_progress",
          locations: [{ path: "/workspace/opencompany/package.json" }],
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "read_1",
          status: "completed",
        },
      ]),
    ).toMatchObject([{ label: "Read", detailChips: ["package.json"], state: "output-available" }]);
  });

  it("retains streamed diff paths through status-only completion without duplicate rows", () => {
    expect(
      presentUpdates([
        {
          sessionUpdate: "tool_call",
          toolCallId: "edit_1",
          title: "Editing files",
          kind: "edit",
          status: "in_progress",
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit_1",
          content: [{ type: "diff", path: "src/example.ts", oldText: "old", newText: "new" }],
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit_1",
          status: "completed",
        },
      ]),
    ).toMatchObject([
      { label: "Edit", detailChips: ["src/example.ts"], state: "output-available" },
    ]);
  });

  it("preserves the providers' command descriptions without inventing Codex descriptions", () => {
    const tools = presentUpdates([
      {
        sessionUpdate: "tool_call",
        toolCallId: "claude_command",
        title: "Terminal",
        kind: "execute",
        status: "completed",
        rawInput: { command: "git status", description: "Check the working tree" },
        _meta: { claudeCode: { toolName: "Bash" } },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "codex_command",
        title: "git status",
        kind: "execute",
        status: "completed",
        rawInput: { command: "/bin/bash -lc 'git status'", cwd: "/workspace/opencompany" },
      },
    ]);
    expect(tools).toMatchObject([
      { label: "Check the working tree", detailChips: ["git status"] },
      { label: "Command", detailChips: ["git status"] },
    ]);
  });

  it("deduplicates diff locations and preserves Codex deletion semantics", () => {
    expect(
      presentUpdates([
        {
          sessionUpdate: "tool_call",
          toolCallId: "delete_1",
          title: "Editing files",
          kind: "edit",
          status: "completed",
          locations: [{ path: "src/old.ts" }],
          content: [
            null,
            { type: "diff", path: 42 },
            { type: "content", path: "not-a-file.ts" },
            {
              type: "diff",
              path: "src/old.ts",
              oldText: "old",
              newText: "",
              _meta: { kind: "delete" },
            },
          ],
        },
      ]),
    ).toMatchObject([{ label: "Delete", detailChips: ["src/old.ts"] }]);
  });

  it("labels mixed file operations as edits rather than applying the first operation to all files", () => {
    expect(
      presentUpdates([
        {
          sessionUpdate: "tool_call",
          toolCallId: "mixed_1",
          title: "Editing files",
          kind: "edit",
          status: "completed",
          content: [
            { type: "diff", path: "src/new.ts", oldText: null, newText: "new" },
            { type: "diff", path: "src/existing.ts", oldText: "old", newText: "new" },
          ],
        },
      ]),
    ).toMatchObject([{ label: "Edit", detailChips: ["src/new.ts", "src/existing.ts"] }]);
  });
});
