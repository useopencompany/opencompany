import {
  ACP_TOOLS_MCP_SERVER_NAME,
  CODEX_COMMAND_TOOL_NAME,
  CODEX_FILE_CHANGE_TOOL_NAME,
  CODEX_MCP_TOOL_NAME,
  CODEX_WEB_SEARCH_TOOL_NAME,
} from "@opencompany/agent-runtime";
import { describe, expect, it } from "vitest";
import { USE_ACTION_TOOL_NAME } from "@/lib/chat-ui";
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
            "/home/user/opencompany-goat/codex-chat/opencompany/apps/web/components/chat/ToolCallItem.tsx",
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
          file_path: "/home/user/opencompany-goat/codex-chat/opencompany/apps/web/lib/labels.ts",
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

  it("renders third-party MCP calls as server and tool chips", () => {
    const tool = toolCallViewFromPart({
      type: "dynamic-tool",
      toolName: CODEX_MCP_TOOL_NAME,
      toolCallId: "mcp_1",
      state: "output-available",
      input: {
        title: "List open tickets",
        server: "acme-desk",
        tool: "list_tickets",
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
      label: "List open tickets",
      detailChips: ["acme-desk · list_tickets"],
      actionSource: null,
    });
  });

  it("names opencompany host tool calls after the capability, not the MCP plumbing", () => {
    const tool = toolCallViewFromPart({
      type: "dynamic-tool",
      toolName: CODEX_MCP_TOOL_NAME,
      toolCallId: "mcp_host",
      state: "output-available",
      input: {
        title: "List available actions",
        server: ACP_TOOLS_MCP_SERVER_NAME,
        tool: "list_actions",
      },
      output: { status: "completed", result: "[]" },
    });

    expect(tool).toMatchObject({
      label: "List actions",
      detailChips: [],
      actionSource: null,
    });
  });

  it("names a connected action after the service it ran against", () => {
    const tool = toolCallViewFromPart({
      type: "dynamic-tool",
      toolName: CODEX_MCP_TOOL_NAME,
      toolCallId: "mcp_action",
      state: "output-available",
      input: {
        server: ACP_TOOLS_MCP_SERVER_NAME,
        tool: USE_ACTION_TOOL_NAME,
        arguments: {
          action: "plugin:linear:linear.create_issue",
          params: { title: "Ship action rows" },
        },
      },
      output: { status: "completed", result: '{"ok":true}' },
    });

    expect(tool).toMatchObject({
      label: "Linear · Create issue",
      detailChips: [],
      actionSource: "linear",
    });
  });

  it("keeps a failed connected action readable", () => {
    const tool = toolCallViewFromPart({
      type: "dynamic-tool",
      toolName: CODEX_MCP_TOOL_NAME,
      toolCallId: "mcp_action_failed",
      state: "output-available",
      input: {
        server: ACP_TOOLS_MCP_SERVER_NAME,
        tool: USE_ACTION_TOOL_NAME,
        arguments: { action: "gmail.send_email", params: {} },
      },
      output: { status: "failed", error: "Gmail is not connected." },
    });

    expect(tool).toMatchObject({
      label: "Gmail · Send email",
      detailChips: ["Gmail is not connected."],
      actionSource: "gmail",
      status: "failed",
    });
  });
});

describe("connected action rows in the opencompany chat", () => {
  it("leads with the service and the action, and keeps cost on the chip", () => {
    const tool = toolCallViewFromPart({
      type: `tool-${USE_ACTION_TOOL_NAME}`,
      toolCallId: "action_1",
      state: "output-available",
      input: { action: "lead.search_prospects", params: { query: "seed-stage founders" } },
      output: {
        ok: true,
        action: "lead.search_prospects",
        result: {
          untrustedProviderData: true,
          resultCount: 12,
          cost: { state: "settled", totalUsdMicros: 240_000 },
        },
      },
    });

    expect(tool).toMatchObject({
      label: "Lead research · Search prospects",
      detail: "12 results · $0.24",
      actionSource: "lead",
    });
  });

  it("shows why a connected action failed", () => {
    const tool = toolCallViewFromPart({
      type: `tool-${USE_ACTION_TOOL_NAME}`,
      toolCallId: "action_2",
      state: "output-available",
      input: { action: "x_account.post_tweet", params: {} },
      output: {
        ok: false,
        action: "x_account.post_tweet",
        error: { code: "not_connected", message: "Connect your X account first." },
      },
    });

    expect(tool).toMatchObject({
      label: "X · Post tweet",
      detail: "Connect your X account first.",
      actionSource: "x",
      status: "failed",
    });
  });
});
