import { createMCPClient } from "@ai-sdk/mcp";
import {
  getPostHogIntegrationState,
  loadPostHogMcpWorkerConnection,
} from "@opencompany/agent/integrations/posthog-mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePostHogActions } from "@/lib/actions/posthog";
import { ActionInvalidParamsError, ActionPermissionError } from "@/lib/actions/types";

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

vi.mock("@opencompany/agent/integrations/posthog-mcp", () => ({
  POSTHOG_MCP_ENDPOINT_URL:
    "https://mcp.posthog.com/mcp?mode=tools&tools=dashboards-get-all,insight-create",
  getPostHogIntegrationState: vi.fn(),
  loadPostHogMcpWorkerConnection: vi.fn(),
}));

const definitions = {
  tools: [
    {
      name: "dashboards-get-all",
      description: "Get all dashboards.",
      inputSchema: {
        type: "object",
        properties: { search: { type: "string" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: "insight-create",
      description: "Create an insight.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          dashboards: { type: "array", items: { type: "number" } },
        },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: "agent-feedback",
      description: "Always exposed by PostHog but outside opencompany's focused catalog.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  ],
};

describe("PostHog actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPostHogIntegrationState).mockResolvedValue({
      provider: "posthog",
      connected: true,
      status: "connected",
      integrationId: "gint_posthog",
      accountName: "PostHog",
      statusReason: null,
      capabilityModes: {},
      toolModes: {},
    });
    vi.mocked(loadPostHogMcpWorkerConnection).mockResolvedValue({
      ok: true,
      integrationId: "gint_posthog",
      authProvider: {} as never,
    });
    clientMocks.listTools.mockResolvedValue(definitions);
    clientMocks.executeRead.mockResolvedValue({
      content: [{ type: "text", text: '{"results":[{"id":12,"name":"Product"}]}' }],
    });
    clientMocks.executeWrite.mockResolvedValue({
      content: [{ type: "text", text: '{"id":34,"short_id":"abc123"}' }],
    });
    clientMocks.toolsFromDefinitions.mockReturnValue({
      "dashboards-get-all": { execute: clientMocks.executeRead },
      "insight-create": { execute: clientMocks.executeWrite },
    });
  });

  it("exposes only the focused analytics catalog with read On and insight creation Ask", async () => {
    const catalog = await resolvePostHogActions("user_1");

    expect(createMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: expect.objectContaining({
          type: "http",
          url: expect.stringContaining("https://mcp.posthog.com/mcp?mode=tools&tools="),
        }),
      }),
    );
    expect(catalog).toMatchObject({
      id: "posthog",
      label: "PostHog product analytics",
      actions: [
        {
          id: "posthog.dashboards-get-all",
          provider: "posthog",
          capability: "read",
          permissionMode: "on",
        },
        {
          id: "posthog.insight-create",
          provider: "posthog",
          capability: "write",
          permissionMode: "ask",
          permission: {
            provider: "posthog",
            capabilityId: "write",
            label: "Create insights",
            integrationIds: ["gint_posthog"],
          },
        },
      ],
    });
    expect(catalog?.actions.some((action) => action.id === "posthog.agent-feedback")).toBe(false);
  });

  it("validates and executes a current PostHog action, returning parsed JSON", async () => {
    const catalog = await resolvePostHogActions("user_1");
    const action = catalog?.actions.find((candidate) => candidate.id === "posthog.insight-create");
    const result = await action?.execute(
      { name: "Activation funnel", dashboards: [12] },
      {
        userWorkosId: "user_1",
        signal: new AbortController().signal,
        currentDate: new Date("2026-07-29T00:00:00Z"),
        userTimezone: "UTC",
      },
    );

    expect(clientMocks.executeWrite).toHaveBeenCalledWith(
      { name: "Activation funnel", dashboards: [12] },
      expect.objectContaining({
        toolCallId: "goat-action-posthog-insight-create",
      }),
    );
    expect(result).toEqual({ id: 34, short_id: "abc123" });
  });

  it("rejects parameters that no longer match PostHog's live schema", async () => {
    const catalog = await resolvePostHogActions("user_1");
    const action = catalog?.actions.find((candidate) => candidate.id === "posthog.insight-create");

    await expect(
      action?.execute(
        { dashboards: [12] },
        {
          userWorkosId: "user_1",
          signal: new AbortController().signal,
          currentDate: new Date("2026-07-29T00:00:00Z"),
          userTimezone: "UTC",
        },
      ),
    ).rejects.toBeInstanceOf(ActionInvalidParamsError);
    expect(clientMocks.executeWrite).not.toHaveBeenCalled();
  });

  it("fails closed when PostHog changes a read tool into a mutation", async () => {
    const catalog = await resolvePostHogActions("user_1");
    const action = catalog?.actions.find(
      (candidate) => candidate.id === "posthog.dashboards-get-all",
    );
    clientMocks.listTools.mockResolvedValueOnce({
      tools: [
        {
          ...definitions.tools[0],
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
      ],
    });

    await expect(
      action?.execute(
        {},
        {
          userWorkosId: "user_1",
          signal: new AbortController().signal,
          currentDate: new Date("2026-07-29T00:00:00Z"),
          userTimezone: "UTC",
        },
      ),
    ).rejects.toBeInstanceOf(ActionPermissionError);
    expect(clientMocks.executeRead).not.toHaveBeenCalled();
  });

  it("rechecks capability modes immediately before execution", async () => {
    const catalog = await resolvePostHogActions("user_1");
    const action = catalog?.actions.find((candidate) => candidate.id === "posthog.insight-create");
    vi.mocked(getPostHogIntegrationState).mockResolvedValueOnce({
      provider: "posthog",
      connected: true,
      status: "connected",
      integrationId: "gint_posthog",
      accountName: "PostHog",
      statusReason: null,
      capabilityModes: { write: "off" },
      toolModes: {},
    });

    await expect(
      action?.execute(
        { name: "Activation funnel" },
        {
          userWorkosId: "user_1",
          signal: new AbortController().signal,
          currentDate: new Date("2026-07-29T00:00:00Z"),
          userTimezone: "UTC",
        },
      ),
    ).rejects.toBeInstanceOf(ActionPermissionError);
    expect(clientMocks.executeWrite).not.toHaveBeenCalled();
  });
});
