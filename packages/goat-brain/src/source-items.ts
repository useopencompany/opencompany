import { createHash } from "node:crypto";
import { isValidGoatBrainSourceRef } from "./schema";

export type BrainSourceProvider =
  | "jamie"
  | "goat-chat"
  | "goat-import"
  | "upload"
  | "slack"
  | "linear"
  | "github"
  | "gmail"
  | "google_drive";
export type BrainSourceType =
  | "meeting"
  | "run"
  | "capture"
  | "asset"
  | "conversation"
  | "issue"
  | "activity"
  | "thread"
  | "document";

export type NormalizedBrainSourceItem<TContent = unknown> = {
  sourceProvider: BrainSourceProvider;
  sourceType: BrainSourceType;
  externalId: string;
  sourceRef: string;
  title: string;
  occurredAt: string;
  capturedAt: string;
  contentHash: string;
  contentHashInput: unknown;
  content: TContent;
};

export type GoatImportResearchResult = {
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  highlights: string[];
  summary?: string;
};

export type NormalizedGoatImportContent =
  | {
      phase: "research";
      importRunId: string;
      companyUrl: string;
      companyDomain: string;
      companyName?: string;
      focus?: string;
      searches: Array<{
        query: string;
        category: "company" | "people" | "general";
      }>;
      results: GoatImportResearchResult[];
    }
  | {
      phase: "finalize";
      importRunId: string;
      companyUrl: string;
      companyDomain: string;
      companyName?: string;
      focus?: string;
      childSummary: Array<{
        provider: string;
        status: "succeeded" | "failed" | "skipped";
        summary?: string;
      }>;
    };

export type NormalizedGoatImportSourceItem =
  NormalizedBrainSourceItem<NormalizedGoatImportContent> & {
    sourceProvider: "goat-import";
    sourceType: "run";
  };

export function normalizeGoatImportRun(input: {
  phase: "research" | "finalize";
  importRunId: string;
  companyUrl: string;
  companyDomain: string;
  companyName?: string;
  focus?: string;
  searches?: Array<{
    query: string;
    category: "company" | "people" | "general";
  }>;
  results?: GoatImportResearchResult[];
  childSummary?: Array<{
    provider: string;
    status: "succeeded" | "failed" | "skipped";
    summary?: string;
  }>;
  capturedAt?: string;
}): NormalizedGoatImportSourceItem {
  const importRunId = readNonEmpty(input.importRunId, "import importRunId");
  const companyUrl = readNonEmpty(input.companyUrl, "import companyUrl");
  const companyDomain = readNonEmpty(input.companyDomain, "import companyDomain");
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const companyName = optionalString(input.companyName);
  const focus = optionalString(input.focus);
  const content: NormalizedGoatImportContent =
    input.phase === "research"
      ? {
          phase: "research",
          importRunId,
          companyUrl,
          companyDomain,
          ...(companyName ? { companyName } : {}),
          ...(focus ? { focus } : {}),
          searches: input.searches ?? [],
          results: input.results ?? [],
        }
      : {
          phase: "finalize",
          importRunId,
          companyUrl,
          companyDomain,
          ...(companyName ? { companyName } : {}),
          ...(focus ? { focus } : {}),
          childSummary: input.childSummary ?? [],
        };
  const contentHashInput = content;
  return {
    sourceProvider: "goat-import",
    sourceType: "run",
    externalId: `${importRunId}:${input.phase}`,
    sourceRef: `goat-import:${importRunId}:${input.phase}`,
    title:
      input.phase === "research"
        ? `Company bootstrap for ${companyName ?? companyDomain}`
        : `Finalize company bootstrap for ${companyName ?? companyDomain}`,
    occurredAt: capturedAt,
    capturedAt,
    contentHashInput,
    contentHash: sha256(stableJson(contentHashInput)),
    content,
  };
}

export function isNormalizedGoatImportSourceItem(
  value: unknown,
): value is NormalizedGoatImportSourceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NormalizedGoatImportSourceItem>;
  if (
    item.sourceProvider !== "goat-import" ||
    item.sourceType !== "run" ||
    typeof item.externalId !== "string" ||
    typeof item.sourceRef !== "string" ||
    typeof item.contentHash !== "string" ||
    !item.content ||
    typeof item.content !== "object"
  ) {
    return false;
  }
  const content = item.content as Partial<NormalizedGoatImportContent>;
  return (
    (content.phase === "research" || content.phase === "finalize") &&
    typeof content.importRunId === "string" &&
    typeof content.companyUrl === "string" &&
    typeof content.companyDomain === "string"
  );
}

export type NormalizedJamieMeetingParticipant = {
  id?: string;
  name?: string;
  email?: string;
};

export type NormalizedJamieMeetingTranscriptSegment = {
  text: string;
  speaker?: string;
  startedAt?: string;
  endedAt?: string;
};

export type NormalizedJamieMeetingActionItem = {
  text: string;
  assignee?: string;
};

export type NormalizedJamieMeetingContent = {
  user: {
    id: string;
    email?: string;
  };
  event: {
    id?: string;
    externalId?: string;
  };
  meeting: {
    title: string;
    startTime: string;
    endTime?: string;
    summaryMarkdown: string;
    participants: NormalizedJamieMeetingParticipant[];
    actionItems: NormalizedJamieMeetingActionItem[];
    transcript: NormalizedJamieMeetingTranscriptSegment[];
  };
};

export type NormalizedJamieMeetingSourceItem =
  NormalizedBrainSourceItem<NormalizedJamieMeetingContent> & {
    sourceProvider: "jamie";
    sourceType: "meeting";
  };

export type NormalizedGoatChatCaptureContent = {
  capture: {
    text: string;
    intent?: string;
    chatSessionId: string;
    userMessageId: string;
    draftBrainId: string;
    draftFolder: string;
  };
};

export type NormalizedGoatChatCaptureSourceItem =
  NormalizedBrainSourceItem<NormalizedGoatChatCaptureContent> & {
    sourceProvider: "goat-chat";
    sourceType: "capture";
  };

export function normalizeGoatChatCapture(input: {
  text: string;
  title: string;
  intent?: string;
  chatSessionId: string;
  userMessageId: string;
  draftBrainId: string;
  draftFolder: string;
  capturedAt: string;
  sourceRef?: string;
}): NormalizedGoatChatCaptureSourceItem {
  const text = input.text.trim();
  if (!text) throw invalid("capture text must not be empty", "invalid_capture");
  const title = input.title.trim();
  if (!title) throw invalid("capture title must not be empty", "invalid_capture");
  const chatSessionId = input.chatSessionId.trim();
  if (!chatSessionId) throw invalid("capture chatSessionId must not be empty", "invalid_capture");
  const userMessageId = input.userMessageId.trim();
  if (!userMessageId) throw invalid("capture userMessageId must not be empty", "invalid_capture");
  const draftBrainId = input.draftBrainId.trim();
  if (!draftBrainId) throw invalid("capture draftBrainId must not be empty", "invalid_capture");
  const capturedAt = optionalIsoString(input.capturedAt);
  if (!capturedAt) throw invalid("capture capturedAt must be a timestamp", "invalid_capture");
  const intent = optionalString(input.intent);
  const sourceRef = input.sourceRef?.trim() || `goat-chat:${userMessageId}`;
  if (!isValidGoatBrainSourceRef(sourceRef)) {
    throw invalid("capture sourceRef must be valid", "invalid_capture");
  }

  const capture = {
    text,
    ...(intent ? { intent } : {}),
    chatSessionId,
    userMessageId,
    draftBrainId,
    draftFolder: input.draftFolder,
  };
  const contentHashInput = {
    sourceProvider: "goat-chat",
    sourceType: "capture",
    externalId: draftBrainId,
    title,
    capture,
  };

  return {
    sourceProvider: "goat-chat",
    sourceType: "capture",
    // The inbox draft id is minted per capture, so it doubles as the stable
    // external id for dedupe.
    externalId: draftBrainId,
    sourceRef,
    title,
    occurredAt: capturedAt,
    capturedAt,
    contentHash: sha256(stableJson(contentHashInput)),
    contentHashInput,
    content: { capture },
  };
}

export function isNormalizedGoatChatCaptureSourceItem(
  value: unknown,
): value is NormalizedGoatChatCaptureSourceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NormalizedGoatChatCaptureSourceItem>;
  if (
    item.sourceProvider !== "goat-chat" ||
    item.sourceType !== "capture" ||
    typeof item.externalId !== "string" ||
    typeof item.sourceRef !== "string" ||
    typeof item.title !== "string" ||
    typeof item.occurredAt !== "string" ||
    typeof item.capturedAt !== "string" ||
    typeof item.contentHash !== "string" ||
    !item.content ||
    typeof item.content !== "object"
  ) {
    return false;
  }
  const capture = (item.content as Partial<NormalizedGoatChatCaptureContent>).capture;
  return (
    !!capture &&
    typeof capture === "object" &&
    typeof capture.text === "string" &&
    typeof capture.chatSessionId === "string" &&
    typeof capture.userMessageId === "string" &&
    typeof capture.draftBrainId === "string" &&
    typeof capture.draftFolder === "string"
  );
}

export type NormalizedUploadAssetContent = {
  asset: {
    // The brain_documents row created at upload time; the ingestion agent
    // enriches this existing page rather than creating a new one.
    documentId: string;
    brainId: string;
    folderPath: string;
    format: string;
    mimeType: string;
    originalFileName: string;
    sizeBytes: number;
  };
};

export type NormalizedUploadAssetSourceItem =
  NormalizedBrainSourceItem<NormalizedUploadAssetContent> & {
    sourceProvider: "upload";
    sourceType: "asset";
  };

export function normalizeUploadAsset(input: {
  documentId: string;
  brainId: string;
  folderPath: string;
  format: string;
  mimeType: string;
  originalFileName: string;
  sizeBytes: number;
  // sha256 of the uploaded bytes; keeps re-uploads of the same file deduped
  // and re-uploads of changed bytes enqueueing a fresh ingest job.
  contentSha256: string;
  uploadedAt: string;
}): NormalizedUploadAssetSourceItem {
  const documentId = input.documentId.trim();
  if (!documentId) throw invalid("asset documentId must not be empty", "invalid_asset");
  const originalFileName = input.originalFileName.trim();
  if (!originalFileName) throw invalid("asset originalFileName must not be empty", "invalid_asset");
  const contentSha256 = input.contentSha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(contentSha256)) {
    throw invalid("asset contentSha256 must be a sha256 hex digest", "invalid_asset");
  }
  const uploadedAt = optionalIsoString(input.uploadedAt);
  if (!uploadedAt) throw invalid("asset uploadedAt must be a timestamp", "invalid_asset");

  const asset = {
    documentId,
    brainId: input.brainId,
    folderPath: input.folderPath,
    format: input.format,
    mimeType: input.mimeType,
    originalFileName,
    sizeBytes: input.sizeBytes,
  };
  const contentHashInput = {
    sourceProvider: "upload",
    sourceType: "asset",
    externalId: documentId,
    contentSha256,
    asset,
  };

  return {
    sourceProvider: "upload",
    sourceType: "asset",
    externalId: documentId,
    sourceRef: `upload:${documentId}`,
    title: originalFileName,
    occurredAt: uploadedAt,
    capturedAt: uploadedAt,
    contentHash: sha256(stableJson(contentHashInput)),
    contentHashInput,
    content: { asset },
  };
}

export function isNormalizedUploadAssetSourceItem(
  value: unknown,
): value is NormalizedUploadAssetSourceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NormalizedUploadAssetSourceItem>;
  if (
    item.sourceProvider !== "upload" ||
    item.sourceType !== "asset" ||
    typeof item.externalId !== "string" ||
    typeof item.sourceRef !== "string" ||
    typeof item.title !== "string" ||
    typeof item.occurredAt !== "string" ||
    typeof item.capturedAt !== "string" ||
    typeof item.contentHash !== "string" ||
    !item.content ||
    typeof item.content !== "object"
  ) {
    return false;
  }
  const asset = (item.content as Partial<NormalizedUploadAssetContent>).asset;
  return (
    !!asset &&
    typeof asset === "object" &&
    typeof asset.documentId === "string" &&
    typeof asset.brainId === "string" &&
    typeof asset.folderPath === "string" &&
    typeof asset.format === "string" &&
    typeof asset.mimeType === "string" &&
    typeof asset.originalFileName === "string" &&
    typeof asset.sizeBytes === "number"
  );
}

export type NormalizedSlackConversationMessage = {
  ts: string;
  threadTs?: string;
  userId: string;
  userName?: string;
  text: string;
  subtype?: string;
  files?: Array<{ name: string; mimetype?: string }>;
};

export type NormalizedSlackConversationContent = {
  conversation: {
    teamId: string;
    teamDomain?: string;
    channelId: string;
    channelName: string;
    channelType: "channel" | "group" | "im" | "mpim";
    windowStartTs: string;
    windowEndTs: string;
    messages: NormalizedSlackConversationMessage[];
    context?: {
      previousMessages?: NormalizedSlackConversationMessage[];
      threads?: Array<{
        threadTs: string;
        messages: NormalizedSlackConversationMessage[];
      }>;
    };
  };
};

export type NormalizedSlackConversationSourceItem =
  NormalizedBrainSourceItem<NormalizedSlackConversationContent> & {
    sourceProvider: "slack";
    sourceType: "conversation";
  };

export function normalizeSlackConversationWindow(input: {
  // Minted per flush, so it doubles as the stable external id for dedupe.
  windowId: string;
  teamId: string;
  teamDomain?: string;
  channelId: string;
  channelName: string;
  channelType: "channel" | "group" | "im" | "mpim";
  messages: NormalizedSlackConversationMessage[];
  context?: NormalizedSlackConversationContent["conversation"]["context"];
  flushedAt: string;
}): NormalizedSlackConversationSourceItem {
  const windowId = input.windowId.trim();
  if (!windowId) throw invalid("conversation windowId must not be empty", "invalid_conversation");
  const teamId = input.teamId.trim();
  if (!teamId) throw invalid("conversation teamId must not be empty", "invalid_conversation");
  const channelId = input.channelId.trim();
  if (!channelId) {
    throw invalid("conversation channelId must not be empty", "invalid_conversation");
  }
  if (input.messages.length === 0) {
    throw invalid("conversation messages must not be empty", "invalid_conversation");
  }
  const flushedAt = optionalIsoString(input.flushedAt);
  if (!flushedAt)
    throw invalid("conversation flushedAt must be a timestamp", "invalid_conversation");

  const messages = [...input.messages].sort((a, b) => Number(a.ts) - Number(b.ts));
  const windowStartTs = messages[0]!.ts;
  const windowEndTs = messages[messages.length - 1]!.ts;
  const teamDomain = optionalString(input.teamDomain);
  const channelName = optionalString(input.channelName) ?? channelId;
  const context = normalizeSlackConversationContext(input.context);

  const conversation = {
    teamId,
    ...(teamDomain ? { teamDomain } : {}),
    channelId,
    channelName,
    channelType: input.channelType,
    windowStartTs,
    windowEndTs,
    messages,
    ...(context ? { context } : {}),
  };
  const contentHashInput = {
    sourceProvider: "slack",
    sourceType: "conversation",
    teamId,
    channelId,
    messages: messages.map((message) => ({
      ts: message.ts,
      userId: message.userId,
      text: message.text,
    })),
  };

  const title =
    input.channelType === "im"
      ? `DM with ${channelName} — ${slackTsToIso(windowStartTs).slice(0, 10)}`
      : `#${channelName} — ${slackTsToIso(windowStartTs).slice(0, 10)}`;

  return {
    sourceProvider: "slack",
    sourceType: "conversation",
    externalId: windowId,
    sourceRef: `slack:conversation:${teamId}:${channelId}:${windowEndTs}`,
    title,
    occurredAt: slackTsToIso(windowStartTs),
    capturedAt: flushedAt,
    contentHash: sha256(stableJson(contentHashInput)),
    contentHashInput,
    content: { conversation },
  };
}

export function isNormalizedSlackConversationSourceItem(
  value: unknown,
): value is NormalizedSlackConversationSourceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NormalizedSlackConversationSourceItem>;
  if (
    item.sourceProvider !== "slack" ||
    item.sourceType !== "conversation" ||
    typeof item.externalId !== "string" ||
    typeof item.sourceRef !== "string" ||
    typeof item.title !== "string" ||
    typeof item.occurredAt !== "string" ||
    typeof item.capturedAt !== "string" ||
    typeof item.contentHash !== "string" ||
    !item.content ||
    typeof item.content !== "object"
  ) {
    return false;
  }
  const conversation = (item.content as Partial<NormalizedSlackConversationContent>).conversation;
  return (
    !!conversation &&
    typeof conversation === "object" &&
    typeof conversation.teamId === "string" &&
    typeof conversation.channelId === "string" &&
    typeof conversation.channelName === "string" &&
    typeof conversation.channelType === "string" &&
    Array.isArray(conversation.messages) &&
    conversation.messages.length > 0
  );
}

function normalizeSlackConversationContext(
  context: NormalizedSlackConversationContent["conversation"]["context"] | undefined,
): NormalizedSlackConversationContent["conversation"]["context"] | undefined {
  const previousMessages = sortSlackMessages(context?.previousMessages ?? []);
  const threads = (context?.threads ?? [])
    .flatMap((thread) => {
      const threadTs = thread.threadTs.trim();
      if (!threadTs) return [];
      const messages = sortSlackMessages(thread.messages);
      if (messages.length === 0) return [];
      return [{ threadTs, messages }];
    })
    .sort((a, b) => Number(a.threadTs) - Number(b.threadTs));

  if (previousMessages.length === 0 && threads.length === 0) return undefined;
  return {
    ...(previousMessages.length > 0 ? { previousMessages } : {}),
    ...(threads.length > 0 ? { threads } : {}),
  };
}

function sortSlackMessages(messages: readonly NormalizedSlackConversationMessage[]) {
  return [...messages].sort((a, b) => Number(a.ts) - Number(b.ts));
}

// Slack ts values are epoch seconds with a fractional suffix ("1720000000.000200").
export function slackTsToIso(ts: string): string {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) {
    throw invalid(`slack ts must be numeric, got ${ts}`, "invalid_conversation");
  }
  return new Date(seconds * 1000).toISOString();
}

export type NormalizedLinearIssueActivity = {
  occurredAt: string;
  entityType: "issue" | "comment";
  action: "create" | "update" | "remove";
  actorName?: string;
  /** Human summary of what changed, e.g. "state, assignee". */
  changedFields?: string[];
  commentId?: string;
  commentBody?: string;
};

export type NormalizedLinearIssueComment = {
  id: string;
  body: string;
  authorName?: string;
  createdAt?: string;
  url?: string;
};

export type NormalizedLinearIssueContent = {
  issue: {
    organizationId: string;
    organizationUrlKey?: string;
    teamId?: string;
    teamKey?: string;
    teamName?: string;
    issueId: string;
    /** Human key like "ENG-123"; absent when the live snapshot was unavailable. */
    identifier?: string;
    url?: string;
    title: string;
    description?: string;
    state?: string;
    stateType?: string;
    priority?: string;
    assigneeName?: string;
    creatorName?: string;
    projectName?: string;
    labels?: string[];
    dueDate?: string;
    estimate?: number;
    createdAt?: string;
    updatedAt?: string;
    completedAt?: string;
    canceledAt?: string;
    /** True when the live issue snapshot could not be fetched (deleted issue,
     * revoked token); fields above then reflect the last buffered event. */
    snapshotStale?: boolean;
    windowStart: string;
    windowEnd: string;
    activity: NormalizedLinearIssueActivity[];
    comments: NormalizedLinearIssueComment[];
  };
};

export type NormalizedLinearIssueSourceItem =
  NormalizedBrainSourceItem<NormalizedLinearIssueContent> & {
    sourceProvider: "linear";
    sourceType: "issue";
  };

export function normalizeLinearIssueWindow(input: {
  // Minted per flush, so it doubles as the stable external id for dedupe.
  windowId: string;
  organizationId: string;
  issueId: string;
  title: string;
  activity: NormalizedLinearIssueActivity[];
  comments?: NormalizedLinearIssueComment[];
  flushedAt: string;
  organizationUrlKey?: string;
  teamId?: string;
  teamKey?: string;
  teamName?: string;
  identifier?: string;
  url?: string;
  description?: string;
  state?: string;
  stateType?: string;
  priority?: string;
  assigneeName?: string;
  creatorName?: string;
  projectName?: string;
  labels?: string[];
  dueDate?: string;
  estimate?: number;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  canceledAt?: string;
  snapshotStale?: boolean;
}): NormalizedLinearIssueSourceItem {
  const windowId = input.windowId.trim();
  if (!windowId) throw invalid("issue windowId must not be empty", "invalid_issue");
  const organizationId = input.organizationId.trim();
  if (!organizationId) throw invalid("issue organizationId must not be empty", "invalid_issue");
  const issueId = input.issueId.trim();
  if (!issueId) throw invalid("issue issueId must not be empty", "invalid_issue");
  if (input.activity.length === 0) {
    throw invalid("issue activity must not be empty", "invalid_issue");
  }
  const flushedAt = optionalIsoString(input.flushedAt);
  if (!flushedAt) throw invalid("issue flushedAt must be a timestamp", "invalid_issue");
  const title = optionalString(input.title) ?? optionalString(input.identifier) ?? issueId;

  const activity = [...input.activity].sort(
    (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
  );
  const windowStart = activity[0]!.occurredAt;
  const windowEnd = activity[activity.length - 1]!.occurredAt;
  const comments = input.comments ?? [];
  const identifier = optionalString(input.identifier);
  const organizationUrlKey = optionalString(input.organizationUrlKey);
  const teamId = optionalString(input.teamId);
  const teamKey = optionalString(input.teamKey);
  const teamName = optionalString(input.teamName);
  const url = optionalString(input.url);
  const description = optionalString(input.description);
  const state = optionalString(input.state);
  const stateType = optionalString(input.stateType);
  const priority = optionalString(input.priority);
  const assigneeName = optionalString(input.assigneeName);
  const creatorName = optionalString(input.creatorName);
  const projectName = optionalString(input.projectName);
  const dueDate = optionalString(input.dueDate);
  const createdAt = optionalIsoString(input.createdAt);
  const updatedAt = optionalIsoString(input.updatedAt);
  const completedAt = optionalIsoString(input.completedAt);
  const canceledAt = optionalIsoString(input.canceledAt);

  const issue = {
    organizationId,
    ...(organizationUrlKey ? { organizationUrlKey } : {}),
    ...(teamId ? { teamId } : {}),
    ...(teamKey ? { teamKey } : {}),
    ...(teamName ? { teamName } : {}),
    issueId,
    ...(identifier ? { identifier } : {}),
    ...(url ? { url } : {}),
    title,
    ...(description ? { description } : {}),
    ...(state ? { state } : {}),
    ...(stateType ? { stateType } : {}),
    ...(priority ? { priority } : {}),
    ...(assigneeName ? { assigneeName } : {}),
    ...(creatorName ? { creatorName } : {}),
    ...(projectName ? { projectName } : {}),
    ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
    ...(dueDate ? { dueDate } : {}),
    ...(typeof input.estimate === "number" ? { estimate: input.estimate } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(canceledAt ? { canceledAt } : {}),
    ...(input.snapshotStale ? { snapshotStale: true } : {}),
    windowStart,
    windowEnd,
    activity,
    comments,
  };
  const contentHashInput = {
    sourceProvider: "linear",
    sourceType: "issue",
    organizationId,
    issueId,
    activity: activity.map((entry) => ({
      occurredAt: entry.occurredAt,
      entityType: entry.entityType,
      action: entry.action,
      ...(entry.commentId ? { commentId: entry.commentId } : {}),
    })),
    title,
    ...(state ? { state } : {}),
  };

  return {
    sourceProvider: "linear",
    sourceType: "issue",
    externalId: windowId,
    sourceRef: `linear:issue:${identifier ?? issueId}`,
    title: identifier ? `${identifier} ${title}` : title,
    occurredAt: windowStart,
    capturedAt: flushedAt,
    contentHash: sha256(stableJson(contentHashInput)),
    contentHashInput,
    content: { issue },
  };
}

export function isNormalizedLinearIssueSourceItem(
  value: unknown,
): value is NormalizedLinearIssueSourceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NormalizedLinearIssueSourceItem>;
  if (
    item.sourceProvider !== "linear" ||
    item.sourceType !== "issue" ||
    typeof item.externalId !== "string" ||
    typeof item.sourceRef !== "string" ||
    typeof item.title !== "string" ||
    typeof item.occurredAt !== "string" ||
    typeof item.capturedAt !== "string" ||
    typeof item.contentHash !== "string" ||
    !item.content ||
    typeof item.content !== "object"
  ) {
    return false;
  }
  const issue = (item.content as Partial<NormalizedLinearIssueContent>).issue;
  return (
    !!issue &&
    typeof issue === "object" &&
    typeof issue.organizationId === "string" &&
    typeof issue.issueId === "string" &&
    typeof issue.title === "string" &&
    Array.isArray(issue.activity) &&
    issue.activity.length > 0 &&
    Array.isArray(issue.comments)
  );
}

export type NormalizedGitHubActivityKind = "pull_request" | "issue";

// The subscribable GitHub event types. This is the contract between the
// per-brain source config (which events a brain subscribes to), the webhook
// router, and the normalizer — extend all three together.
export const GITHUB_ACTIVITY_EVENT_TYPES = [
  "pull_request_opened",
  "pull_request_merged",
  "pull_request_commented",
  "issue_opened",
  "issue_commented",
] as const;
export type GitHubActivityEventType = (typeof GITHUB_ACTIVITY_EVENT_TYPES)[number];

export type NormalizedGitHubActivityContent = {
  activity: {
    kind: NormalizedGitHubActivityKind;
    repository: { id: string; fullName: string; private: boolean };
    title: string;
    url: string;
    state: "opened" | "merged" | "commented";
    body: string;
    truncatedBody: boolean;
    author?: string;
    number?: number;
    mergedBy?: string;
    baseRef?: string;
    headRef?: string;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
    commits?: number;
    labels?: string[];
  };
};

export type NormalizedGitHubActivitySourceItem =
  NormalizedBrainSourceItem<NormalizedGitHubActivityContent> & {
    sourceProvider: "github";
    sourceType: "activity";
  };

export function githubActivityEventType(
  activity: Pick<NormalizedGitHubActivityContent["activity"], "kind" | "state">,
): GitHubActivityEventType {
  if (activity.state === "commented") {
    return activity.kind === "issue" ? "issue_commented" : "pull_request_commented";
  }
  if (activity.kind === "issue") return "issue_opened";
  return activity.state === "merged" ? "pull_request_merged" : "pull_request_opened";
}

// Bodies stay bounded at normalize time: the tracker is the canonical live
// home (pointer/copy contract), so the stored copy only needs to be large
// enough for the ingestion agent to judge and synthesize from.
const GITHUB_ACTIVITY_BODY_LIMIT_BYTES = 20_000;

// Maps a GitHub App webhook delivery to a normalized source item. Returns null
// for event/action combinations that are not ingested — only the subscribable
// event types flow into the brain: a pull request opened, a pull request
// merged, an issue opened, and a new comment on either. Throws on malformed
// payloads for supported combinations.
export function normalizeGitHubActivityWebhook(
  eventName: string,
  payload: unknown,
  options: { capturedAt: string },
): NormalizedGitHubActivitySourceItem | null {
  if (eventName === "issue_comment") {
    return normalizeGitHubIssueCommentWebhook(payload, options);
  }
  if (eventName !== "pull_request" && eventName !== "issues") {
    return null;
  }
  const root = readObject(payload, "payload");
  const action = typeof root.action === "string" ? root.action : "";

  if (eventName === "pull_request") {
    const merged = action === "closed";
    if (action !== "opened" && !merged) return null;
    const pullRequest = readObject(root.pull_request, "pull_request");
    if (merged && pullRequest.merged !== true) return null;
    return buildGitHubActivityItem({
      kind: "pull_request",
      repository: readGitHubRepository(root.repository),
      refSegment: `pull:${readGitHubNumber(pullRequest.number, "pull_request.number")}`,
      title: readString(pullRequest.title, "pull_request.title"),
      url: readString(pullRequest.html_url, "pull_request.html_url"),
      state: merged ? "merged" : "opened",
      body: optionalString(pullRequest.body),
      occurredAt: merged
        ? optionalIsoString(pullRequest.merged_at)
        : optionalIsoString(pullRequest.created_at),
      capturedAt: options.capturedAt,
      extras: {
        author: githubLogin(pullRequest.user),
        number: readGitHubNumber(pullRequest.number, "pull_request.number"),
        ...(merged ? { mergedBy: githubLogin(pullRequest.merged_by) } : {}),
        baseRef: optionalString(readObjectOrEmpty(pullRequest.base).ref),
        headRef: optionalString(readObjectOrEmpty(pullRequest.head).ref),
        additions: optionalNumber(pullRequest.additions),
        deletions: optionalNumber(pullRequest.deletions),
        changedFiles: optionalNumber(pullRequest.changed_files),
        commits: optionalNumber(pullRequest.commits),
        labels: githubLabelNames(pullRequest.labels),
      },
    });
  }

  if (action !== "opened") return null;
  const issue = readObject(root.issue, "issue");
  // Pull requests surface through the issues event too; the pull_request
  // handler above is their single ingestion path.
  if (issue.pull_request) return null;
  return buildGitHubActivityItem({
    kind: "issue",
    repository: readGitHubRepository(root.repository),
    refSegment: `issue:${readGitHubNumber(issue.number, "issue.number")}`,
    title: readString(issue.title, "issue.title"),
    url: readString(issue.html_url, "issue.html_url"),
    state: "opened",
    body: optionalString(issue.body),
    occurredAt: optionalIsoString(issue.created_at),
    capturedAt: options.capturedAt,
    extras: {
      author: githubLogin(issue.user),
      number: readGitHubNumber(issue.number, "issue.number"),
      labels: githubLabelNames(issue.labels),
    },
  });
}

// The `issue_comment` event fires for comments on both issues and pull
// requests — GitHub models a PR as an issue, so a comment on a PR arrives here
// with `issue.pull_request` set. We only ingest newly created comments; the
// comment id makes each one a distinct source item from the parent artifact.
function normalizeGitHubIssueCommentWebhook(
  payload: unknown,
  options: { capturedAt: string },
): NormalizedGitHubActivitySourceItem | null {
  const root = readObject(payload, "payload");
  const action = typeof root.action === "string" ? root.action : "";
  if (action !== "created") return null;
  const issue = readObject(root.issue, "issue");
  const comment = readObject(root.comment, "comment");
  const isPullRequest = Boolean(issue.pull_request);
  const number = readGitHubNumber(issue.number, "issue.number");
  const commentId = readGitHubNumber(comment.id, "comment.id");
  return buildGitHubActivityItem({
    kind: isPullRequest ? "pull_request" : "issue",
    repository: readGitHubRepository(root.repository),
    refSegment: `${isPullRequest ? "pull" : "issue"}:${number}:comment:${commentId}`,
    title: readString(issue.title, "issue.title"),
    // The comment permalink deep-links into the still-live thread, so it
    // remains a valid pointer home for the copy/pointer contract.
    url: readString(comment.html_url, "comment.html_url"),
    state: "commented",
    body: optionalString(comment.body),
    occurredAt: optionalIsoString(comment.created_at),
    capturedAt: options.capturedAt,
    extras: {
      author: githubLogin(comment.user),
      number,
      labels: githubLabelNames(issue.labels),
    },
  });
}

export function isNormalizedGitHubActivitySourceItem(
  value: unknown,
): value is NormalizedGitHubActivitySourceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NormalizedGitHubActivitySourceItem>;
  if (
    item.sourceProvider !== "github" ||
    item.sourceType !== "activity" ||
    typeof item.externalId !== "string" ||
    typeof item.sourceRef !== "string" ||
    typeof item.title !== "string" ||
    typeof item.occurredAt !== "string" ||
    typeof item.capturedAt !== "string" ||
    typeof item.contentHash !== "string" ||
    !item.content ||
    typeof item.content !== "object"
  ) {
    return false;
  }
  const activity = (item.content as Partial<NormalizedGitHubActivityContent>).activity;
  return (
    !!activity &&
    typeof activity === "object" &&
    (activity.kind === "pull_request" || activity.kind === "issue") &&
    !!activity.repository &&
    typeof activity.repository === "object" &&
    typeof activity.repository.id === "string" &&
    typeof activity.repository.fullName === "string" &&
    typeof activity.title === "string" &&
    typeof activity.url === "string" &&
    (activity.state === "opened" ||
      activity.state === "merged" ||
      activity.state === "commented") &&
    typeof activity.body === "string"
  );
}

function buildGitHubActivityItem(input: {
  kind: NormalizedGitHubActivityKind;
  repository: { id: string; fullName: string; private: boolean };
  refSegment: string;
  title: string;
  url: string;
  state: NormalizedGitHubActivityContent["activity"]["state"];
  body: string | undefined;
  occurredAt: string | undefined;
  capturedAt: string;
  extras: {
    [K in keyof NormalizedGitHubActivityContent["activity"]]?:
      | NormalizedGitHubActivityContent["activity"][K]
      | undefined;
  };
}): NormalizedGitHubActivitySourceItem {
  const capturedAt = optionalIsoString(input.capturedAt);
  if (!capturedAt) throw invalid("activity capturedAt must be a timestamp", "invalid_activity");
  const occurredAt = input.occurredAt ?? capturedAt;
  const fullBody = input.body ?? "";
  const body = truncateUtf8Bytes(fullBody, GITHUB_ACTIVITY_BODY_LIMIT_BYTES);
  const externalId = `${input.repository.fullName}:${input.refSegment}`;
  const extras = Object.fromEntries(
    Object.entries(input.extras).filter(([, value]) => value !== undefined),
  );

  const activity: NormalizedGitHubActivityContent["activity"] = {
    kind: input.kind,
    repository: input.repository,
    title: input.title,
    url: input.url,
    state: input.state,
    body,
    truncatedBody: body.length < fullBody.length,
    ...extras,
  };
  const contentHashInput = {
    sourceProvider: "github",
    sourceType: "activity",
    externalId,
    state: input.state,
    title: input.title,
    body,
    occurredAt,
  };

  const numberLabel = typeof activity.number === "number" ? `#${activity.number} ` : "";
  return {
    sourceProvider: "github",
    sourceType: "activity",
    externalId,
    sourceRef: `github:${externalId}`,
    title: `${input.repository.fullName} ${numberLabel}${input.state}: ${input.title}`,
    occurredAt,
    capturedAt,
    contentHash: sha256(stableJson(contentHashInput)),
    contentHashInput,
    content: { activity },
  };
}

function readGitHubRepository(value: unknown): {
  id: string;
  fullName: string;
  private: boolean;
} {
  const repository = readObject(value, "repository");
  const id = repository.id;
  if (typeof id !== "number" && typeof id !== "string") {
    throw invalid("repository.id must be a number or string", "invalid_activity");
  }
  return {
    id: String(id),
    fullName: readString(repository.full_name, "repository.full_name"),
    private: repository.private === true,
  };
}

function readGitHubNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(`${path} must be a number`, "invalid_activity");
  }
  return value;
}

function githubLogin(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return optionalString((value as Record<string, unknown>).login);
}

function githubLabelNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.flatMap((label) => {
    if (!label || typeof label !== "object" || Array.isArray(label)) return [];
    const name = optionalString((label as Record<string, unknown>).name);
    return name ? [name] : [];
  });
  return names.length > 0 ? names : undefined;
}

function readObjectOrEmpty(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncateUtf8Bytes(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let result = value;
  while (Buffer.byteLength(result, "utf8") > limit) {
    result = result.slice(0, Math.max(0, Math.floor(result.length * 0.9) - 1));
  }
  return result;
}

export type NormalizedGmailThreadMessage = {
  messageId: string;
  direction: "sent" | "received";
  from: string;
  to?: string;
  cc?: string;
  sentAt: string;
  /** text/plain body with quoted replies stripped best-effort; the evidence
   * snapshot keeps the unstripped text. */
  bodyText: string;
  snippet?: string;
};

export type NormalizedGmailThreadContent = {
  thread: {
    /** The connected mailbox the window was polled from. */
    accountEmail?: string;
    threadId: string;
    subject: string;
    participants: string[];
    /** True when the live thread snapshot could not be fetched (deleted
     * message, revoked token); messages then reflect buffered metadata only. */
    snapshotStale?: boolean;
    windowStart: string;
    windowEnd: string;
    messages: NormalizedGmailThreadMessage[];
  };
};

export type NormalizedGmailThreadSourceItem =
  NormalizedBrainSourceItem<NormalizedGmailThreadContent> & {
    sourceProvider: "gmail";
    sourceType: "thread";
  };

export function normalizeGmailThreadWindow(input: {
  // Minted per flush, so it doubles as the stable external id for dedupe: a
  // thread that gains new messages later produces a fresh source item.
  windowId: string;
  threadId: string;
  subject?: string;
  messages: NormalizedGmailThreadMessage[];
  flushedAt: string;
  accountEmail?: string;
  snapshotStale?: boolean;
}): NormalizedGmailThreadSourceItem {
  const windowId = input.windowId.trim();
  if (!windowId) throw invalid("thread windowId must not be empty", "invalid_thread");
  const threadId = input.threadId.trim();
  if (!threadId) throw invalid("thread threadId must not be empty", "invalid_thread");
  if (input.messages.length === 0) {
    throw invalid("thread messages must not be empty", "invalid_thread");
  }
  const flushedAt = optionalIsoString(input.flushedAt);
  if (!flushedAt) throw invalid("thread flushedAt must be a timestamp", "invalid_thread");

  const messages = [...input.messages].sort(
    (a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime(),
  );
  const windowStart = messages[0]!.sentAt;
  const windowEnd = messages[messages.length - 1]!.sentAt;
  const subject = optionalString(input.subject) ?? "(no subject)";
  const accountEmail = optionalString(input.accountEmail);
  const participants = [
    ...new Set(
      messages.flatMap((message) =>
        [message.from, message.to, message.cc].flatMap((header) =>
          header ? splitAddressHeader(header) : [],
        ),
      ),
    ),
  ];

  const contentHashInput = {
    sourceProvider: "gmail",
    sourceType: "thread",
    threadId,
    subject,
    messages: messages.map((message) => ({
      messageId: message.messageId,
      direction: message.direction,
      sentAt: message.sentAt,
    })),
  };

  return {
    sourceProvider: "gmail",
    sourceType: "thread",
    externalId: windowId,
    sourceRef: `gmail:thread:${threadId}`,
    title: subject,
    occurredAt: windowStart,
    capturedAt: flushedAt,
    contentHash: sha256(stableJson(contentHashInput)),
    contentHashInput,
    content: {
      thread: {
        ...(accountEmail ? { accountEmail } : {}),
        threadId,
        subject,
        participants,
        ...(input.snapshotStale ? { snapshotStale: true } : {}),
        windowStart,
        windowEnd,
        messages,
      },
    },
  };
}

export function isNormalizedGmailThreadSourceItem(
  value: unknown,
): value is NormalizedGmailThreadSourceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NormalizedGmailThreadSourceItem>;
  if (
    item.sourceProvider !== "gmail" ||
    item.sourceType !== "thread" ||
    typeof item.externalId !== "string" ||
    typeof item.sourceRef !== "string" ||
    typeof item.title !== "string" ||
    typeof item.occurredAt !== "string" ||
    typeof item.capturedAt !== "string" ||
    typeof item.contentHash !== "string" ||
    !item.content ||
    typeof item.content !== "object"
  ) {
    return false;
  }
  const thread = (item.content as Partial<NormalizedGmailThreadContent>).thread;
  return (
    !!thread &&
    typeof thread === "object" &&
    typeof thread.threadId === "string" &&
    typeof thread.subject === "string" &&
    Array.isArray(thread.participants) &&
    Array.isArray(thread.messages) &&
    thread.messages.length > 0
  );
}

export type NormalizedGoogleDriveDocumentContent = {
  document: {
    fileId: string;
    name: string;
    mimeType: string;
    webViewLink?: string;
    driveId?: string;
    modifiedTime: string;
    version: string;
    extractedText: string;
    contentSha256: string;
    owners?: string[];
    lastModifyingUser?: string;
  };
};

export type NormalizedGoogleDriveDocumentSourceItem =
  NormalizedBrainSourceItem<NormalizedGoogleDriveDocumentContent> & {
    sourceProvider: "google_drive";
    sourceType: "document";
  };

export function normalizeGoogleDriveDocument(input: {
  fileId: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  driveId?: string;
  modifiedTime: string;
  version: string;
  extractedText: string;
  contentSha256: string;
  owners?: string[];
  lastModifyingUser?: string;
  capturedAt: string;
}): NormalizedGoogleDriveDocumentSourceItem {
  const fileId = input.fileId.trim();
  if (!fileId) throw invalid("Drive fileId must not be empty", "invalid_document");
  const name = input.name.trim();
  if (!name) throw invalid("Drive name must not be empty", "invalid_document");
  const mimeType = input.mimeType.trim();
  if (!mimeType) throw invalid("Drive mimeType must not be empty", "invalid_document");
  const modifiedTime = optionalIsoString(input.modifiedTime);
  if (!modifiedTime) {
    throw invalid("Drive modifiedTime must be a timestamp", "invalid_document");
  }
  const capturedAt = optionalIsoString(input.capturedAt);
  if (!capturedAt) throw invalid("Drive capturedAt must be a timestamp", "invalid_document");
  const version = input.version.trim();
  if (!version) throw invalid("Drive version must not be empty", "invalid_document");
  const contentSha256 = input.contentSha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(contentSha256)) {
    throw invalid("Drive contentSha256 must be a sha256 hex digest", "invalid_document");
  }

  const document = {
    fileId,
    name,
    mimeType,
    ...(optionalString(input.webViewLink) ? { webViewLink: input.webViewLink!.trim() } : {}),
    ...(optionalString(input.driveId) ? { driveId: input.driveId!.trim() } : {}),
    modifiedTime,
    version,
    extractedText: input.extractedText,
    contentSha256,
    ...(input.owners?.length
      ? { owners: [...new Set(input.owners.map((owner) => owner.trim()).filter(Boolean))] }
      : {}),
    ...(optionalString(input.lastModifyingUser)
      ? { lastModifyingUser: input.lastModifyingUser!.trim() }
      : {}),
  };
  const contentHashInput = {
    sourceProvider: "google_drive",
    sourceType: "document",
    fileId,
    mimeType,
    contentSha256,
  };

  return {
    sourceProvider: "google_drive",
    sourceType: "document",
    externalId: fileId,
    sourceRef: `google-drive:file:${fileId}`,
    title: name,
    occurredAt: modifiedTime,
    capturedAt,
    contentHash: sha256(stableJson(contentHashInput)),
    contentHashInput,
    content: { document },
  };
}

export function isNormalizedGoogleDriveDocumentSourceItem(
  value: unknown,
): value is NormalizedGoogleDriveDocumentSourceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NormalizedGoogleDriveDocumentSourceItem>;
  if (
    item.sourceProvider !== "google_drive" ||
    item.sourceType !== "document" ||
    typeof item.externalId !== "string" ||
    typeof item.sourceRef !== "string" ||
    typeof item.title !== "string" ||
    typeof item.occurredAt !== "string" ||
    typeof item.capturedAt !== "string" ||
    typeof item.contentHash !== "string" ||
    !item.content ||
    typeof item.content !== "object"
  ) {
    return false;
  }
  const document = (item.content as Partial<NormalizedGoogleDriveDocumentContent>).document;
  return (
    !!document &&
    typeof document === "object" &&
    typeof document.fileId === "string" &&
    typeof document.name === "string" &&
    typeof document.mimeType === "string" &&
    typeof document.modifiedTime === "string" &&
    typeof document.version === "string" &&
    typeof document.extractedText === "string" &&
    typeof document.contentSha256 === "string"
  );
}

// "Ada Lovelace <ada@example.com>, bob@example.com" -> both address entries,
// trimmed, keeping display names so participants read naturally in the brain.
function splitAddressHeader(header: string): string[] {
  return header
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export class BrainSourceNormalizationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "BrainSourceNormalizationError";
  }
}

export function normalizeJamieMeetingCompletedWebhook(
  payload: unknown,
  options: { capturedAt?: string } = {},
): NormalizedJamieMeetingSourceItem {
  const root = readObject(payload, "payload");
  const metadata = readObject(root.metadata, "metadata");
  const eventName = readString(metadata.event, "metadata.event");
  if (eventName !== "meeting.completed") {
    throw invalid("metadata.event must be meeting.completed", "invalid_event");
  }

  const data = readObject(root.data, "data");
  const event = readObject(data.event, "data.event");
  const user = readObject(data.user, "data.user");
  const userId = readString(user.id, "data.user.id");
  const userEmail = optionalString(user.email);

  const title = readString(event.title ?? data.title, "data.event.title");
  const startTime = readIsoString(
    event.startTime ?? event.scheduledTime ?? data.startTime,
    "data.event.startTime",
  );
  const endTime = optionalIsoString(event.endTime ?? data.endTime);
  const summaryMarkdown = normalizeSummary(event.summary ?? data.summary);
  const transcript = normalizeTranscript(event.transcript ?? data.transcript);
  const participants = normalizeParticipants(event.participants ?? data.participants);
  const actionItems = normalizeActionItems(
    event.actionItems ?? event.tasks ?? data.actionItems ?? data.tasks,
  );
  const eventId = optionalString(event.id);
  const externalEventId = optionalString(event.externalId);
  const externalId =
    externalEventId ?? eventId ?? derivedJamieMeetingExternalId(userId, startTime, title);
  const capturedAt =
    optionalIsoString(options.capturedAt) ?? optionalIsoString(metadata.created) ?? startTime;
  const sourceRef = `jamie:meeting:${externalId}`;

  const contentHashInput = {
    sourceProvider: "jamie",
    sourceType: "meeting",
    externalId,
    title,
    startTime,
    ...(endTime ? { endTime } : {}),
    summaryMarkdown,
    participants,
    actionItems,
    transcript,
  };

  return {
    sourceProvider: "jamie",
    sourceType: "meeting",
    externalId,
    sourceRef,
    title,
    occurredAt: startTime,
    capturedAt,
    contentHash: sha256(stableJson(contentHashInput)),
    contentHashInput,
    content: {
      user: {
        id: userId,
        ...(userEmail ? { email: userEmail } : {}),
      },
      event: {
        ...(eventId ? { id: eventId } : {}),
        ...(externalEventId ? { externalId: externalEventId } : {}),
      },
      meeting: {
        title,
        startTime,
        ...(endTime ? { endTime } : {}),
        summaryMarkdown,
        participants,
        actionItems,
        transcript,
      },
    },
  };
}

export function isNormalizedJamieMeetingSourceItem(
  value: unknown,
): value is NormalizedJamieMeetingSourceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NormalizedJamieMeetingSourceItem>;
  return (
    item.sourceProvider === "jamie" &&
    item.sourceType === "meeting" &&
    typeof item.externalId === "string" &&
    typeof item.sourceRef === "string" &&
    typeof item.title === "string" &&
    typeof item.occurredAt === "string" &&
    typeof item.capturedAt === "string" &&
    typeof item.contentHash === "string" &&
    !!item.content &&
    typeof item.content === "object"
  );
}

function normalizeSummary(value: unknown): string {
  if (typeof value === "string") return readNonEmpty(value, "data.event.summary");
  const summary = readObject(value, "data.event.summary");
  const markdown = optionalString(summary.markdown) ?? optionalString(summary.text);
  if (!markdown)
    throw invalid("data.event.summary must include markdown or text", "invalid_summary");
  return markdown;
}

function normalizeTranscript(value: unknown): NormalizedJamieMeetingTranscriptSegment[] {
  if (!Array.isArray(value)) {
    throw invalid("data.event.transcript must be an array", "invalid_transcript");
  }
  if (value.length === 0)
    throw invalid("data.event.transcript must not be empty", "invalid_transcript");
  return value.map((segment, index) => {
    const object = readObject(segment, `data.event.transcript[${index}]`);
    const text = readString(object.text ?? object.content, `data.event.transcript[${index}].text`);
    const speaker =
      optionalString(object.speakerName) ??
      optionalString(object.speaker_name) ??
      speakerName(object.speaker);
    const startedAt =
      optionalTimestampString(object.startedAt) ??
      optionalTimestampString(object.startTime) ??
      optionalTimestampString(object.start_time) ??
      optionalTimestampString(object.timestamp);
    const endedAt =
      optionalTimestampString(object.endedAt) ??
      optionalTimestampString(object.endTime) ??
      optionalTimestampString(object.end_time);
    return {
      text,
      ...(speaker ? { speaker } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
    };
  });
}

function normalizeParticipants(value: unknown): NormalizedJamieMeetingParticipant[] {
  if (value == null) return [];
  if (!Array.isArray(value))
    throw invalid("data.event.participants must be an array", "invalid_participants");
  return value.flatMap((participant, index) => {
    if (typeof participant === "string") {
      return [
        {
          name: readNonEmpty(participant, `data.event.participants[${index}]`),
        },
      ];
    }
    const object = readObject(participant, `data.event.participants[${index}]`);
    const id = optionalString(object.id);
    const name = optionalString(object.name);
    const email = optionalString(object.email);
    const normalized: NormalizedJamieMeetingParticipant = {
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
    };
    return normalized.id || normalized.name || normalized.email ? [normalized] : [];
  });
}

function normalizeActionItems(value: unknown): NormalizedJamieMeetingActionItem[] {
  if (value == null) return [];
  if (!Array.isArray(value))
    throw invalid("data.event.actionItems must be an array", "invalid_action_items");
  return value.flatMap((action, index) => {
    if (typeof action === "string")
      return [{ text: readNonEmpty(action, `data.event.actionItems[${index}]`) }];
    const object = readObject(action, `data.event.actionItems[${index}]`);
    const text =
      optionalString(object.text) ?? optionalString(object.title) ?? optionalString(object.content);
    if (!text) return [];
    const assignee =
      optionalString(object.assignee) ??
      optionalString(object.assigneeName) ??
      optionalString(object.assignee_name);
    return [
      {
        text,
        ...(assignee ? { assignee } : {}),
      },
    ];
  });
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${path} must be an object`, "invalid_shape");
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, path: string): string {
  if (typeof value !== "string") throw invalid(`${path} must be a string`, "invalid_shape");
  return readNonEmpty(value, path);
}

function readNonEmpty(value: string, path: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw invalid(`${path} must not be empty`, "invalid_shape");
  return trimmed;
}

function readIsoString(value: unknown, path: string): string {
  const text = readString(value, path);
  if (!isValidDateString(text))
    throw invalid(`${path} must be a valid timestamp`, "invalid_timestamp");
  return text;
}

function optionalIsoString(value: unknown): string | undefined {
  const text = optionalString(value);
  if (!text) return undefined;
  return isValidDateString(text) ? text : undefined;
}

function optionalTimestampString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return optionalString(value);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function speakerName(value: unknown): string | undefined {
  if (typeof value === "string") return optionalString(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return optionalString((value as Record<string, unknown>).name);
}

function derivedJamieMeetingExternalId(userId: string, startTime: string, title: string): string {
  return `derived-${sha256(`${userId}:${startTime}:${title}`).slice(0, 32)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function isValidDateString(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time);
}

function invalid(message: string, code: string): BrainSourceNormalizationError {
  return new BrainSourceNormalizationError(message, code);
}
