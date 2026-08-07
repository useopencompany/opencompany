import { getDb } from "@opencompany/db/client";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq, ne } from "drizzle-orm";
import { GoatXAccessAuthError, xAccountApiCall } from "../integrations/x-access-token";
import { effectiveCapabilityMode } from "./capabilities";
import {
  GOAT_ACTION_EFFECTS_WRITE,
  GoatActionAuthError,
  type GoatActionExecuteContext,
  GoatActionInvalidParamsError,
  GoatActionPermissionError,
  type GoatActionProviderCatalog,
  optionalStringParam,
  type ResolvedGoatAction,
  requiredStringParam,
} from "./types";

const X_TWEETS_URL = "https://api.x.com/2/tweets";
// X enforces the real per-account character limit (280 standard, longer for
// Premium accounts); this is only a sanity bound against pathological input.
const MAX_TWEET_CHARS = 25_000;

type XAccountConnection = {
  integrationId: string;
  username: string | null;
  name: string | null;
  capabilityModes: unknown;
};

export async function resolveXAccountActions(
  userWorkosId: string,
): Promise<GoatActionProviderCatalog | null> {
  const connections = (await loadXAccountConnections(userWorkosId)).filter(
    (connection) =>
      effectiveCapabilityMode("x_account", "write", connection.capabilityModes) !== "off",
  );
  if (connections.length === 0) return null;

  return {
    id: "x_account",
    label:
      connections.length === 1
        ? `X (${connectionLabel(connections[0]!)})`
        : `X (${connections.length} accounts)`,
    description: "Post new tweets from a connected X account.",
    actions: [postTweetAction(connections)],
  };
}

function postTweetAction(connections: readonly XAccountConnection[]): ResolvedGoatAction {
  const accountParam =
    connections.length > 1
      ? {
          account: {
            type: "string" as const,
            description: `Which connected X account should post. One of: ${connections
              .map((connection) => JSON.stringify(connectionLabel(connection)))
              .join(", ")}.`,
          },
        }
      : {};
  const required = ["text"];
  if (connections.length > 1) required.push("account");

  return {
    id: "x_account.post_tweet",
    provider: "x_account",
    capability: "write",
    effects: GOAT_ACTION_EFFECTS_WRITE,
    ...permissionAnnotation(connections),
    description:
      "Post a new tweet from a connected X account. Use only when the user explicitly asked to post it. This does not reply to, quote, or delete existing posts.",
    params: {
      type: "object",
      additionalProperties: false,
      required,
      properties: {
        text: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TWEET_CHARS,
          description: "The tweet text to post.",
        },
        ...accountParam,
      },
    },
    execute: async (params, context) => {
      const connection = resolveConnection(connections, optionalStringParam(params, "account"));
      const text = requiredStringParam(params, "text");
      if (text.length > MAX_TWEET_CHARS) {
        throw new GoatActionInvalidParamsError(`"text" exceeds ${MAX_TWEET_CHARS} characters.`);
      }
      await assertXAccountWriteStillEnabled(context.userWorkosId, connection);

      const response = (await postTweet(context, connection, text)) as {
        data?: { id?: string; text?: string };
      };
      const id = response.data?.id;
      if (!id) {
        throw new Error("X did not return the posted tweet id.");
      }
      return {
        account: connectionLabel(connection),
        integrationId: connection.integrationId,
        tweet: {
          id,
          text: response.data?.text ?? text,
          ...(connection.username
            ? { url: `https://x.com/${connection.username}/status/${id}` }
            : {}),
        },
      };
    },
  };
}

async function postTweet(
  context: GoatActionExecuteContext,
  connection: XAccountConnection,
  text: string,
): Promise<unknown> {
  try {
    return await xAccountApiCall(
      { userWorkosId: context.userWorkosId, integrationId: connection.integrationId },
      "POST",
      new URL(X_TWEETS_URL),
      { signal: context.signal, body: { text } },
    );
  } catch (error) {
    if (error instanceof GoatXAccessAuthError) {
      throw new GoatActionAuthError(
        "auth_expired",
        "x_account",
        `Reconnect X for ${connectionLabel(connection)} in Settings → Integrations, then retry.`,
      );
    }
    throw error;
  }
}

function permissionAnnotation(
  connections: readonly XAccountConnection[],
): Pick<ResolvedGoatAction, "permissionMode" | "permission"> {
  const askIntegrationIds = connections
    .filter(
      (connection) =>
        effectiveCapabilityMode("x_account", "write", connection.capabilityModes) === "ask",
    )
    .map((connection) => connection.integrationId);
  if (askIntegrationIds.length === 0) return { permissionMode: "on" };
  return {
    permissionMode: "ask",
    permission: {
      provider: "x_account",
      capabilityId: "write",
      label: "Post to X",
      integrationIds: askIntegrationIds,
    },
  };
}

async function assertXAccountWriteStillEnabled(
  userWorkosId: string,
  connection: XAccountConnection,
): Promise<void> {
  const rows = await getDb()
    .select({
      status: goatIntegrations.status,
      capabilityModes: goatIntegrations.capabilityModes,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, connection.integrationId),
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, "x_account"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.status !== "connected") {
    throw new GoatActionAuthError(
      "auth_expired",
      "x_account",
      `Reconnect X for ${connectionLabel(connection)} in Settings → Integrations, then retry.`,
    );
  }
  if (effectiveCapabilityMode("x_account", "write", row.capabilityModes) === "off") {
    throw new GoatActionPermissionError(
      "x_account",
      `Posting to X is turned off for ${connectionLabel(connection)}. It can be changed under Settings → Integrations.`,
    );
  }
}

async function loadXAccountConnections(userWorkosId: string): Promise<XAccountConnection[]> {
  const rows = await getDb()
    .select({
      integrationId: goatIntegrations.id,
      connectionLabel: goatIntegrations.connectionLabel,
      accountName: goatIntegrations.accountName,
      status: goatIntegrations.status,
      capabilityModes: goatIntegrations.capabilityModes,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, "x_account"),
        ne(goatIntegrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt));

  return rows
    .filter((row) => row.status === "connected")
    .map((row) => ({
      integrationId: row.integrationId,
      // connectionLabel stores "@username" (see connectGoatXAccountIntegration).
      username: row.connectionLabel?.replace(/^@/, "") || null,
      name: row.accountName,
      capabilityModes: row.capabilityModes,
    }));
}

function resolveConnection(
  connections: readonly XAccountConnection[],
  account: string | undefined,
): XAccountConnection {
  if (account) {
    const wanted = account.toLowerCase().replace(/^@/, "");
    const match = connections.find((entry) => entry.username?.toLowerCase() === wanted);
    if (!match) {
      throw new GoatActionInvalidParamsError(
        `No connected X account matches ${JSON.stringify(account)}. Connected accounts: ${connections
          .map((entry) => JSON.stringify(connectionLabel(entry)))
          .join(", ")}.`,
      );
    }
    return match;
  }
  if (connections.length === 1) return connections[0]!;
  throw new GoatActionInvalidParamsError(
    `Multiple X accounts are connected; pass account as one of: ${connections
      .map((entry) => JSON.stringify(connectionLabel(entry)))
      .join(", ")}.`,
  );
}

function connectionLabel(connection: XAccountConnection) {
  if (connection.username) return `@${connection.username}`;
  return connection.name?.trim() || "X account";
}
