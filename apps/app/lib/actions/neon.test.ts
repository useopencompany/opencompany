import { createMCPClient } from "@ai-sdk/mcp";
import {
  getNeonIntegrationState,
  loadNeonMcpWorkerConnection,
} from "@opencompany/core/integrations/neon-mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNeonActions } from "@/lib/actions/neon";
import { ActionInvalidParamsError, ActionPermissionError } from "@/lib/actions/types";

const clientMocks = vi.hoisted(() => ({
  listTools: vi.fn(),
  toolsFromDefinitions: vi.fn(),
  close: vi.fn(async () => undefined),
  executeListProjects: vi.fn(),
  executeRunSql: vi.fn(),
  executeConnectionString: vi.fn(),
  executeCreateBranch: vi.fn(),
}));

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn(async () => clientMocks),
}));

vi.mock("@opencompany/core/integrations/neon-mcp", () => ({
  NEON_MCP_ENDPOINT_URL:
    "https://mcp.neon.tech/mcp?readonly=true&category=projects&category=branches&category=schema&category=querying",
  getNeonIntegrationState: vi.fn(),
  loadNeonMcpWorkerConnection: vi.fn(),
}));

const definitions = {
  tools: [
    {
      name: "list_projects",
      description: "List projects.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
    },
    {
      name: "run_sql",
      description: "Run SQL.",
      // Neon's live definition marks the generic tool destructive because it
      // can write outside readonly mode. Goat pins the MCP endpoint to
      // readonly=true and applies its own SQL validation before execution.
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          sql: { type: "string" },
        },
        required: ["projectId", "sql"],
      },
    },
    {
      name: "get_connection_string",
      description: "Get a database credential.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "create_branch",
      description: "Create a branch.",
      inputSchema: { type: "object", properties: {} },
      annotations: { destructiveHint: true },
    },
  ],
};

const actionContext = {
  userWorkosId: "user_1",
  signal: new AbortController().signal,
  currentDate: new Date("2026-08-04T00:00:00Z"),
  userTimezone: "UTC",
};

// Assemble this at runtime so the secret scanner does not mistake a test-only
// credential-shaped fixture for a committed PostgreSQL secret.
const TEST_POSTGRES_URL = [
  "postgresql",
  "://",
  "owner",
  ":",
  "credential",
  "@",
  "db.example",
  "/prod",
].join("");

describe("Neon actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getNeonIntegrationState).mockResolvedValue({
      provider: "neon",
      connected: true,
      status: "connected",
      integrationId: "gint_neon",
      accountName: "Neon",
      statusReason: null,
      capabilityModes: {},
    });
    vi.mocked(loadNeonMcpWorkerConnection).mockResolvedValue({
      ok: true,
      integrationId: "gint_neon",
      authProvider: {} as never,
    });
    clientMocks.listTools.mockResolvedValue(definitions);
    clientMocks.executeListProjects.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            projects: [
              {
                id: "project_1",
                name: "Production",
                connection_string: TEST_POSTGRES_URL,
                api_key: "key-secret",
                privateKey: "private-secret",
                authToken: "auth-secret",
                note: `connect with ${TEST_POSTGRES_URL}`,
              },
            ],
          }),
        },
      ],
    });
    clientMocks.executeRunSql.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ rows: [{ id: 1, token: "secret" }] }) }],
    });
    clientMocks.toolsFromDefinitions.mockReturnValue({
      list_projects: { execute: clientMocks.executeListProjects },
      run_sql: { execute: clientMocks.executeRunSql },
      get_connection_string: { execute: clientMocks.executeConnectionString },
      create_branch: { execute: clientMocks.executeCreateBranch },
    });
  });

  it("exposes only reviewed read-only tools with database queries behind Ask", async () => {
    const catalog = await resolveNeonActions("user_1");

    expect(createMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: {
          type: "http",
          url: "https://mcp.neon.tech/mcp?readonly=true&category=projects&category=branches&category=schema&category=querying",
          authProvider: expect.anything(),
        },
      }),
    );
    expect(catalog).toMatchObject({
      id: "neon",
      label: "Neon (read-only)",
      actions: [
        {
          id: "neon.list_projects",
          capability: "read",
          permissionMode: "on",
        },
        {
          id: "neon.run_sql",
          capability: "query",
          permissionMode: "ask",
          permission: {
            provider: "neon",
            capabilityId: "query",
            integrationIds: ["gint_neon"],
          },
        },
      ],
    });
    expect(catalog?.actions.map((action) => action.id)).not.toContain("neon.get_connection_string");
    expect(catalog?.actions.map((action) => action.id)).not.toContain("neon.create_branch");
  });

  it("redacts credentials from untrusted Neon responses", async () => {
    const catalog = await resolveNeonActions("user_1");
    const action = catalog?.actions.find((entry) => entry.id === "neon.list_projects");

    await expect(action?.execute({}, actionContext)).resolves.toEqual({
      untrustedProviderData: true,
      payload: {
        projects: [
          {
            id: "project_1",
            name: "Production",
            connection_string: "[redacted by OpenCompany]",
            api_key: "[redacted by OpenCompany]",
            privateKey: "[redacted by OpenCompany]",
            authToken: "[redacted by OpenCompany]",
            note: "connect with [redacted PostgreSQL connection string]",
          },
        ],
      },
    });
  });

  it("runs and redacts a narrow read query despite Neon's generic destructive hint", async () => {
    const catalog = await resolveNeonActions("user_1");
    const action = catalog?.actions.find((entry) => entry.id === "neon.run_sql");

    await expect(
      action?.execute(
        { projectId: "project_1", sql: "SELECT id, token FROM users LIMIT 10" },
        actionContext,
      ),
    ).resolves.toEqual({
      untrustedProviderData: true,
      payload: { rows: [{ id: 1, token: "[redacted by OpenCompany]" }] },
    });
    expect(clientMocks.executeRunSql).toHaveBeenCalledOnce();
  });

  it("rejects mutating statements and administrative functions before calling Neon", async () => {
    const catalog = await resolveNeonActions("user_1");
    const action = catalog?.actions.find((entry) => entry.id === "neon.run_sql");

    await expect(
      action?.execute({ projectId: "project_1", sql: "DELETE FROM users" }, actionContext),
    ).rejects.toBeInstanceOf(ActionInvalidParamsError);
    await expect(
      action?.execute(
        { projectId: "project_1", sql: "SELECT pg_terminate_backend(123)" },
        actionContext,
      ),
    ).rejects.toBeInstanceOf(ActionInvalidParamsError);
    expect(clientMocks.executeRunSql).not.toHaveBeenCalled();
  });

  it("blocks a reviewed tool if Neon later marks it destructive", async () => {
    clientMocks.listTools.mockResolvedValueOnce(definitions).mockResolvedValueOnce({
      tools: [
        {
          ...definitions.tools[0],
          annotations: { destructiveHint: true },
        },
      ],
    });
    const catalog = await resolveNeonActions("user_1");
    const action = catalog?.actions.find((entry) => entry.id === "neon.list_projects");

    await expect(action?.execute({}, actionContext)).rejects.toBeInstanceOf(ActionPermissionError);
    expect(clientMocks.executeListProjects).not.toHaveBeenCalled();
  });

  it("removes database querying when the connection permission is Off", async () => {
    vi.mocked(getNeonIntegrationState).mockResolvedValue({
      provider: "neon",
      connected: true,
      status: "connected",
      integrationId: "gint_neon",
      accountName: "Neon",
      statusReason: null,
      capabilityModes: { query: "off" },
    });

    const catalog = await resolveNeonActions("user_1");
    expect(catalog?.actions.map((action) => action.id)).toEqual(["neon.list_projects"]);
  });
});
