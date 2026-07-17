import { describe, expect, it } from "vitest";
import { createAdaptiveToolRuntime } from "./runtime";

describe("adaptive tool runtime", () => {
  it("recovers the complete tool directory through a Level-0 pointer", async () => {
    const runtime = createAdaptiveToolRuntime();

    const result = await execute(runtime.tools.expand_integration, {
      pointer: "integration://slack",
      intent: "react to a message",
    });

    expect(result).toMatchObject({
      ok: true,
      directory: { integration: "Slack", pointer: "integration://slack" },
    });
    expect((result as { directory: { tools: unknown[] } }).directory.tools).toHaveLength(8);
    expect(runtime.expansions).toEqual([
      {
        sequence: 0,
        level: 1,
        pointer: "integration://slack",
        reason: "model_request",
      },
    ]);
  });

  it("resolves Level 2 at call time and records a valid mock execution", async () => {
    const runtime = createAdaptiveToolRuntime();

    const result = await execute(runtime.tools.call_tool, {
      pointer: "tool://gmail/search_emails",
      arguments: { query: "from:ada@example.com launch", limit: 5 },
    });

    expect(result).toMatchObject({
      ok: true,
      simulated: true,
      result: { messages: [{ emailId: "email_ada_launch" }] },
    });
    expect(runtime.calls).toEqual([
      expect.objectContaining({
        pointer: "tool://gmail/search_emails",
        integrationId: "gmail",
        toolName: "search_emails",
        valid: true,
      }),
    ]);
    expect(runtime.expansions).toEqual([
      {
        sequence: 0,
        level: 2,
        pointer: "tool://gmail/search_emails",
        reason: "call_time",
      },
    ]);
  });

  it("rejects invalid arguments against the resolved full schema", async () => {
    const runtime = createAdaptiveToolRuntime();

    const result = await execute(runtime.tools.call_tool, {
      pointer: "tool://slack/send_message",
      arguments: { text: "Launch is green." },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_TOOL_ARGUMENTS",
      error: "Missing required argument: channel",
    });
    expect(runtime.calls[0]).toMatchObject({ valid: false, toolName: "send_message" });
  });
});

async function execute(tool: unknown, input: unknown): Promise<unknown> {
  const executeTool = (tool as { execute?: (value: unknown) => Promise<unknown> }).execute;
  if (!executeTool) throw new Error("Expected an executable experiment tool.");
  return executeTool(input);
}
