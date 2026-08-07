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

type XAccountPostTarget = {
  connection: XAccountConnection;
  text: string;
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
    description: "Publish account-specific posts from one or more connected X accounts.",
    actions: [postTweetAction(connections)],
  };
}

function postTweetAction(connections: readonly XAccountConnection[]): ResolvedGoatAction {
  const multipleAccounts = connections.length > 1;
  const params: ResolvedGoatAction["params"] = multipleAccounts
    ? {
        type: "object",
        additionalProperties: false,
        required: ["posts"],
        properties: {
          posts: {
            type: "array",
            minItems: 1,
            maxItems: connections.length,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["account", "text"],
              properties: {
                account: {
                  type: "string",
                  enum: connections.map((connection) => connectionLabel(connection)),
                  description: "The connected X account that should publish this post.",
                },
                text: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_TWEET_CHARS,
                  description:
                    "Account-specific post text. It must not be identical or substantially similar to text for another account.",
                },
              },
            },
            description:
              "One account-specific post per selected X account. Include each requested account once and tailor its text for that audience.",
          },
        },
      }
    : {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TWEET_CHARS,
            description: "The post text to publish.",
          },
        },
      };

  return {
    id: "x_account.post_tweet",
    provider: "x_account",
    capability: "write",
    effects: GOAT_ACTION_EFFECTS_WRITE,
    ...permissionAnnotation(connections),
    description:
      "Create new posts from one or more connected X accounts. Use only when the user explicitly asked to post. For multiple accounts, provide distinct account-specific copy in one call: X prohibits identical or substantially similar posts across accounts. This does not reply to, quote, or delete existing posts.",
    params,
    execute: async (params, context) => {
      const targets = resolvePostTargets(connections, params);

      // Validate every selected connection before dispatching any external
      // writes. A settings change must not turn a requested multi-account post
      // into a preventable partial success.
      await Promise.all(
        targets.map((target) =>
          assertXAccountWriteStillEnabled(context.userWorkosId, target.connection),
        ),
      );

      // X authenticates one account per request, so multi-account posting is a
      // controlled fan-out. Once dispatch starts, never throw away successful
      // results: the model needs them to report partial success without
      // retrying accounts that already posted.
      const settled = await Promise.allSettled(
        targets.map(async (target) => {
          const response = (await postTweet(context, target.connection, target.text)) as {
            data?: { id?: string; text?: string };
          };
          const id = response.data?.id;
          if (!id) throw new Error("X did not return the posted tweet id.");
          return {
            account: connectionLabel(target.connection),
            integrationId: target.connection.integrationId,
            tweet: {
              id,
              text: response.data?.text ?? target.text,
              ...(target.connection.username
                ? { url: `https://x.com/${target.connection.username}/status/${id}` }
                : {}),
            },
          };
        }),
      );
      const posts: Array<{
        account: string;
        integrationId: string;
        tweet: { id: string; text: string; url?: string };
      }> = [];
      const failures: Array<{ account: string; integrationId: string; error: string }> = [];
      settled.forEach((result, index) => {
        const connection = targets[index]!.connection;
        if (result.status === "fulfilled") {
          posts.push(result.value);
          return;
        }
        failures.push({
          account: connectionLabel(connection),
          integrationId: connection.integrationId,
          error: safePostError(result.reason),
        });
      });

      return {
        status: failures.length === 0 ? "posted" : posts.length > 0 ? "partial" : "failed",
        posts,
        failures,
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

function resolvePostTargets(
  connections: readonly XAccountConnection[],
  params: Record<string, unknown>,
): XAccountPostTarget[] {
  if (connections.length === 1) {
    const text = requiredStringParam(params, "text");
    assertPostTextLength(text, "text");
    return [{ connection: connections[0]!, text }];
  }

  const posts = params.posts;
  if (!Array.isArray(posts) || posts.length === 0) {
    throw new GoatActionInvalidParamsError(
      '"posts" is required and must contain at least one account-specific post.',
    );
  }
  if (posts.length > connections.length) {
    throw new GoatActionInvalidParamsError(
      `"posts" cannot contain more than ${connections.length} connected accounts.`,
    );
  }

  const seen = new Set<string>();
  const targets = posts.map((post, index) => {
    if (!post || typeof post !== "object" || Array.isArray(post)) {
      throw new GoatActionInvalidParamsError(`"posts[${index}]" must be an object.`);
    }
    const value = post as Record<string, unknown>;
    const requested = requiredStringParam(value, "account");
    const text = requiredStringParam(value, "text");
    assertPostTextLength(text, `posts[${index}].text`);
    const wanted = requested.toLowerCase().replace(/^@/, "");
    const match = connections.find((entry) => entry.username?.toLowerCase() === wanted);
    if (!match) {
      throw new GoatActionInvalidParamsError(
        `No connected X account matches ${JSON.stringify(requested)}. Connected accounts: ${connections
          .map((entry) => JSON.stringify(connectionLabel(entry)))
          .join(", ")}.`,
      );
    }
    if (seen.has(match.integrationId)) {
      throw new GoatActionInvalidParamsError(
        `"posts" must not contain duplicate accounts (${connectionLabel(match)} was repeated).`,
      );
    }
    seen.add(match.integrationId);
    return { connection: match, text };
  });

  assertDistinctPostText(targets);
  return targets;
}

function connectionLabel(connection: XAccountConnection) {
  if (connection.username) return `@${connection.username}`;
  return connection.name?.trim() || "X account";
}

function safePostError(error: unknown) {
  const message = error instanceof Error ? error.message : "X rejected the post.";
  return message.slice(0, 300);
}

function assertPostTextLength(text: string, field: string) {
  if (text.length > MAX_TWEET_CHARS) {
    throw new GoatActionInvalidParamsError(`"${field}" exceeds ${MAX_TWEET_CHARS} characters.`);
  }
}

function assertDistinctPostText(targets: readonly XAccountPostTarget[]) {
  for (let left = 0; left < targets.length; left += 1) {
    for (let right = left + 1; right < targets.length; right += 1) {
      const first = targets[left]!;
      const second = targets[right]!;
      if (!substantiallySimilar(first.text, second.text)) continue;
      throw new GoatActionInvalidParamsError(
        `Posts for ${connectionLabel(first.connection)} and ${connectionLabel(second.connection)} are identical or substantially similar. Tailor each post to its account's audience before publishing.`,
      );
    }
  }
}

function substantiallySimilar(left: string, right: string) {
  const leftTokens = normalizedPostTokens(left);
  const rightTokens = normalizedPostTokens(right);
  if (leftTokens.join(" ") === rightTokens.join(" ")) return true;
  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  if (leftSet.size === 0 || rightSet.size === 0) return false;
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  const smallerTokenCount = Math.min(leftSet.size, rightSet.size);
  return intersection / smallerTokenCount >= 0.8;
}

function normalizedPostTokens(value: string) {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
