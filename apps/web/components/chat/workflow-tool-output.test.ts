import { CODEX_MCP_TOOL_NAME } from "@opencompany/agent-runtime";
import { describe, expect, it } from "vitest";
import { workflowCardOutputFromTool } from "./workflow-tool-output";

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
