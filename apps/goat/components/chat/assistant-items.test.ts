import { describe, expect, it } from "vitest";
import { toolDetail, toolLabel } from "@/components/chat/assistant-items";
import { CALL_INTEGRATION_TOOL_TOOL_NAME, SEARCH_INTEGRATION_TOOLS_TOOL_NAME } from "@/lib/chat-ui";

describe("integration tool rendering", () => {
  it("labels the two integration tools", () => {
    expect(toolLabel(SEARCH_INTEGRATION_TOOLS_TOOL_NAME)).toBe("Tool search");
    expect(toolLabel(CALL_INTEGRATION_TOOL_TOOL_NAME)).toBe("Connected tool");
  });

  it("shows the search query as the search detail", () => {
    expect(
      toolDetail(
        SEARCH_INTEGRATION_TOOLS_TOOL_NAME,
        { type: "tool-search_integration_tools", input: { query: "linear issues" } },
        "completed",
      ),
    ).toBe("linear issues");
  });

  it("shows tool name plus compact arguments for calls", () => {
    expect(
      toolDetail(
        CALL_INTEGRATION_TOOL_TOOL_NAME,
        {
          type: "tool-call_integration_tool",
          input: { tool: "linear_list_issues", arguments: { teamKey: "ENG" } },
        },
        "running",
      ),
    ).toBe('linear_list_issues {"teamKey":"ENG"}');
  });

  it("surfaces in-band call errors", () => {
    expect(
      toolDetail(
        CALL_INTEGRATION_TOOL_TOOL_NAME,
        {
          type: "tool-call_integration_tool",
          state: "output-available",
          input: { tool: "gmail_search_emails" },
          output: { ok: false, error: "Reconnect Gmail in Settings." },
        },
        "completed",
      ),
    ).toBe("gmail_search_emails — Reconnect Gmail in Settings.");
  });
});
