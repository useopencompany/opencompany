import { describe, expect, it, vi } from "vitest";
import type { RemoteMcpGatewayDependencies } from "../actions/remote-mcp";
import { createXMcpClient } from "./x-mcp-client";

const connection = { userWorkosId: "user_1", integrationId: "gint_x" };
const config = {
  clientName: "test",
  version: "1",
  initializationOptions: { timeout: 100, maxTotalTimeout: 100 },
  transport: { type: "http" as const, url: "https://api.x.com/mcp" },
};

describe("X composite MCP client", () => {
  it("executes a supplemental tool without contacting hosted MCP", async () => {
    const createRemoteClient = vi.fn<RemoteMcpGatewayDependencies["createClient"]>();
    const executeApiTool = vi.fn().mockResolvedValue({ data: { id: "123" } });
    const client = await createXMcpClient({ connection, createRemoteClient, executeApiTool })(
      config,
    );
    const signal = new AbortController().signal;
    const result = await client.callTool({
      name: "create_posts",
      arguments: { text: "hello" },
      options: { signal },
    });
    expect(result).toEqual({ content: [{ type: "text", text: '{"data":{"id":"123"}}' }] });
    expect(executeApiTool).toHaveBeenCalledExactlyOnceWith({
      name: "create_posts",
      params: { text: "hello" },
      connection,
      signal,
    });
    await client.close();
    expect(createRemoteClient).not.toHaveBeenCalled();
  });

  it("keeps upstream pagination, replaces overlapping tools, preloads metadata, and closes once", async () => {
    const remote = {
      listTools: vi
        .fn()
        .mockResolvedValueOnce({
          tools: [{ name: "get_users_me" }, { name: "create_posts" }],
          nextCursor: "page2",
        })
        .mockResolvedValueOnce({ tools: [{ name: "search_news" }, { name: "create_posts" }] }),
      toolsFromDefinitions: vi.fn(),
      callTool: vi.fn().mockResolvedValue({ content: [] }),
      close: vi.fn(),
    };
    const createRemoteClient = vi.fn().mockResolvedValue(remote);
    const client = await createXMcpClient({ connection, createRemoteClient })(config);
    const first = await client.listTools();
    expect(first.nextCursor).toBe("page2");
    expect(first.tools.filter((tool) => tool.name === "create_posts")).toHaveLength(1);
    expect(first.tools.find((tool) => tool.name === "create_posts")?.inputSchema).toBeDefined();
    expect(await client.listTools({ params: { cursor: "page2" } })).toEqual({
      tools: [{ name: "search_news" }],
    });
    const preload = { tools: [{ name: "get_users_me", inputSchema: { type: "object" } }] };
    client.toolsFromDefinitions(preload);
    const request = { name: "get_users_me", arguments: {} };
    await client.callTool(request);
    expect(remote.toolsFromDefinitions).toHaveBeenCalledWith(preload);
    expect(remote.callTool).toHaveBeenCalledWith(request);
    await client.close();
    expect(remote.close).toHaveBeenCalledTimes(1);
    expect(createRemoteClient).toHaveBeenCalledTimes(1);
  });
});
