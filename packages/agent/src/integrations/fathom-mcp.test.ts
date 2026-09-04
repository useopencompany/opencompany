import { describe, expect, it } from "vitest";
import { FATHOM_MCP_ENDPOINT_URL, FATHOM_MCP_EXTERNAL_ID } from "./fathom-mcp";

describe("Fathom MCP integration", () => {
  it("binds OAuth credentials to Fathom's hosted MCP endpoint", () => {
    expect(FATHOM_MCP_ENDPOINT_URL).toBe("https://api.fathom.ai/mcp");
    expect(FATHOM_MCP_EXTERNAL_ID).toBe("fathom_mcp");
  });
});
