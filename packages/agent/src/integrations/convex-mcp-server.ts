import { isPluginGatewayRegistrationActive } from "@opencompany/db/plugin-gateway-repository";
import Ajv from "ajv";
import { effectiveCapabilityMode, isCapabilityMode } from "../actions/capabilities";
import { runConvexCli } from "./convex-cli";
import { loadConvexCredential, loadConvexIntegration } from "./convex-mcp";
import { verifyConvexMcpTicket } from "./convex-mcp-ticket";
import {
  CONVEX_TOOL_CAPABILITIES,
  convexToolAllowedInProduction,
  isConvexToolName,
  parseConvexDeployKey,
} from "./convex-policy";
import upstreamTools from "./convex-tools.json";

// Captured from convex@1.45.0 tools/list. The bridge owns deployment selection, so callers
// neither supply filesystem paths nor receive selectors containing server-side paths.
export const CONVEX_MCP_TOOLS = [
  {
    name: "status",
    annotations: { readOnlyHint: true },
    description: "Inspect the connected Convex deployment and its production restrictions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  ...upstreamTools.map((tool) => {
    const { deploymentSelector: _, ...properties } = tool.inputSchema.properties;
    return {
      ...tool,
      annotations: { readOnlyHint: !["run", "envSet", "envRemove"].includes(tool.name) },
      description: `${tool.description}\nUses only the deployment connected in Settings.`,
      inputSchema: {
        ...tool.inputSchema,
        properties,
        required: tool.inputSchema.required.filter((name) => name !== "deploymentSelector"),
        additionalProperties: false,
      },
    };
  }),
];
const ajv = new Ajv({ strict: false });
const validators = new Map(
  CONVEX_MCP_TOOLS.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
);

export type ConvexMcpService = { handle(request: Request): Promise<Response> };

export function createConvexMcpService(input: {
  db: any;
  internalSecret: string;
  runCli?: typeof runConvexCli;
}): ConvexMcpService {
  return {
    async handle(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const ticket = request.headers.get("authorization")?.match(/^Bearer (\S+)$/u)?.[1];
      const payload = ticket && verifyConvexMcpTicket({ ticket, secret: input.internalSecret });
      if (!payload) return unauthorized();
      const [active, row] = await Promise.all([
        isPluginGatewayRegistrationActive(input.db, {
          workspaceId: payload.workspaceId,
          userId: payload.userWorkosId,
          registrationId: payload.registrationId,
        }),
        loadConvexIntegration(input.db, payload.userWorkosId),
      ]);
      if (!active) return forbidden("The Convex plugin is no longer enabled.");
      if (!row || row.id !== payload.integrationId || row.status !== "connected")
        return unauthorized();
      const credential = await loadConvexCredential(payload.userWorkosId, row.id, input.db);
      const apiKey = credential?.apiKey;
      const deployment = apiKey && parseConvexDeployKey(apiKey);
      if (!apiKey || !deployment || payload.connectionVersion !== credential.connectionVersion)
        return unauthorized();
      let rpc: Record<string, unknown>;
      try {
        const reader = request.body?.getReader();
        if (!reader) return new Response(null, { status: 400 });
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 128 * 1024) {
            await reader.cancel();
            return new Response(null, { status: 413 });
          }
          chunks.push(value);
        }
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          parsed.jsonrpc !== "2.0"
        )
          return new Response(null, { status: 400 });
        rpc = parsed;
      } catch {
        return new Response(null, { status: 400 });
      }
      const reply = (result: unknown) =>
        Response.json({ jsonrpc: "2.0", id: rpc.id ?? null, result });
      if (rpc.method === "notifications/initialized" || rpc.method === "notifications/cancelled")
        return new Response(null, { status: 202 });
      if (rpc.method === "initialize")
        return reply({
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "opencompany-convex", version: "1.0.0" },
        });
      if (rpc.method === "ping") return reply({});
      if (rpc.method === "tools/list" && payload.operation.type === "tools/list") {
        return reply({
          tools: CONVEX_MCP_TOOLS.filter(
            (tool) =>
              isConvexToolName(tool.name) &&
              (deployment.type !== "prod" || convexToolAllowedInProduction(tool.name)),
          ),
        });
      }
      const params = rpc.params as { name?: unknown; arguments?: unknown } | undefined;
      if (
        rpc.method !== "tools/call" ||
        payload.operation.type !== "tools/call" ||
        !params ||
        params.name !== payload.operation.tool ||
        !isConvexToolName(payload.operation.tool)
      )
        return forbidden("This ticket does not authorize the operation.");
      const tool = payload.operation.tool;
      const capability = CONVEX_TOOL_CAPABILITIES[tool];
      if (capability !== payload.operation.capability)
        return forbidden("This ticket does not authorize the capability.");
      const override = row.toolModes?.[tool];
      const mode = isCapabilityMode(override)
        ? override
        : effectiveCapabilityMode("convex", capability, row.capabilityModes);
      if (mode === "off") return forbidden("This Convex capability is disabled.");
      if (deployment.type === "prod" && !convexToolAllowedInProduction(tool))
        return forbidden("Production deployments support schema and function inspection only.");
      const args = params.arguments ?? {};
      if (!validators.get(tool)?.(args))
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          error: {
            code: -32602,
            message:
              "Invalid Convex tool arguments. Use the discovered schema; deployment selection is managed by Settings.",
          },
        });
      if (tool === "status")
        return reply({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                deployment: deployment.name,
                type: deployment.type,
                url: `https://${deployment.name}.convex.cloud`,
                productionInspectionOnly: deployment.type === "prod",
              }),
            },
          ],
        });
      try {
        return reply(
          await (input.runCli ?? runConvexCli)({
            apiKey,
            tool,
            args: args as Record<string, unknown>,
            signal: request.signal,
          }),
        );
      } catch {
        // Do not propagate process errors or provider bodies into application logs or auth responses.
        return reply({
          isError: true,
          content: [
            {
              type: "text",
              text: "Convex could not complete this request. Check the deploy key and its permissions, or narrow the request and try again.",
            },
          ],
        });
      }
    },
  };
}

function unauthorized() {
  return Response.json(
    { error: "Convex needs to be reconnected in Settings." },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="convex-mcp"' } },
  );
}
function forbidden(error: string) {
  return Response.json({ error }, { status: 403 });
}
