import { NextResponse } from "next/server";
import {
  getPersonalBrainFile,
  getPersonalMemory,
  type OpenCompanyMcpScope,
  searchPersonalBrain,
  searchPersonalMemory,
} from "@/lib/mcp/opencompany-context";
import { authenticatePersonalMcpToken } from "@/lib/personal/mcp-tokens";

export const dynamic = "force-dynamic";

const JSON_RPC_VERSION = "2.0";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const MCP_HEADERS = {
  "Cache-Control": "private, no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version",
} as const;

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

type ToolCallResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

const TOOLS = [
  {
    name: "search_memory",
    description:
      "Search the user's OpenCompany personal memory. Use this for durable facts, preferences, people, companies, projects, decisions, and evidence-backed notes.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        limit: { type: "number", description: "Maximum results to return, up to 20." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_memory",
    description:
      "Read one OpenCompany personal memory record by id or memory-relative path returned from search_memory.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Memory id, e.g. acme, or path, e.g. companies/acme.md.",
        },
        path: {
          type: "string",
          description:
            "Memory-relative path, e.g. companies/acme.md. Either id or path is accepted.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_personal_brain",
    description:
      "Search user-authored OpenCompany Personal Brain notes. Use this for private notes, documents, and knowledge the user deliberately saved.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        limit: { type: "number", description: "Maximum results to return, up to 20." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_personal_brain_file",
    description:
      "Read one OpenCompany Personal Brain file by personal-brain-relative path returned from search_personal_brain.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Personal Brain path, e.g. notes/customer.md." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
] as const;

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: MCP_HEADERS });
}

export async function POST(request: Request) {
  const auth = await authenticatePersonalMcpToken(request.headers.get("authorization"));
  if (!auth) {
    return NextResponse.json(
      {
        error: "unauthorized",
        message: "Provide a valid OpenCompany personal MCP bearer token.",
      },
      {
        status: 401,
        headers: { ...MCP_HEADERS, "WWW-Authenticate": 'Bearer realm="OpenCompany MCP"' },
      },
    );
  }
  const scope: OpenCompanyMcpScope = { workspaceId: auth.workspaceId, userId: auth.userId };

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonRpc(errorResponse(null, -32700, "Parse error"), 400);
  }

  const requests = Array.isArray(body) ? body : [body];
  if (requests.length === 0) {
    return jsonRpc(errorResponse(null, -32600, "Invalid Request"), 400);
  }

  const responses: JsonRpcResponse[] = [];
  for (const item of requests) {
    const response = await handleJsonRpc(scope, item);
    if (response) responses.push(response);
  }

  if (responses.length === 0) {
    return new Response(null, { status: 204, headers: MCP_HEADERS });
  }
  return jsonRpc(Array.isArray(body) ? responses : responses[0]);
}

async function handleJsonRpc(
  scope: OpenCompanyMcpScope,
  value: unknown,
): Promise<JsonRpcResponse | null> {
  if (!isRequestObject(value)) {
    return errorResponse(null, -32600, "Invalid Request");
  }

  const id = isJsonRpcId(value.id) ? value.id : null;
  if (value.jsonrpc !== JSON_RPC_VERSION || typeof value.method !== "string") {
    return errorResponse(id, -32600, "Invalid Request");
  }

  try {
    switch (value.method) {
      case "initialize":
        return resultResponse(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "opencompany", version: "0.2.0" },
          instructions:
            "OpenCompany exposes read-only personal memory and personal brain context. Search first, then fetch individual records by id or path when needed.",
        });
      case "notifications/initialized":
        return value.id === undefined ? null : resultResponse(id, {});
      case "tools/list":
        return resultResponse(id, { tools: TOOLS });
      case "tools/call":
        return resultResponse(id, await callTool(scope, value.params));
      default:
        return errorResponse(id, -32601, `Method not found: ${value.method}`);
    }
  } catch (error) {
    if (error instanceof JsonRpcParamError) {
      return errorResponse(id, -32602, error.message);
    }
    return errorResponse(id, -32603, "Internal error", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function callTool(scope: OpenCompanyMcpScope, params: unknown): Promise<ToolCallResult> {
  if (!isRecord(params) || typeof params.name !== "string") {
    throw new JsonRpcParamError("tools/call requires a tool name.");
  }
  const args = isRecord(params.arguments) ? params.arguments : {};

  if (params.name === "search_memory") {
    const query = stringArg(args, "query");
    const limit = numberArg(args, "limit");
    const results = await searchPersonalMemory(scope, { query, ...(limit ? { limit } : {}) });
    return toolResult(formatSearchResults("memory", results), { results });
  }

  if (params.name === "get_memory") {
    const idOrPath = stringArg(args, "id", false) ?? stringArg(args, "path", false);
    if (!idOrPath) return toolError("get_memory requires id or path.");
    const memory = await getPersonalMemory(scope, { idOrPath });
    if (!memory) return toolError(`No memory record found for ${idOrPath}.`);
    return toolResult(
      [`# ${memory.title}`, "", memory.compiledTruth || memory.content].join("\n"),
      { memory },
    );
  }

  if (params.name === "search_personal_brain") {
    const query = stringArg(args, "query");
    const limit = numberArg(args, "limit");
    const results = await searchPersonalBrain(scope, { query, ...(limit ? { limit } : {}) });
    return toolResult(formatSearchResults("personal brain", results), { results });
  }

  if (params.name === "get_personal_brain_file") {
    const path = stringArg(args, "path");
    const file = await getPersonalBrainFile(scope, { path });
    if (!file) return toolError(`No Personal Brain file found at ${path}.`);
    return toolResult(file.content, { file });
  }

  return toolError(`Unknown OpenCompany MCP tool: ${params.name}`);
}

function formatSearchResults(
  label: string,
  results: Array<{ path: string; title: string; snippet: string; updatedAt: string }>,
) {
  if (results.length === 0) return `No ${label} results found.`;
  return results
    .map((result, index) =>
      [
        `${index + 1}. ${result.title}`,
        `Path: ${result.path}`,
        `Updated: ${result.updatedAt}`,
        result.snippet,
      ].join("\n"),
    )
    .join("\n\n");
}

function toolResult(text: string, structuredContent?: unknown): ToolCallResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function toolError(text: string): ToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

function stringArg(args: Record<string, unknown>, key: string): string;
function stringArg(args: Record<string, unknown>, key: string, required: false): string | null;
function stringArg(args: Record<string, unknown>, key: string, required = true) {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!required) return null;
  throw new JsonRpcParamError(`${key} must be a non-empty string.`);
}

function numberArg(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function jsonRpc(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: MCP_HEADERS });
}

function resultResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message, ...(data ? { data } : {}) } };
}

function isRequestObject(value: unknown): value is JsonRpcRequest {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || typeof value === "number";
}

class JsonRpcParamError extends Error {}
