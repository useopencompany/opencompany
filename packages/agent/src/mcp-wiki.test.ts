import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { type McpWikiGateway, registerWikiTool } from "./mcp-server";

type RegisteredTool = {
  callback: (...args: unknown[]) => Promise<unknown>;
};

function register(input: {
  execute: McpWikiGateway["execute"];
  onSuccessfulWikiCall: () => Promise<void>;
}) {
  let registered: RegisteredTool | undefined;
  const server = {
    registerTool: vi.fn((_name: string, _config: unknown, callback: RegisteredTool["callback"]) => {
      registered = { callback };
    }),
  } as unknown as McpServer;
  registerWikiTool(server, {
    userWorkosId: "user_1",
    gatewayApiKey: "gateway_test",
    wiki: {
      getAccess: vi.fn(async () => ({
        enabled: true,
        workspaces: [{ id: "workspace_1", name: "Acme", slug: "acme" }],
      })),
      execute: input.execute,
    },
    onSuccessfulWikiCall: input.onSuccessfulWikiCall,
  });
  if (!registered) throw new Error("Wiki tool was not registered.");
  return registered;
}

describe("MCP wiki tool", () => {
  it("records setup completion after a successful Wiki call", async () => {
    const execute = vi.fn<McpWikiGateway["execute"]>(async () => ({
      ok: true as const,
      result: [],
    }));
    const onSuccessfulWikiCall = vi.fn<() => Promise<void>>(async () => {});
    const tool = register({ execute, onSuccessfulWikiCall });

    await tool.callback({ command: "tree" }, { requestId: "request_1" });

    expect(execute).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      command: { command: "tree" },
      idempotencyKey: "mcp-wiki:user_1:workspace_1:request_1",
    });
    expect(onSuccessfulWikiCall).toHaveBeenCalledOnce();
  });

  it("does not record setup completion for a failed Wiki call", async () => {
    const execute = vi.fn<McpWikiGateway["execute"]>(async () => ({
      ok: false as const,
      error: "unavailable",
    }));
    const onSuccessfulWikiCall = vi.fn<() => Promise<void>>(async () => {});
    const tool = register({ execute, onSuccessfulWikiCall });

    await tool.callback({ command: "tree" }, { requestId: "request_1" });

    expect(onSuccessfulWikiCall).not.toHaveBeenCalled();
  });
});
