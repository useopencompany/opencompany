import { createMCPClient } from "@ai-sdk/mcp";
import { describe, expect, it, vi } from "vitest";
import { executeAction } from "./execute";
import { type RemoteMcpGatewayRegistration, resolveRemoteMcpActions } from "./remote-mcp";
import { createInMemoryActionTurnGovernance, serveActionRequest } from "./service";

vi.mock("@opencompany/analytics/product/server", () => ({
  captureProductServerEvent: vi.fn(async () => undefined),
}));
const identity = { userWorkosId: "diagnostic-user", workspaceId: "diagnostic-workspace" };
const registration: RemoteMcpGatewayRegistration = {
  pluginName: "diagnostic",
  source: "plugin:diagnostic:mcp",
  connectionProvider: "posthog",
  label: "Diagnostic",
  description: "Synthetic read tool",
  server: {
    name: "diagnostic",
    type: "streamable-http",
    url: "https://diagnostic.invalid/mcp",
    headers: {},
  },
  discoverySnapshot: [
    {
      name: "read",
      inputSchema: { type: "object" },
      classification: {
        capabilityId: "read",
        capabilityLabel: "Read",
        defaultMode: "on",
        bucket: "read",
        curated: true,
      },
    },
  ],
  getState: async () => ({
    connected: true,
    integrationId: "diagnostic-connection",
    capabilityModes: {},
    toolModes: {},
  }),
  loadConnection: async () => ({ ok: true, integrationId: "diagnostic-connection" }),
  isEnabled: async () => true,
};

async function harness(
  failure: (id: number, args: Record<string, unknown>) => Response | undefined,
  failureCount = 1,
  schema: Record<string, unknown> = { type: "object" },
) {
  let dispatches = 0;
  let connections = 0;
  const remote = await resolveRemoteMcpActions(
    identity,
    {
      ...registration,
      discoverySnapshot: [{ ...registration.discoverySnapshot[0]!, inputSchema: schema }],
    },
    {
      recordDispatch: async () => {},
      createClient: async (config) => {
        connections++;
        return createMCPClient({
          ...config,
          transport: {
            ...config.transport,
            fetch: async (_url, init) => {
              if (init?.method === "DELETE") return new Response(null, { status: 204 });
              const request = JSON.parse(String(init?.body));
              if (request.method === "server/discover")
                return Response.json({
                  jsonrpc: "2.0",
                  id: request.id,
                  result: {
                    resultType: "complete",
                    supportedVersions: ["2026-07-28"],
                    capabilities: { tools: {} },
                  },
                });
              dispatches++;
              if (dispatches <= failureCount) {
                const response = failure(request.id, request.params?.arguments ?? {});
                if (response) return response;
              }
              return Response.json({
                jsonrpc: "2.0",
                id: request.id,
                result: {
                  resultType: "complete",
                  content: [{ type: "text", text: '{"recovered":true}' }],
                },
              });
            },
          },
        });
      },
    },
  );
  const action = remote!.actions[0]!;
  const execute = (params: Record<string, unknown> = {}) =>
    executeAction({
      catalog: { providers: [remote!], actions: [action] },
      actionId: action.id,
      params,
      ...identity,
      signal: new AbortController().signal,
      currentDate: new Date(),
      userTimezone: "UTC",
    });
  return { execute, action, dispatches: () => dispatches, connections: () => connections };
}

describe("remote MCP error classification through the action service", () => {
  it("lets the model correct invalid parameters without exhausting provider attempts", async () => {
    const h = await harness(
      (id) =>
        Response.json(
          {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: "Invalid date parameter",
            },
          },
          { status: 400 },
        ),
      2,
    );
    const governance = createInMemoryActionTurnGovernance();
    const source = registration.source;
    await governance.recordSourceDiscovery(source);
    const execute = vi.fn(({ params }: { params: Record<string, unknown> }) => h.execute(params));
    const catalog = {
      sources: [{ id: source, label: "Diagnostic", description: "Diagnostic" }],
      actions: [
        {
          id: h.action.id,
          source,
          description: "Read",
          params: { type: "object" },
        },
      ],
    };
    const results = [];
    for (let i = 0; i < 3; i++)
      results.push(
        await serveActionRequest({
          catalog,
          governance,
          execute,
          request: {
            operation: "execute",
            sessionId: "diagnostic-session",
            turnId: "diagnostic-turn",
            invocationId: `call-${i}`,
            action: h.action.id,
            params: { date: i === 2 ? "2026-09-10" : "invalid" },
          },
        }),
      );
    expect(results[0]).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(results[1]).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(results[2]).toMatchObject({ ok: true, result: { recovered: true } });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(h.dispatches()).toBe(3);
  });

  it.each([undefined, "https://json-schema.org/draft/2020-12/schema"])(
    "rejects the observed object filter locally and allows corrected parallel queries (%s)",
    async (dialect) => {
      const schema = {
        type: "object",
        ...(dialect ? { $schema: dialect } : {}),
        properties: {
          properties: { type: "array", items: { type: "object" } },
        },
      };
      const h = await harness(
        (id, args) =>
          Array.isArray(args.properties)
            ? undefined
            : Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                  resultType: "complete",
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: 'Invalid input for "query-trends": parameter "properties" must be of type array',
                    },
                  ],
                },
              }),
        Infinity,
        schema,
      );
      const governance = createInMemoryActionTurnGovernance();
      const source = registration.source;
      await governance.recordSourceDiscovery(source);
      const catalog = {
        sources: [{ id: source, label: "Diagnostic", description: "Read" }],
        actions: [{ id: h.action.id, source, description: "Read", params: schema }],
      };
      const call = (invocationId: string, properties: unknown) =>
        serveActionRequest({
          catalog,
          governance,
          execute: ({ params }) => h.execute(params),
          request: {
            operation: "execute",
            sessionId: "session",
            turnId: "turn",
            invocationId,
            action: h.action.id,
            params: { properties },
          },
        });
      const malformed = {
        type: "AND",
        values: [
          {
            type: "AND",
            values: [{ key: "name", type: "person", value: "example", operator: "icontains" }],
          },
        ],
      };
      const failures = await Promise.all([call("bad-1", malformed), call("bad-2", malformed)]);
      for (const failure of failures)
        expect(failure).toMatchObject({
          ok: false,
          error: { code: "invalid_params", message: expect.stringContaining("must be array") },
        });
      expect(h.connections()).toBe(0);
      expect(h.dispatches()).toBe(0);
      const filter = malformed.values[0]!.values;
      const recovered = await Promise.all([call("fixed-1", filter), call("fixed-2", filter)]);
      for (const result of recovered)
        expect(result).toMatchObject({ ok: true, result: { recovered: true } });
      expect(h.dispatches()).toBe(2);
    },
  );

  it.each([-32601, -32603])("preserves JSON-RPC error %s as a provider failure", async (code) => {
    const h = await harness((id) =>
      Response.json(
        { jsonrpc: "2.0", id, error: { code, message: "Provider error" } },
        { status: 400 },
      ),
    );
    expect(await h.execute()).toMatchObject({ ok: false, error: { code: "provider_error" } });
  });

  it("does not infer invalid parameters from unstructured tool error text", async () => {
    const h = await harness((id) =>
      Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          isError: true,
          content: [{ type: "text", text: "invalid params" }],
        },
      }),
    );
    expect(await h.execute()).toMatchObject({ ok: false, error: { code: "provider_error" } });
  });

  it.each([429, 503])("keeps HTTP %s failures distinct from invalid parameters", async (status) => {
    const h = await harness(() => new Response("temporarily unavailable", { status }));
    expect(await h.execute()).toMatchObject({ ok: false, error: { code: "provider_error" } });
  });
});
