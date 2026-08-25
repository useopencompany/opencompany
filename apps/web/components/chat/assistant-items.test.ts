import {
  CODEX_COMMAND_TOOL_NAME,
  CODEX_FILE_CHANGE_TOOL_NAME,
  CODEX_MCP_TOOL_NAME,
  CODEX_WEB_SEARCH_TOOL_NAME,
} from "@opencompany/agent-runtime";
import { describe, expect, it } from "vitest";
import { toolCallViewFromPart } from "./assistant-items";

describe("coding transcript tool presentations", () => {
  it("uses command descriptions and removes shell invocation wrappers", () => {
    const tool = toolCallViewFromPart({
      type: `tool-${CODEX_COMMAND_TOOL_NAME}`,
      toolCallId: "command_1",
      state: "input-available",
      input: {
        description: "Check local copy of spec and git status",
        command: "/bin/bash -lc 'git status --short && bun test'",
      },
    });

    expect(tool).toMatchObject({
      label: "Check local copy of spec and git status",
      detail: "git status --short && bun test",
      detailChips: ["git status --short && bun test"],
    });
  });

  it("never exposes internal coding tool names when richer fields are absent", () => {
    const command = toolCallViewFromPart({
      type: `tool-${CODEX_COMMAND_TOOL_NAME}`,
      toolCallId: "command_legacy",
      state: "input-available",
      input: { command: CODEX_COMMAND_TOOL_NAME },
    });
    const mcp = toolCallViewFromPart({
      type: "dynamic-tool",
      toolName: CODEX_MCP_TOOL_NAME,
      toolCallId: "mcp_legacy",
      state: "input-available",
      input: { label: "MCP tool" },
    });
    const internalMcpIdentity = toolCallViewFromPart({
      type: "dynamic-tool",
      toolName: CODEX_MCP_TOOL_NAME,
      toolCallId: "mcp_internal",
      state: "input-available",
      input: { label: "MCP tool", tool: CODEX_COMMAND_TOOL_NAME },
    });

    expect(command).toMatchObject({ label: "Command", detail: null, detailChips: [] });
    expect(mcp).toMatchObject({ label: "Tool", detail: null, detailChips: [] });
    expect(internalMcpIdentity).toMatchObject({ label: "Tool", detail: null, detailChips: [] });
  });

  it("renders Read, Write, Search, and TodoWrite with semantic labels", () => {
    const read = toolCallViewFromPart({
      type: "dynamic-tool",
      toolName: CODEX_MCP_TOOL_NAME,
      toolCallId: "read_1",
      state: "output-available",
      input: {
        tool: "Read",
        title: "Read the chat renderer",
        arguments: {
          file_path:
            "/home/user/opencompany-goat/codex-chat/opencompany-experimental/apps/web/components/chat/ToolCallItem.tsx",
        },
      },
      output: {
        status: "completed",
        result: "  1→first line\n  2→second line\n  3→third line",
      },
    });
    const write = toolCallViewFromPart({
      type: "dynamic-tool",
      toolName: CODEX_FILE_CHANGE_TOOL_NAME,
      toolCallId: "write_1",
      state: "output-available",
      input: {
        toolName: "Write",
        kind: "edit",
        arguments: {
          file_path:
            "/home/user/opencompany-goat/codex-chat/opencompany-experimental/apps/web/lib/labels.ts",
          content: "first\nsecond",
        },
      },
      output: { status: "completed" },
    });
    const search = toolCallViewFromPart({
      type: "dynamic-tool",
      toolName: CODEX_WEB_SEARCH_TOOL_NAME,
      toolCallId: "grep_1",
      state: "output-available",
      input: {
        toolName: "Grep",
        kind: "search",
        arguments: { pattern: "codex_command" },
      },
      output: { status: "completed" },
    });
    const todo = toolCallViewFromPart({
      type: "dynamic-tool",
      toolName: CODEX_MCP_TOOL_NAME,
      toolCallId: "todo_1",
      state: "output-available",
      input: {
        tool: "TodoWrite",
        arguments: { todos: [{ content: "Inspect" }, { content: "Patch" }] },
      },
      output: { status: "completed" },
    });

    expect(read).toMatchObject({ label: "Read 3 lines", detailChips: ["ToolCallItem.tsx"] });
    expect(write).toMatchObject({
      label: "Write 2 lines",
      detailChips: ["apps/web/lib/labels.ts"],
    });
    expect(search).toMatchObject({
      label: "Search",
      detailChips: ["codex_command"],
    });
    expect(todo).toMatchObject({ label: "Plan", detailChips: ["2 items"] });
  });

  it("renders true MCP calls as server and tool chips", () => {
    const tool = toolCallViewFromPart({
      type: "dynamic-tool",
      toolName: CODEX_MCP_TOOL_NAME,
      toolCallId: "mcp_1",
      state: "output-available",
      input: {
        title: "List available actions",
        server: "opencompany",
        tool: "list_actions",
        arguments: {
          server: "spoofed-server",
          tool: "spoofed-tool",
          toolName: "Read",
          kind: "read",
          title: "Spoofed title",
        },
      },
      output: { status: "completed", result: "[]" },
    });

    expect(tool).toMatchObject({
      label: "List available actions",
      detailChips: ["opencompany · list_actions"],
    });
  });
});
