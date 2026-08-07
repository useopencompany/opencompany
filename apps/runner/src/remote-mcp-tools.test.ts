import { createMCPClient } from "@ai-sdk/mcp";
import {
  loadGoatIntegrationCredential,
  saveGoatIntegrationCredential,
} from "@opencompany/db/integrations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGoatRemoteMcpTools } from "./remote-mcp-tools";

const mocks = vi.hoisted(() => ({
  limit: vi.fn(),
  listTools: vi.fn(),
  toolsFromDefinitions: vi.fn(),
  close: vi.fn(async () => undefined),
  executeRemote: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: mocks.limit,
        }),
      }),
    }),
  }),
}));

vi.mock("@opencompany/db/integrations", () => ({
  loadGoatIntegrationCredential: vi.fn(),
  saveGoatIntegrationCredential: vi.fn(async () => undefined),
}));

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn(async () => ({
    listTools: mocks.listTools,
    toolsFromDefinitions: mocks.toolsFromDefinitions,
    close: mocks.close,
  })),
}));

const latitudeTools = createGoatRemoteMcpTools({
  provider: "latitude",
  displayName: "Latitude",
  endpointUrl: "https://api.latitude.so/v1/mcp",
  externalId: "latitude_mcp",
});

const definitions = {
  tools: [
    {
      name: "list_projects",
      description: "List projects in Latitude.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "create_signal",
      description: "Create a signal.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
  ],
};

describe("Goat runner remote MCP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limit.mockResolvedValue([{ id: "gint_latitude", status: "connected" }]);
    vi.mocked(loadGoatIntegrationCredential).mockResolvedValue({
      payload: {
        clientInformation: { client_id: "client_1" },
        tokens: { access_token: "access_1", token_type: "Bearer" },
      },
      expiresAt: null,
      lastRotatedAt: null,
      updatedAt: new Date(),
      encryptionKeyVersion: 1,
    });
    mocks.listTools.mockResolvedValue(definitions);
    mocks.executeRemote.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    mocks.toolsFromDefinitions.mockReturnValue({
      list_projects: { execute: mocks.executeRemote },
      create_signal: { execute: mocks.executeRemote },
    });
  });

  it("discovers the live Latitude catalog and keeps tool annotations", async () => {
    const result = await latitudeTools.execute({
      name: "latitude_search_tools",
      args: { query: "project" },
      userWorkosId: "user_1",
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      ok: true,
      server: "latitude",
      useTool: "latitude_use_tool",
      toolCount: 1,
      tools: [definitions.tools[0]],
    });
    expect(createMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: expect.objectContaining({
          url: "https://api.latitude.so/v1/mcp",
        }),
      }),
    );
    expect(loadGoatIntegrationCredential).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      integrationId: "gint_latitude",
      provider: "latitude",
      kind: "oauth_token",
    });
  });

  it("rejects invalid dynamic arguments before calling the provider", async () => {
    const result = await latitudeTools.execute({
      name: "latitude_use_tool",
      args: { tool: "create_signal", arguments: {} },
      userWorkosId: "user_1",
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("do not match"),
    });
    expect(mocks.executeRemote).not.toHaveBeenCalled();
  });

  it("executes a named tool with current-schema validation", async () => {
    const signal = new AbortController().signal;
    await expect(
      latitudeTools.execute({
        name: "latitude_use_tool",
        args: { tool: "create_signal", arguments: { name: "Regression risk" } },
        userWorkosId: "user_1",
        signal,
      }),
    ).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });

    expect(mocks.executeRemote).toHaveBeenCalledWith(
      { name: "Regression risk" },
      expect.objectContaining({
        toolCallId: "goat_latitude_create_signal",
        abortSignal: signal,
      }),
    );
    expect(saveGoatIntegrationCredential).not.toHaveBeenCalled();
  });
});
