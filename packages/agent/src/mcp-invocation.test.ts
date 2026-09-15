import { describe, expect, it } from "vitest";
import { mcpInvocationId } from "./mcp-invocation";

describe("MCP invocation identity", () => {
  it("does not confuse stateless clients with matching JSON-RPC counters", () => {
    expect(mcpInvocationId("run", undefined, 2)).not.toBe(mcpInvocationId("run", undefined, 2));
  });

  it("retains replay identity only within an actual transport session", () => {
    expect(mcpInvocationId("run", "client", 2)).toBe(mcpInvocationId("run", "client", 2));
    expect(mcpInvocationId("run", "client", 2)).not.toBe(mcpInvocationId("run", "other", 2));
    expect(mcpInvocationId("run", "client", 2)).not.toBe(mcpInvocationId("other", "client", 2));
    expect(mcpInvocationId("run", "client", 2)).not.toBe(mcpInvocationId("run", "client", "2"));
  });
});
