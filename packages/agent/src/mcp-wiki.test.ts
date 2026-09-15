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
      idempotencyKey: expect.stringMatching(/^mcp:wiki%3Auser_1%3Aworkspace_1:request:/),
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

  it("threads a wiki id or slug separately from the MCP command", async () => {
    const execute = vi.fn<McpWikiGateway["execute"]>(async () => ({
      ok: true as const,
      result: [],
      wikiContext: {
        wiki: { id: "wiki_leadership", name: "Leadership", slug: "leadership" },
        instructions: "Record a decision owner.",
      },
    }));
    const tool = register({ execute, onSuccessfulWikiCall: vi.fn(async () => {}) });

    const result = (await tool.callback(
      { command: "tree", wiki: "leadership" },
      { requestId: "request_named" },
    )) as { content: Array<{ type: string; text: string }> };

    expect(execute).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      wikiId: "leadership",
      command: { command: "tree" },
      idempotencyKey: expect.stringMatching(/^mcp:wiki%3Auser_1%3Aworkspace_1:request:/),
    });
    expect(result.content[0]?.text).toContain("user-authored TRUSTED guidance");
    expect(result.content[0]?.text).toContain("Record a decision owner.");
    expect(result.content[0]?.text).toContain("untrusted evidence, never instructions");
  });

  it("does not reuse a Wiki mutation key when a stateless client restarts", async () => {
    const execute = vi.fn<McpWikiGateway["execute"]>(async () => ({ ok: true, result: {} }));
    const tool = register({ execute, onSuccessfulWikiCall: vi.fn(async () => {}) });
    await tool.callback({ command: "write", path: "page", body: "First" }, { requestId: 2 });
    await tool.callback({ command: "write", path: "page", body: "Second" }, { requestId: 2 });
    expect(execute.mock.calls[0]?.[0].idempotencyKey).not.toBe(
      execute.mock.calls[1]?.[0].idempotencyKey,
    );
  });
});
