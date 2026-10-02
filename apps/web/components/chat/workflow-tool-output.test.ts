import { CODEX_MCP_TOOL_NAME } from "@opencompany/agent-runtime";
import { describe, expect, it } from "vitest";
import { startedTaskOutputFromTool, workflowCardOutputFromTool } from "./workflow-tool-output";

const workflow = {
  name: "Weekly recruiting heatmap",
  slug: "weekly-recruiting-heatmap",
  status: "active",
};

describe("workflowCardOutputFromTool", () => {
  it("unwraps a workflow created through a coding engine's MCP result", () => {
    expect(
      workflowCardOutputFromTool({
        name: CODEX_MCP_TOOL_NAME,
        state: "output-available",
        input: {
          server: "opencompany",
          tool: "workflows",
          arguments: { command: "create" },
        },
        output: {
          status: "completed",
          result: '{"content":[{"text":"truncated…',
          workflowOutput: { ok: true, operation: "created", workflow },
        },
      }),
    ).toMatchObject({ operation: "created", workflow });
  });

  it("restores cards from older untruncated MCP transcripts", () => {
    expect(
      workflowCardOutputFromTool({
        name: CODEX_MCP_TOOL_NAME,
        state: "output-available",
        input: {
          server: "opencompany",
          tool: "workflows",
          arguments: { command: "pause" },
        },
        output: {
          status: "completed",
          result: JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true, operation: "paused", workflow }),
              },
            ],
          }),
        },
      }),
    ).toMatchObject({ operation: "paused", workflow });
  });

  it("keeps workflow reads in the execution trace instead of promoting them as results", () => {
    expect(
      workflowCardOutputFromTool({
        name: CODEX_MCP_TOOL_NAME,
        state: "output-available",
        input: {
          toolName: "mcp__opencompany__workflows",
          arguments: { command: "read", workflowId: "existing-workflow" },
        },
        output: {
          status: "completed",
          result: JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true, operation: "read", workflow }),
              },
            ],
          }),
        },
      }),
    ).toBeNull();
  });
});

describe("startedTaskOutputFromTool", () => {
  const started = {
    taskId: "task_7",
    taskDisplayId: "TASK-7",
    taskName: "Review PR #7",
    status: "queued",
    prompt: "Review https://github.com/o/r/pull/7.",
  };

  it.each([
    { server: "opencompany", tool: "start_workflow", arguments: { workflowId: "review-pr" } },
    { toolName: "mcp__opencompany__start_workflow", arguments: { workflowId: "review-pr" } },
    { server: "opencompany", tool: "workflows", arguments: { command: "run" } },
  ])("promotes a Task a coding engine started to a Task card: %o", (input) => {
    expect(
      startedTaskOutputFromTool({
        name: CODEX_MCP_TOOL_NAME,
        state: "output-available",
        input,
        output: {
          status: "completed",
          result: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(started) }] }),
        },
      }),
    ).toEqual(started);
  });

  it("ignores other host tools and unfinished calls", () => {
    const output = { status: "completed", result: JSON.stringify(started) };
    expect(
      startedTaskOutputFromTool({
        name: CODEX_MCP_TOOL_NAME,
        state: "output-available",
        input: { server: "opencompany", tool: "wiki" },
        output,
      }),
    ).toBeNull();
    expect(
      startedTaskOutputFromTool({
        name: CODEX_MCP_TOOL_NAME,
        state: "input-available",
        input: { server: "opencompany", tool: "start_workflow" },
        output,
      }),
    ).toBeNull();
  });
});
