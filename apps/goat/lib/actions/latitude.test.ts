import { createMCPClient } from "@ai-sdk/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLatitudeActions } from "@/lib/actions/latitude";
import { GoatActionInvalidParamsError, GoatActionPermissionError } from "@/lib/actions/types";
import {
  getGoatLatitudeIntegrationState,
  loadGoatLatitudeMcpWorkerConnection,
} from "@/lib/integrations/latitude-mcp";

const clientMocks = vi.hoisted(() => ({
  listTools: vi.fn(),
  toolsFromDefinitions: vi.fn(),
  close: vi.fn(async () => undefined),
  executeRead: vi.fn(),
  executeWrite: vi.fn(),
}));

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn(async () => clientMocks),
}));

vi.mock("@/lib/integrations/latitude-mcp", () => ({
  GOAT_LATITUDE_MCP_ENDPOINT_URL: "https://api.latitude.so/v1/mcp",
  getGoatLatitudeIntegrationState: vi.fn(),
  loadGoatLatitudeMcpWorkerConnection: vi.fn(),
}));

const definitions = {
  tools: [
    {
      name: "list_traces",
      description: "List traces in a project.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
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
      },
    },
  ],
};

describe("Latitude actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGoatLatitudeIntegrationState).mockResolvedValue({
      provider: "latitude",
      connected: true,
      status: "connected",
      integrationId: "gint_latitude",
      accountName: "Latitude",
      statusReason: null,
      capabilityModes: {},
    });
    vi.mocked(loadGoatLatitudeMcpWorkerConnection).mockResolvedValue({
      ok: true,
      integrationId: "gint_latitude",
      authProvider: {} as never,
    });
    clientMocks.listTools.mockResolvedValue(definitions);
    clientMocks.executeRead.mockResolvedValue({
      content: [{ type: "text", text: '{"traces":[{"id":"trace_1"}]}' }],
    });
    clientMocks.executeWrite.mockResolvedValue({
      content: [{ type: "text", text: '{"id":"signal_1"}' }],
    });
    clientMocks.toolsFromDefinitions.mockReturnValue({
      list_traces: {
        execute: clientMocks.executeRead,
      },
      create_signal: {
        execute: clientMocks.executeWrite,
      },
    });
  });

  it("maps read-only annotations to On and defaults unknown tools to write/Ask", async () => {
    const catalog = await resolveLatitudeActions("user_1");

    expect(createMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: expect.objectContaining({
          type: "http",
          url: "https://api.latitude.so/v1/mcp",
        }),
      }),
    );
    expect(catalog).toMatchObject({
      id: "latitude",
      actions: [
        {
          id: "latitude.list_traces",
          capability: "read",
          permissionMode: "on",
        },
        {
          id: "latitude.create_signal",
          capability: "write",
          permissionMode: "ask",
          permission: {
            provider: "latitude",
            capabilityId: "write",
            integrationIds: ["gint_latitude"],
          },
        },
      ],
    });
  });

  it("validates and executes a current Latitude tool, returning parsed JSON", async () => {
    const catalog = await resolveLatitudeActions("user_1");
    const action = catalog?.actions.find((entry) => entry.id === "latitude.list_traces");

    await expect(
      action?.execute(
        { projectId: "project_1" },
        {
          userWorkosId: "user_1",
          signal: new AbortController().signal,
          currentDate: new Date("2026-07-28T00:00:00Z"),
          userTimezone: "UTC",
        },
      ),
    ).resolves.toEqual({ traces: [{ id: "trace_1" }] });
  });

  it("rejects parameters that no longer match Latitude's live schema", async () => {
    const catalog = await resolveLatitudeActions("user_1");
    const action = catalog?.actions.find((entry) => entry.id === "latitude.list_traces");

    await expect(
      action?.execute(
        {},
        {
          userWorkosId: "user_1",
          signal: new AbortController().signal,
          currentDate: new Date("2026-07-28T00:00:00Z"),
          userTimezone: "UTC",
        },
      ),
    ).rejects.toBeInstanceOf(GoatActionInvalidParamsError);
    expect(clientMocks.executeRead).not.toHaveBeenCalled();
  });

  it("blocks a tool that loses its read-only annotation before execution", async () => {
    clientMocks.listTools.mockResolvedValueOnce(definitions).mockResolvedValueOnce({
      tools: [
        {
          ...definitions.tools[0],
          annotations: {},
        },
      ],
    });
    const catalog = await resolveLatitudeActions("user_1");
    const action = catalog?.actions.find((entry) => entry.id === "latitude.list_traces");

    await expect(
      action?.execute(
        { projectId: "project_1" },
        {
          userWorkosId: "user_1",
          signal: new AbortController().signal,
          currentDate: new Date("2026-07-28T00:00:00Z"),
          userTimezone: "UTC",
        },
      ),
    ).rejects.toBeInstanceOf(GoatActionPermissionError);
  });
});
