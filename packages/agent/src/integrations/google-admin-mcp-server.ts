import { randomBytes } from "node:crypto";
import { isPluginGatewayRegistrationActive } from "@opencompany/db/plugin-gateway-repository";
import { createMcpHandler } from "mcp-handler";
import * as z from "zod";
import {
  type CapabilityId,
  effectiveCapabilityMode,
  isCapabilityMode,
} from "../actions/capabilities";
import { GoogleAccessAuthError, googleApiCall } from "./google-access-token";
import {
  type GoogleAdminMcpTicketPayload,
  verifyGoogleAdminMcpTicket,
} from "./google-admin-mcp-ticket";
import { googleAdminMcpScopesSatisfied } from "./google-admin-scopes";
import { loadGoogleAdminIntegration } from "./google-data";

const DIRECTORY_BASE = "https://admin.googleapis.com/admin/directory/v1";
const USER_FIELDS =
  "id,primaryEmail,name(givenName,familyName,fullName),suspended,orgUnitPath,creationTime";
const GROUP_FIELDS = "id,email,name,description,directMembersCount";
const MEMBER_FIELDS = "id,email,role,type,status";
const TOOL_CAPABILITIES = {
  list_users: "query",
  get_user: "query",
  create_user: "write",
  list_groups: "query",
  get_group: "query",
  create_group: "write",
  update_group: "write",
  list_group_members: "query",
  add_group_member: "write",
} as const satisfies Record<string, CapabilityId>;
type GoogleAdminMcpToolName = keyof typeof TOOL_CAPABILITIES;
type DbLike = any;
type AdminApiCall = typeof googleApiCall;
export type GoogleAdminMcpService = { handle(request: Request): Promise<Response> };

const key = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .refine((v) => v !== "." && v !== "..", "A resource id or email is required.");
const email = z.string().trim().email().max(320);
const pagination = {
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Results per page; defaults to 20."),
  pageToken: z.string().min(1).max(2048).optional(),
};
const listUsersSchema = {
  ...pagination,
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe("Google Directory user search expression, for example email:alex*."),
};
const getUserSchema = { userKey: key.describe("User id or primary email.") };
const createUserSchema = {
  primaryEmail: email.describe("New primary email in your Workspace domain."),
  givenName: z.string().trim().min(1).max(100),
  familyName: z.string().trim().min(1).max(100),
  orgUnitPath: z.string().trim().min(1).max(500).startsWith("/").optional(),
};
const getGroupSchema = { groupKey: key.describe("Group id or email.") };
const createGroupSchema = {
  email,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(1000).optional(),
};
const updateGroupSchema = {
  ...getGroupSchema,
  name: createGroupSchema.name.optional(),
  description: createGroupSchema.description,
};
const listMembersSchema = { ...getGroupSchema, ...pagination };
const addMemberSchema = {
  ...getGroupSchema,
  email,
  role: z
    .enum(["MEMBER", "MANAGER", "OWNER"])
    .optional()
    .describe("Defaults to MEMBER. MANAGER and OWNER grant additional group privileges."),
};
const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const CREATE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export function createGoogleAdminMcpService(input: {
  db: DbLike;
  internalSecret: string;
  adminApiCall?: AdminApiCall;
}): GoogleAdminMcpService {
  const apiCall = input.adminApiCall ?? googleApiCall;
  return {
    async handle(request) {
      const ticket = bearerToken(request);
      if (!ticket) return unauthorized("A Google Admin MCP bearer ticket is required.");
      const payload = verifyGoogleAdminMcpTicket({ ticket, secret: input.internalSecret });
      if (!payload) return unauthorized("The Google Admin MCP bearer ticket is invalid.");
      const policy = await authorizeRequest(request, payload);
      if (!policy.ok) return policy.response;
      const authorization = await authorizeTicket(input.db, payload);
      if (!authorization.ok) return authorization.response;
      const call = (
        method: "GET" | "POST" | "PATCH",
        path: string,
        fields: string,
        params: Record<string, string> = {},
        body?: unknown,
      ) => {
        const url = new URL(`${DIRECTORY_BASE}/${path}`);
        url.searchParams.set("fields", fields);
        for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
        return apiCall(
          {
            userWorkosId: payload.userWorkosId,
            integrationId: payload.integrationId,
            provider: "google_admin",
          },
          method,
          url,
          { signal: request.signal, ...(body !== undefined ? { body } : {}) },
        );
      };
      const handler = createMcpHandler(
        (server) => {
          server.registerTool(
            "list_users",
            {
              title: "List Workspace users",
              description:
                "List users in the connected administrator's Workspace customer. Returns a bounded directory profile, without recovery or security details.",
              inputSchema: listUsersSchema,
              annotations: READ,
            },
            async (args) =>
              runTool(async () => {
                const response = await call("GET", "users", `nextPageToken,users(${USER_FIELDS})`, {
                  customer: "my_customer",
                  ...pageParams(args),
                  ...(args.query ? { query: args.query } : {}),
                });
                return pageResult(response, "users", userResult, args.pageSize);
              }),
          );
          server.registerTool(
            "get_user",
            {
              title: "Get Workspace user",
              description: "Read a user's directory profile by id or email.",
              inputSchema: getUserSchema,
              annotations: READ,
            },
            async (args) =>
              runTool(async () =>
                userResult(
                  await call("GET", `users/${encodeURIComponent(args.userKey)}`, USER_FIELDS),
                ),
              ),
          );
          server.registerTool(
            "create_user",
            {
              title: "Create Workspace user",
              description:
                "Create a Google Workspace account. Google may assign a paid license according to the customer's licensing settings. A random initial password is generated server-side and discarded. After creation, an administrator must reset the password and send sign-in details through Google Admin. This tool does not send an invitation or grant admin privileges. If the result is uncertain, look up the email before retrying.",
              inputSchema: createUserSchema,
              annotations: CREATE,
            },
            async (args) =>
              runTool(async () => {
                const response = await call(
                  "POST",
                  "users",
                  USER_FIELDS,
                  {},
                  {
                    primaryEmail: args.primaryEmail,
                    name: { givenName: args.givenName, familyName: args.familyName },
                    password: randomBytes(32).toString("base64url"),
                    changePasswordAtNextLogin: true,
                    ...(args.orgUnitPath ? { orgUnitPath: args.orgUnitPath } : {}),
                  },
                );
                return {
                  user: userResult(response),
                  nextStep:
                    "In Google Admin, reset this user's password and send their sign-in details securely. No invitation has been sent.",
                  adminConsoleUrl: "https://admin.google.com/ac/users",
                };
              }),
          );
          server.registerTool(
            "list_groups",
            {
              title: "List Workspace groups",
              description: "List groups in the connected administrator's Workspace customer.",
              inputSchema: pagination,
              annotations: READ,
            },
            async (args) =>
              runTool(async () =>
                pageResult(
                  await call("GET", "groups", `nextPageToken,groups(${GROUP_FIELDS})`, {
                    customer: "my_customer",
                    ...pageParams(args),
                  }),
                  "groups",
                  groupResult,
                  args.pageSize,
                ),
              ),
          );
          server.registerTool(
            "get_group",
            {
              title: "Get Workspace group",
              description: "Read a group's email, name, description, and direct member count.",
              inputSchema: getGroupSchema,
              annotations: READ,
            },
            async (args) =>
              runTool(async () =>
                groupResult(
                  await call("GET", `groups/${encodeURIComponent(args.groupKey)}`, GROUP_FIELDS),
                ),
              ),
          );
          server.registerTool(
            "create_group",
            {
              title: "Create Workspace group",
              description:
                "Create a Google group in your Workspace domain. Posting, visibility, and external access policies use Google's defaults and must be reviewed in Google Admin. Check the email before retrying an uncertain creation.",
              inputSchema: createGroupSchema,
              annotations: CREATE,
            },
            async (args) =>
              runTool(async () =>
                groupResult(await call("POST", "groups", GROUP_FIELDS, {}, args)),
              ),
          );
          server.registerTool(
            "update_group",
            {
              title: "Edit Workspace group details",
              description:
                "Change a group's display name or description. Does not change its email, membership, posting policies, or visibility.",
              inputSchema: updateGroupSchema,
              annotations: { ...CREATE, destructiveHint: true, idempotentHint: true },
            },
            async (args) =>
              runTool(async () => {
                if (args.name === undefined && args.description === undefined)
                  throw new Error("Provide a name or description to update.");
                return groupResult(
                  await call(
                    "PATCH",
                    `groups/${encodeURIComponent(args.groupKey)}`,
                    GROUP_FIELDS,
                    {},
                    {
                      ...(args.name !== undefined ? { name: args.name } : {}),
                      ...(args.description !== undefined ? { description: args.description } : {}),
                    },
                  ),
                );
              }),
          );
          server.registerTool(
            "list_group_members",
            {
              title: "List group members",
              description:
                "List direct group memberships and roles. Does not expand nested group members.",
              inputSchema: listMembersSchema,
              annotations: READ,
            },
            async (args) =>
              runTool(async () =>
                pageResult(
                  await call(
                    "GET",
                    `groups/${encodeURIComponent(args.groupKey)}/members`,
                    `nextPageToken,members(${MEMBER_FIELDS})`,
                    pageParams(args),
                  ),
                  "members",
                  memberResult,
                  args.pageSize,
                ),
              ),
          );
          server.registerTool(
            "add_group_member",
            {
              title: "Add group member",
              description:
                "Add an email address to a group. Defaults to MEMBER; MANAGER and OWNER grant additional group privileges. External membership depends on Workspace policy. If the result is uncertain, check existing memberships before retrying.",
              inputSchema: addMemberSchema,
              annotations: CREATE,
            },
            async (args) =>
              runTool(async () =>
                memberResult(
                  await call(
                    "POST",
                    `groups/${encodeURIComponent(args.groupKey)}/members`,
                    MEMBER_FIELDS,
                    {},
                    { email: args.email, role: args.role ?? "MEMBER" },
                  ),
                ),
              ),
          );
        },
        {
          serverInfo: { name: "opencompany-google-admin", version: "1.0.0" },
          instructions:
            "Manage Workspace users and groups as the connected administrator. Read before changing existing resources. After creating a user, explain the required Google Admin password reset and secure sign-in handoff. Never claim an invitation was sent. User deletion, suspension, password resets, admin-role assignment, member removal, and group access-policy changes are unavailable.",
        },
        { streamableHttpEndpoint: "/mcp/plugins/google-admin", disableSse: true, maxDuration: 120 },
      );
      return handler(request);
    },
  };
}

async function authorizeTicket(db: DbLike, payload: GoogleAdminMcpTicketPayload) {
  const [active, row] = await Promise.all([
    isPluginGatewayRegistrationActive(db, {
      workspaceId: payload.workspaceId,
      userId: payload.userWorkosId,
      registrationId: payload.registrationId,
    }),
    loadGoogleAdminIntegration({ userWorkosId: payload.userWorkosId, db }),
  ]);
  if (!active) return forbidden("The Google Admin plugin is no longer enabled.");
  if (
    !row ||
    row.id !== payload.integrationId ||
    row.status !== "connected" ||
    !googleAdminMcpScopesSatisfied(row.scopes ?? [])
  ) {
    return {
      ok: false as const,
      response: unauthorized("The connected Google Admin account must be reauthorized."),
    };
  }
  if (payload.operation.type === "tools/call") {
    const capability = Object.hasOwn(TOOL_CAPABILITIES, payload.operation.tool)
      ? TOOL_CAPABILITIES[payload.operation.tool as GoogleAdminMcpToolName]
      : undefined;
    if (!capability || capability !== payload.operation.capability) {
      return forbidden("The Google Admin MCP ticket does not authorize this tool.");
    }
    const toolMode = row.toolModes?.[payload.operation.tool];
    const mode = isCapabilityMode(toolMode)
      ? toolMode
      : effectiveCapabilityMode("google_admin", capability, row.capabilityModes);
    if (mode === "off") {
      return forbidden("This Google Admin capability is disabled.");
    }
  }
  return { ok: true as const };
}

async function authorizeRequest(request: Request, payload: GoogleAdminMcpTicketPayload) {
  if (request.method !== "POST") {
    return { ok: false as const, response: methodNotAllowed() };
  }
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return { ok: false as const, response: badRequest("A JSON-RPC request body is required.") };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false as const, response: badRequest("JSON-RPC batches are not supported.") };
  }
  const rpc = body as Record<string, unknown>;
  const method = typeof rpc.method === "string" ? rpc.method : "";
  if (
    ["initialize", "notifications/initialized", "notifications/cancelled", "ping"].includes(method)
  ) {
    return { ok: true as const };
  }
  if (method === "tools/list" && payload.operation.type === "tools/list") {
    return { ok: true as const };
  }
  if (method === "tools/call" && payload.operation.type === "tools/call") {
    const params = rpc.params;
    if (
      params &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      (params as Record<string, unknown>).name === payload.operation.tool
    ) {
      return { ok: true as const };
    }
  }
  return {
    ok: false as const,
    response: forbidden("The Google Admin MCP ticket does not authorize this operation.").response,
  };
}

function pageParams(args: { pageSize?: number | undefined; pageToken?: string | undefined }) {
  return {
    maxResults: String(args.pageSize ?? 20),
    ...(args.pageToken ? { pageToken: args.pageToken } : {}),
  };
}
const profileString = z.string().max(2048).optional();
const userResponse = z.object({
  id: z.string().min(1),
  primaryEmail: profileString,
  name: z
    .object({ givenName: profileString, familyName: profileString, fullName: profileString })
    .optional(),
  suspended: z.boolean().optional(),
  orgUnitPath: profileString,
  creationTime: profileString,
});
const groupResponse = z.object({
  id: z.string().min(1),
  email: profileString,
  name: profileString,
  description: z.string().max(10000).optional(),
  directMembersCount: profileString,
});
const memberResponse = z.object({
  id: z.string().min(1),
  email: profileString,
  role: profileString,
  type: profileString,
  status: profileString,
});
function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error(
      "Google Admin returned an unexpected response. Check the resource before retrying a change.",
    );
  return result.data;
}
function userResult(value: unknown) {
  return parseResponse(userResponse, value);
}
function groupResult(value: unknown) {
  return parseResponse(groupResponse, value);
}
function memberResult(value: unknown) {
  return parseResponse(memberResponse, value);
}
function pageResult(
  value: unknown,
  field: string,
  compact: (value: unknown) => unknown,
  pageSize = 20,
) {
  const response = parseResponse(z.record(z.string(), z.unknown()), value);
  const items =
    response[field] === undefined ? [] : parseResponse(z.array(z.unknown()), response[field]);
  const nextPageToken = parseResponse(z.string().max(2048).optional(), response.nextPageToken);
  return {
    [field]: items.slice(0, pageSize).map(compact),
    ...(nextPageToken ? { nextPageToken } : {}),
  };
}
async function runTool(run: () => Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await run()) }] };
  } catch (error) {
    if (error instanceof GoogleAccessAuthError)
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: {
                code: "auth_expired",
                message: "Reconnect Google Admin to authorize directory access.",
              },
            }),
          },
        ],
      };
    // Do not relay provider error bodies: a failed user insert could echo its password.
    const message =
      error instanceof Error && /^(Provide a name|Google Admin returned)/u.test(error.message)
        ? error.message
        : "Google Admin could not complete this request. Check administrator privileges, the Admin SDK API, and the resource. Before retrying a change, read the resource to confirm whether it succeeded.";
    return { isError: true, content: [{ type: "text" as const, text: message }] };
  }
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
  return match?.[1] ?? null;
}

function unauthorized(message: string) {
  return Response.json(
    { error: message },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="google-admin-mcp"' } },
  );
}

function forbidden(message: string) {
  return { ok: false as const, response: Response.json({ error: message }, { status: 403 }) };
}

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

function methodNotAllowed() {
  return Response.json({ error: "Only POST is supported." }, { status: 405 });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function boundedString(value: unknown, maxChars: number) {
  const result = string(value);
  return result && result.length <= maxChars ? result : undefined;
}

function googleUrl(value: unknown) {
  const candidate = boundedString(value, 2_048);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" &&
      (url.hostname === "google.com" || url.hostname.endsWith(".google.com"))
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
