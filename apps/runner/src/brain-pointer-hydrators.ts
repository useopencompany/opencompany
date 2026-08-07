import {
  type GoatBrainHydratablePointerProvider,
  type NormalizedBrainSourceItem,
  type NormalizedGmailThreadMessage,
  type NormalizedGoatBrainPointerSourceItem,
  type NormalizedLinearIssueSourceItem,
  type NormalizedSlackConversationSourceItem,
  normalizeGmailThreadWindow,
  normalizeGoatChatCapture,
  normalizeLinearIssueWindow,
  normalizeSlackConversationWindow,
  parseGoatBrainSourceRef,
} from "@opencompany/brain";
import type { GoatSlackOAuthCredentialPayload } from "@opencompany/db/integrations";
import { loadGoatIntegrationCredential } from "@opencompany/db/integrations";
import {
  type GoatBrainAgentIngestEnv,
  runGmailThreadAgentIngest,
  runGoatChatCaptureAgentIngest,
  runLinearIssueAgentIngest,
  runSlackConversationAgentIngest,
} from "./brain-agent-ingest";
import { getDb } from "./db";
import { fetchGmailThreadSnapshot } from "./gmail-api";
import { type GoogleApiEnv, GoogleApiRequestError, googleApiCall } from "./google-api-auth";
import { fetchLinearIssueSnapshot } from "./linear-api";
import {
  fetchSlackConversationContext,
  getSlackConversationLabel,
  normalizeSlackApiMessages,
  resolveSlackUserNames,
  type SlackApiMessage,
  slackApiRequest,
} from "./slack-api";

export type GoatBrainPointerHydrationEnv = GoatBrainAgentIngestEnv & GoogleApiEnv;

type HydratedPointerItem =
  | NormalizedSlackConversationSourceItem
  | NormalizedGmailThreadSourceItem
  | NormalizedLinearIssueSourceItem;

type NormalizedGmailThreadSourceItem = ReturnType<typeof normalizeGmailThreadWindow>;

export type GoatBrainPointerHydrator = {
  provider: GoatBrainHydratablePointerProvider;
  hydrate(input: {
    ref: string;
    userWorkosId: string;
    integrationId: string;
    env: GoatBrainPointerHydrationEnv;
    signal: AbortSignal;
  }): Promise<HydratedPointerItem | null>;
};

export const GOAT_BRAIN_POINTER_HYDRATORS: readonly GoatBrainPointerHydrator[] = [
  { provider: "slack", hydrate: hydrateSlackPointer },
  { provider: "gmail", hydrate: hydrateGmailPointer },
  { provider: "linear", hydrate: hydrateLinearPointer },
];

export async function hydrateGoatBrainPointer(
  input: {
    item: NormalizedGoatBrainPointerSourceItem;
    userWorkosId: string;
    integrationId: string;
    env: GoatBrainPointerHydrationEnv;
    signal: AbortSignal;
  },
  hydrators: readonly GoatBrainPointerHydrator[] = GOAT_BRAIN_POINTER_HYDRATORS,
) {
  const hydrator = hydrators.find((entry) => entry.provider === input.item.sourceProvider);
  if (!hydrator)
    throw new Error(`No pointer hydrator is registered for ${input.item.sourceProvider}.`);
  return hydrator.hydrate({
    ref: input.item.sourceRef,
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    env: input.env,
    signal: input.signal,
  });
}

export async function runGoatBrainPointerHydrate(
  input: {
    jobId: string;
    userWorkosId: string;
    brainRef: string | null;
    integrationId: string | null;
    item: NormalizedGoatBrainPointerSourceItem;
    env: GoatBrainPointerHydrationEnv;
    signal?: AbortSignal;
  },
  deps: {
    hydrate?: typeof hydrateGoatBrainPointer;
    runSlack?: typeof runSlackConversationAgentIngest;
    runGmail?: typeof runGmailThreadAgentIngest;
    runLinear?: typeof runLinearIssueAgentIngest;
    runFallback?: typeof runGoatChatCaptureAgentIngest;
  } = {},
): Promise<Record<string, unknown>> {
  if (!input.integrationId) throw new Error("Pointer hydration requires an integration id.");
  const signal = input.signal ?? new AbortController().signal;
  const hydrated = await (deps.hydrate ?? hydrateGoatBrainPointer)({
    item: input.item,
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    env: input.env,
    signal,
  });

  if (!hydrated) {
    const pointer = input.item.content.pointer;
    if (!pointer.fallbackText) {
      return {
        skipped: true,
        reason: "pointer_source_unreachable",
        summary: "pointer_source_unreachable",
        sourceRef: input.item.sourceRef,
      };
    }
    const fallbackItem = normalizeGoatChatCapture({
      text: pointer.fallbackText,
      title: input.item.title,
      chatSessionId: pointer.chatSessionId,
      userMessageId: pointer.userMessageId,
      draftBrainId: pointer.draftBrainId,
      draftFolder: pointer.draftFolder,
      capturedAt: input.item.capturedAt,
      sourceRef: input.item.sourceRef,
    });
    const result = await (deps.runFallback ?? runGoatChatCaptureAgentIngest)({
      ...input,
      integrationId: null,
      item: fallbackItem,
      signal,
    });
    return {
      ...result,
      pointerFallback: true,
      sourceRef: input.item.sourceRef,
    };
  }

  let result: Record<string, unknown>;
  if (hydrated.sourceProvider === "slack") {
    result = await (deps.runSlack ?? runSlackConversationAgentIngest)({
      ...input,
      item: hydrated,
      signal,
    });
  } else if (hydrated.sourceProvider === "gmail") {
    result = await (deps.runGmail ?? runGmailThreadAgentIngest)({
      ...input,
      item: hydrated,
      signal,
    });
  } else {
    result = await (deps.runLinear ?? runLinearIssueAgentIngest)({
      ...input,
      item: hydrated,
      signal,
    });
  }
  return {
    ...result,
    pointerHydrated: true,
    sourceRef: input.item.sourceRef,
    hydratedContentHash: hydrated.contentHash,
  };
}

async function hydrateSlackPointer(input: Parameters<GoatBrainPointerHydrator["hydrate"]>[0]) {
  const parsed = parseSlackPointer(input.ref);
  if (!parsed) return null;
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: "slack",
    kind: "oauth_token",
    db: getDb(),
  });
  const payload = credential?.payload as GoatSlackOAuthCredentialPayload | undefined;
  if (!payload?.access_token) throw new Error("Reconnect Slack in Settings before hydrating it.");
  if (payload.team_id !== parsed.teamId) return null;

  let rawMessages: SlackApiMessage[];
  try {
    rawMessages = await fetchSlackAnchorMessages({
      token: payload.access_token,
      channelId: parsed.channelId,
      anchorTs: parsed.anchorTs,
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason;
    if (isUnreachableSlackError(error)) return null;
    throw error;
  }
  if (rawMessages.length === 0) return null;

  const userIds = rawMessages.flatMap((message) =>
    typeof message.user === "string" ? [message.user] : [],
  );
  const userNames = await resolveSlackUserNames({
    token: payload.access_token,
    teamId: parsed.teamId,
    userIds,
  });
  const messages = normalizeSlackApiMessages(rawMessages, {
    excludedTs: new Set(),
    userNames,
  });
  if (messages.length === 0) return null;

  const [channelName, context] = await Promise.all([
    getSlackConversationLabel({
      token: payload.access_token,
      teamId: parsed.teamId,
      channelId: parsed.channelId,
      channelType: slackChannelType(parsed.channelId),
    }),
    fetchSlackConversationContext({
      token: payload.access_token,
      teamId: parsed.teamId,
      channelId: parsed.channelId,
      windowStartTs: messages[0]!.ts,
      currentMessages: messages,
    }),
  ]);
  const normalized = normalizeSlackConversationWindow({
    windowId: `pointer:${input.ref}`,
    teamId: parsed.teamId,
    ...(payload.team_domain ? { teamDomain: payload.team_domain } : {}),
    channelId: parsed.channelId,
    channelName: channelName ?? parsed.channelId,
    channelType: slackChannelType(parsed.channelId),
    messages,
    ...(context ? { context } : {}),
    flushedAt: new Date().toISOString(),
  });
  return { ...normalized, sourceRef: input.ref };
}

async function fetchSlackAnchorMessages(input: {
  token: string;
  channelId: string;
  anchorTs: string;
  signal: AbortSignal;
}) {
  try {
    const replies = await slackApiRequest<{ messages?: SlackApiMessage[] }>({
      method: "conversations.replies",
      token: input.token,
      signal: input.signal,
      form: { channel: input.channelId, ts: input.anchorTs, limit: "100" },
    });
    const messages = replies.messages ?? [];
    if (messages.some((message) => message.ts === input.anchorTs)) return messages;
  } catch (error) {
    if (!String(error).includes("thread_not_found")) throw error;
  }

  const history = await slackApiRequest<{ messages?: SlackApiMessage[] }>({
    method: "conversations.history",
    token: input.token,
    signal: input.signal,
    form: {
      channel: input.channelId,
      latest: input.anchorTs,
      inclusive: "true",
      limit: "1",
    },
  });
  return (history.messages ?? []).filter((message) => message.ts === input.anchorTs);
}

async function hydrateGmailPointer(input: Parameters<GoatBrainPointerHydrator["hydrate"]>[0]) {
  const threadId = parseGmailPointer(input.ref);
  if (!threadId) return null;
  const account = {
    integrationId: input.integrationId,
    provider: "gmail" as const,
    accountEmail: null,
  };
  const call = (method: string, url: string) =>
    googleApiCall({
      env: input.env,
      userWorkosId: input.userWorkosId,
      account,
      method,
      url,
      signal: input.signal,
    });
  let snapshot;
  try {
    // Keep the shared per-message body bound. Pointer hydration fetches the
    // provider source instead of relying on chat's much smaller preview, but it
    // must not turn an arbitrarily large mailbox thread into an unbounded DB
    // payload and ingestion job.
    snapshot = await fetchGmailThreadSnapshot(call, threadId);
  } catch (error) {
    if (error instanceof GoogleApiRequestError && (error.status === 403 || error.status === 404)) {
      return null;
    }
    throw error;
  }
  const now = new Date();
  const messages: NormalizedGmailThreadMessage[] = snapshot.messages
    .filter((message) => !message.labelIds.includes("DRAFT"))
    .map((message) => ({
      messageId: message.id,
      direction: message.labelIds.includes("SENT") ? "sent" : "received",
      from: message.from ?? "(unknown sender)",
      ...(message.to ? { to: message.to } : {}),
      ...(message.cc ? { cc: message.cc } : {}),
      sentAt: (message.internalDate ?? now).toISOString(),
      bodyText: message.bodyText,
      ...(message.snippet ? { snippet: message.snippet } : {}),
    }));
  if (messages.length === 0) return null;
  const subject = snapshot.messages.find((message) => message.subject)?.subject ?? undefined;
  return normalizeGmailThreadWindow({
    windowId: `pointer:${input.ref}`,
    threadId: snapshot.threadId,
    ...(subject ? { subject } : {}),
    messages,
    flushedAt: now.toISOString(),
  });
}

async function hydrateLinearPointer(input: Parameters<GoatBrainPointerHydrator["hydrate"]>[0]) {
  const identifier = parseLinearPointer(input.ref);
  if (!identifier) return null;
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: "linear",
    kind: "oauth_token",
    db: getDb(),
  });
  const accessToken = readLinearAccessToken(credential?.payload);
  if (!accessToken) throw new Error("Reconnect Linear in Settings before hydrating it.");
  const snapshot = await fetchLinearIssueSnapshot({
    token: accessToken,
    issueId: identifier,
    suppressErrors: false,
  });
  if (!snapshot) return null;
  const capturedAt = new Date().toISOString();
  const occurredAt = snapshot.updatedAt ?? snapshot.createdAt ?? capturedAt;
  return normalizeLinearIssueWindow({
    windowId: `pointer:${input.ref}`,
    organizationId: snapshot.organizationId,
    issueId: snapshot.issueId,
    title: snapshot.title,
    activity: [
      {
        occurredAt,
        entityType: "issue",
        action: "update",
        changedFields: ["snapshot"],
      },
    ],
    comments: snapshot.comments,
    flushedAt: capturedAt,
    ...(snapshot.organizationUrlKey ? { organizationUrlKey: snapshot.organizationUrlKey } : {}),
    ...(snapshot.identifier ? { identifier: snapshot.identifier } : {}),
    ...(snapshot.url ? { url: snapshot.url } : {}),
    ...(snapshot.description ? { description: snapshot.description } : {}),
    ...(snapshot.state ? { state: snapshot.state } : {}),
    ...(snapshot.stateType ? { stateType: snapshot.stateType } : {}),
    ...(snapshot.priority ? { priority: snapshot.priority } : {}),
    ...(snapshot.assigneeName ? { assigneeName: snapshot.assigneeName } : {}),
    ...(snapshot.creatorName ? { creatorName: snapshot.creatorName } : {}),
    ...(snapshot.projectName ? { projectName: snapshot.projectName } : {}),
    ...(snapshot.labels ? { labels: snapshot.labels } : {}),
    ...(snapshot.dueDate ? { dueDate: snapshot.dueDate } : {}),
    ...(typeof snapshot.estimate === "number" ? { estimate: snapshot.estimate } : {}),
    ...(snapshot.createdAt ? { createdAt: snapshot.createdAt } : {}),
    ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
    ...(snapshot.completedAt ? { completedAt: snapshot.completedAt } : {}),
    ...(snapshot.canceledAt ? { canceledAt: snapshot.canceledAt } : {}),
    ...(snapshot.teamId ? { teamId: snapshot.teamId } : {}),
    ...(snapshot.teamKey ? { teamKey: snapshot.teamKey } : {}),
    ...(snapshot.teamName ? { teamName: snapshot.teamName } : {}),
  });
}

function parseSlackPointer(ref: string) {
  const parsed = parseGoatBrainSourceRef(ref);
  const [kind, teamId, channelId, anchorTs, ...extra] = parsed?.id.split(":") ?? [];
  if (
    parsed?.provider !== "slack" ||
    kind !== "conversation" ||
    !teamId ||
    !channelId ||
    !anchorTs ||
    extra.length > 0
  ) {
    return null;
  }
  return { teamId, channelId, anchorTs };
}

function parseGmailPointer(ref: string) {
  const parsed = parseGoatBrainSourceRef(ref);
  if (parsed?.provider !== "gmail" || !parsed.id.startsWith("thread:")) return null;
  return parsed.id.slice("thread:".length).trim() || null;
}

function parseLinearPointer(ref: string) {
  const parsed = parseGoatBrainSourceRef(ref);
  if (parsed?.provider !== "linear" || !parsed.id.startsWith("issue:")) return null;
  return parsed.id.slice("issue:".length).trim() || null;
}

function slackChannelType(channelId: string): "channel" | "group" | "im" | "mpim" {
  if (channelId.startsWith("D")) return "im";
  if (channelId.startsWith("G")) return "group";
  return "channel";
}

function isUnreachableSlackError(error: unknown) {
  return /channel_not_found|message_not_found|not_in_channel|missing_scope|account_inactive/.test(
    String(error),
  );
}

function readLinearAccessToken(payload: Record<string, unknown> | undefined) {
  if (!payload) return null;
  if (typeof payload.access_token === "string" && payload.access_token) return payload.access_token;
  const tokens =
    payload.tokens && typeof payload.tokens === "object" && !Array.isArray(payload.tokens)
      ? (payload.tokens as Record<string, unknown>)
      : null;
  return typeof tokens?.access_token === "string" && tokens.access_token
    ? tokens.access_token
    : null;
}
