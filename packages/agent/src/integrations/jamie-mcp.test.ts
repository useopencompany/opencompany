import { describe, expect, it } from "vitest";
import { JAMIE_MCP_ENDPOINT_URL, JAMIE_MCP_EXTERNAL_ID } from "./jamie-mcp";

describe("Jamie MCP integration", () => {
  it("binds OAuth credentials to Jamie's documented hosted MCP endpoint", () => {
    expect(JAMIE_MCP_ENDPOINT_URL).toBe("https://mcp.meetjamie.ai/mcp");
    expect(JAMIE_MCP_EXTERNAL_ID).toBe("jamie_mcp");
  });
});
