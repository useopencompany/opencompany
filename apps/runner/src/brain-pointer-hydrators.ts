import {
  type BrainHydratablePointerProvider,
  type NormalizedBrainPointerSourceItem,
  type NormalizedBrainSourceItem,
  type NormalizedGmailThreadMessage,
  type NormalizedLinearIssueSourceItem,
  normalizeChatCapture,
  normalizeGmailThreadWindow,
  normalizeLinearIssueWindow,
  parseBrainSourceRef,
} from "@opencompany/brain";
import { loadIntegrationCredential } from "@opencompany/db/integrations";
import {
  type BrainAgentIngestEnv,
  runChatCaptureAgentIngest,
  runGmailThreadAgentIngest,
  runLinearIssueAgentIngest,
} from "./brain-agent-ingest";
import { getDb } from "./db";
import { fetchGmailThreadSnapshot } from "./gmail-api";
import { type GoogleApiEnv, GoogleApiRequestError, googleApiCall } from "./google-api-auth";
import { fetchLinearIssueSnapshot } from "./linear-api";

export type BrainPointerHydrationEnv = BrainAgentIngestEnv & GoogleApiEnv;

type HydratedPointerItem = NormalizedGmailThreadSourceItem | NormalizedLinearIssueSourceItem;

type NormalizedGmailThreadSourceItem = ReturnType<typeof normalizeGmailThreadWindow>;

export type BrainPointerHydrator = {
  provider: BrainHydratablePointerProvider;
  hydrate(input: {
    ref: string;
    userWorkosId: string;
    integrationId: string;
    env: BrainPointerHydrationEnv;
    signal: AbortSignal;
  }): Promise<HydratedPointerItem | null>;
};

export const BRAIN_POINTER_HYDRATORS: readonly BrainPointerHydrator[] = [
  { provider: "gmail", hydrate: hydrateGmailPointer },
  { provider: "linear", hydrate: hydrateLinearPointer },
];

export async function hydrateBrainPointer(
  input: {
    item: NormalizedBrainPointerSourceItem;
    userWorkosId: string;
    integrationId: string;
    env: BrainPointerHydrationEnv;
    signal: AbortSignal;
  },
  hydrators: readonly BrainPointerHydrator[] = BRAIN_POINTER_HYDRATORS,
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

export async function runBrainPointerHydrate(
  input: {
    jobId: string;
    userWorkosId: string;
    brainRef: string | null;
    integrationId: string | null;
    item: NormalizedBrainPointerSourceItem;
    env: BrainPointerHydrationEnv;
    signal?: AbortSignal;
  },
  deps: {
    hydrate?: typeof hydrateBrainPointer;
    runGmail?: typeof runGmailThreadAgentIngest;
    runLinear?: typeof runLinearIssueAgentIngest;
    runFallback?: typeof runChatCaptureAgentIngest;
  } = {},
): Promise<Record<string, unknown>> {
  if (!input.integrationId) throw new Error("Pointer hydration requires an integration id.");
  const signal = input.signal ?? new AbortController().signal;
  const hydrated = await (deps.hydrate ?? hydrateBrainPointer)({
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
    const fallbackItem = normalizeChatCapture({
      text: pointer.fallbackText,
      title: input.item.title,
      chatSessionId: pointer.chatSessionId,
      userMessageId: pointer.userMessageId,
      draftBrainId: pointer.draftBrainId,
      draftFolder: pointer.draftFolder,
      capturedAt: input.item.capturedAt,
      sourceRef: input.item.sourceRef,
    });
    const result = await (deps.runFallback ?? runChatCaptureAgentIngest)({
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
  if (hydrated.sourceProvider === "gmail") {
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

async function hydrateGmailPointer(input: Parameters<BrainPointerHydrator["hydrate"]>[0]) {
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

async function hydrateLinearPointer(input: Parameters<BrainPointerHydrator["hydrate"]>[0]) {
  const identifier = parseLinearPointer(input.ref);
  if (!identifier) return null;
  const credential = await loadIntegrationCredential({
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

function parseGmailPointer(ref: string) {
  const parsed = parseBrainSourceRef(ref);
  if (parsed?.provider !== "gmail" || !parsed.id.startsWith("thread:")) return null;
  return parsed.id.slice("thread:".length).trim() || null;
}

function parseLinearPointer(ref: string) {
  const parsed = parseBrainSourceRef(ref);
  if (parsed?.provider !== "linear" || !parsed.id.startsWith("issue:")) return null;
  return parsed.id.slice("issue:".length).trim() || null;
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
