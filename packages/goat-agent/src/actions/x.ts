import { getDb } from "@opencompany/db/client";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { XAccessAuthError, xApiCall } from "../integrations/x";
import { effectiveCapabilityMode, providerCapability } from "./capabilities";
import {
  GoatActionAuthError,
  type GoatActionExecuteContext,
  GoatActionInvalidParamsError,
  GoatActionPermissionError,
  type GoatActionProviderCatalog,
  optionalStringParam,
  type ResolvedGoatAction,
  requiredStringParam,
} from "./types";

const X_PROVIDER = "x" as const;
const MAX_POST_TEXT_CHARS = 280;

type XConnection = {
  integrationId: string;
  username: string | null;
  displayName: string | null;
  scopes: string[];
  capabilityModes: unknown;
};

export async function resolveXActions(
  userWorkosId: string,
): Promise<GoatActionProviderCatalog | null> {
  const allConnections = await loadXConnections(userWorkosId);
  const postConnections = eligibleConnections(allConnections, "write").filter((connection) =>
    hasRequiredPostScopes(connection.scopes),
  );
  if (postConnections.length === 0) return null;

  const accountParam =
    postConnections.length > 1
      ? {
          account: {
            type: "string" as const,
            description: `Which connected X account to use. One of: ${postConnections
              .map((connection) => JSON.stringify(connectionLabel(connection)))
              .join(", ")}.`,
          },
        }
      : {};

  const actions: ResolvedGoatAction[] = [
    {
      id: "x.create_post",
      provider: X_PROVIDER,
      capability: "write",
      ...permissionAnnotation(postConnections),
      description:
        "Create one plain-text X post from the user's connected account. Use only when the user explicitly asks to post now and has already provided or approved the final copy. URLs in posts may incur higher X API costs.",
      params: {
        type: "object",
        additionalProperties: false,
        required: ["text", ...(postConnections.length > 1 ? ["account"] : [])],
        properties: {
          text: {
            type: "string",
            minLength: 1,
            maxLength: MAX_POST_TEXT_CHARS,
            description: "The exact post text to publish now.",
          },
          ...accountParam,
        },
      },
      execute: async (params, context) => {
        const connection = resolveConnection(
          postConnections,
          optionalStringParam(params, "account"),
        );
        const text = requiredStringParam(params, "text");
        if (text.length > MAX_POST_TEXT_CHARS) {
          throw new GoatActionInvalidParamsError(
            `"text" must be ${MAX_POST_TEXT_CHARS} characters or fewer for the initial X posting action.`,
          );
        }
        await assertStillPermitted(context, connection);
        try {
          const result = (await xApiCall({
            userWorkosId: context.userWorkosId,
            integrationId: connection.integrationId,
            path: "/tweets",
            method: "POST",
            body: { text },
            signal: context.signal,
          })) as { data?: { id?: string; text?: string } };
          const postId = result.data?.id;
          return {
            account: connectionLabel(connection),
            integrationId: connection.integrationId,
            postId,
            text: result.data?.text ?? text,
            ...(postId && connection.username
              ? { url: `https://x.com/${connection.username}/status/${postId}` }
              : {}),
          };
        } catch (error) {
          if (error instanceof XAccessAuthError) {
            throw new GoatActionAuthError(
              "auth_expired",
              X_PROVIDER,
              "X needs to be reconnected before Goat can post from this account.",
            );
          }
          throw error;
        }
      },
    },
  ];

  return {
    id: X_PROVIDER,
    label: `X (${postConnections.map(connectionLabel).join(", ")})`,
    description: "Create plain-text posts from your connected X account.",
    actions,
  };
}

async function loadXConnections(userWorkosId: string): Promise<XConnection[]> {
  const rows = await getDb()
    .select({
      integrationId: goatIntegrations.id,
      status: goatIntegrations.status,
      username: goatIntegrations.connectionLabel,
      displayName: goatIntegrations.accountName,
      scopes: goatIntegrations.scopes,
      capabilityModes: goatIntegrations.capabilityModes,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, X_PROVIDER),
        isNull(goatIntegrations.workspaceId),
        ne(goatIntegrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt));
  return rows
    .filter((row) => row.status === "connected")
    .map((row) => ({
      integrationId: row.integrationId,
      username: row.username?.replace(/^@/, "") ?? null,
      displayName: row.displayName,
      scopes: row.scopes,
      capabilityModes: row.capabilityModes,
    }));
}

function eligibleConnections(connections: XConnection[], capabilityId: "write") {
  return connections.filter(
    (connection) =>
      effectiveCapabilityMode(X_PROVIDER, capabilityId, connection.capabilityModes) !== "off",
  );
}

function permissionAnnotation(connections: XConnection[]) {
  const capability = providerCapability(X_PROVIDER, "write");
  const mode = connections.some(
    (connection) =>
      effectiveCapabilityMode(X_PROVIDER, "write", connection.capabilityModes) === "ask",
  )
    ? "ask"
    : "on";
  return mode === "ask"
    ? {
        permissionMode: "ask" as const,
        permission: {
          provider: X_PROVIDER,
          capabilityId: "write" as const,
          label: capability?.label ?? "Post to X",
          integrationIds: connections
            .filter(
              (connection) =>
                effectiveCapabilityMode(X_PROVIDER, "write", connection.capabilityModes) === "ask",
            )
            .map((connection) => connection.integrationId),
        },
      }
    : { permissionMode: "on" as const };
}

async function assertStillPermitted(context: GoatActionExecuteContext, connection: XConnection) {
  const [row] = await getDb()
    .select({
      capabilityModes: goatIntegrations.capabilityModes,
      status: goatIntegrations.status,
      scopes: goatIntegrations.scopes,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, connection.integrationId),
        eq(goatIntegrations.userWorkosId, context.userWorkosId),
        eq(goatIntegrations.provider, X_PROVIDER),
        isNull(goatIntegrations.workspaceId),
      ),
    )
    .limit(1);
  if (!row || row.status !== "connected") {
    throw new GoatActionAuthError(
      "not_connected",
      X_PROVIDER,
      "Connect X before asking Goat to post.",
    );
  }
  if (effectiveCapabilityMode(X_PROVIDER, "write", row.capabilityModes) === "off") {
    throw new GoatActionPermissionError(X_PROVIDER, "Posting to X is turned off for this account.");
  }
  if (!hasRequiredPostScopes(row.scopes)) {
    throw new GoatActionAuthError(
      "auth_expired",
      X_PROVIDER,
      "Reconnect X so Goat can request posting permissions.",
    );
  }
}

function resolveConnection(connections: XConnection[], account: string | undefined) {
  if (connections.length === 1 && !account) return connections[0]!;
  const normalized = account?.replace(/^@/, "").toLowerCase();
  const match = connections.find(
    (connection) => connectionLabel(connection).replace(/^@/, "").toLowerCase() === normalized,
  );
  if (!match) {
    throw new GoatActionInvalidParamsError(`Unknown X account "${account ?? ""}".`);
  }
  return match;
}

function hasRequiredPostScopes(scopes: string[]) {
  return ["tweet.write", "tweet.read", "users.read"].every((scope) => scopes.includes(scope));
}

function connectionLabel(connection: XConnection) {
  return connection.username ? `@${connection.username}` : connection.displayName || "X";
}
