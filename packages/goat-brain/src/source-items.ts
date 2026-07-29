import { createHash } from "node:crypto";
import { isValidGoatBrainSourceRef, parseGoatBrainSourceRef } from "./schema";

export type BrainSourceProvider =
  | "jamie"
  | "goat-chat"
  | "goat-import"
  | "upload"
  | "slack"
  | "linear"
  | "github"
  | "gmail"
  | "google_drive"
  | "hubspot"
  | "granola"
  | "fathom"
  | "attio";
export type BrainSourceType =
  | "meeting"
  | "run"
  | "capture"
  | "pointer"
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

export type NormalizedGranolaMeetingParticipant = {
  name?: string;
  email?: string;
};

export type NormalizedGranolaMeetingTranscriptSegment = {
  text: string;
  speaker?: string;
  startedAt?: string;
  endedAt?: string;
};

export type NormalizedGranolaMeetingContent = {
  owner: {
    name?: string;
    email?: string;
  };
  note: {
    id: string;
    webUrl?: string;
    createdAt: string;
    updatedAt: string;
  };
  meeting: {
    title: string;
    startTime: string;
    endTime?: string;
    summaryMarkdown: string;
    participants: NormalizedGranolaMeetingParticipant[];
    transcript: NormalizedGranolaMeetingTranscriptSegment[];
  };
};

export type NormalizedGranolaMeetingSourceItem =
  NormalizedBrainSourceItem<NormalizedGranolaMeetingContent> & {
    sourceProvider: "granola";
    sourceType: "meeting";
  };

export type NormalizedFathomMeetingParticipant = {
  name?: string;
  email?: string;
};

export type NormalizedFathomMeetingTranscriptSegment = {
  text: string;
  speaker?: string;
  // Offset into the recording as Fathom reports it (HH:MM:SS).
  startedAt?: string;
};

export type NormalizedFathomMeetingActionItem = {
  description: string;
  assignee?: string;
  completed?: boolean;
};

export type NormalizedFathomMeetingContent = {
  recordedBy: {
    name?: string;
    email?: string;
  };
  recording: {
    id: string;
    url?: string;
    shareUrl?: string;
    createdAt: string;
  };
  meeting: {
    title: string;
    startTime: string;
    endTime?: string;
    summaryMarkdown: string;
    actionItems: NormalizedFathomMeetingActionItem[];
    participants: NormalizedFathomMeetingParticipant[];
    transcript: NormalizedFathomMeetingTranscriptSegment[];
  };
};

export type NormalizedFathomMeetingSourceItem =
  NormalizedBrainSourceItem<NormalizedFathomMeetingContent> & {
    sourceProvider: "fathom";
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

export type GoatBrainHydratablePointerProvider = "slack" | "gmail" | "linear";

export type NormalizedGoatBrainPointerContent = {
  pointer: {
    ref: string;
    fallbackText?: string;
    chatSessionId: string;
    userMessageId: string;
    draftBrainId: string;
    draftFolder: string;
  };
};

export type NormalizedGoatBrainPointerSourceItem =
  NormalizedBrainSourceItem<NormalizedGoatBrainPointerContent> & {
    sourceProvider: GoatBrainHydratablePointerProvider;
    sourceType: "pointer";
  };

export function normalizeGoatBrainPointerCapture(input: {
  sourceRef: string;
  title: string;
  fallbackText?: string;
  chatSessionId: string;
  userMessageId: string;
  draftBrainId: string;
  draftFolder: string;
  capturedAt: string;
}): NormalizedGoatBrainPointerSourceItem {
  const sourceRef = input.sourceRef.trim();
  const parsedRef = parseGoatBrainSourceRef(sourceRef);
  if (!parsedRef || !isHydratablePointerProvider(parsedRef.provider)) {
    throw invalid(
      "pointer sourceRef must identify a supported integration source",
      "invalid_pointer",
    );
  }
  const title = readNonEmpty(input.title, "pointer title");
  const chatSessionId = readNonEmpty(input.chatSessionId, "pointer chatSessionId");
  const userMessageId = readNonEmpty(input.userMessageId, "pointer userMessageId");
  const draftBrainId = readNonEmpty(input.draftBrainId, "pointer draftBrainId");
  const draftFolder = readNonEmpty(input.draftFolder, "pointer draftFolder");
  const capturedAt = optionalIsoString(input.capturedAt);
  if (!capturedAt) throw invalid("pointer capturedAt must be a timestamp", "invalid_pointer");
  const fallbackText = optionalString(input.fallbackText);
  const pointer = {
    ref: sourceRef,
    ...(fallbackText ? { fallbackText } : {}),
    chatSessionId,
    userMessageId,
    draftBrainId,
    draftFolder,
  };
  // Pointer identity deliberately ignores the chat turn, fallback, and draft.
  // Re-saving the same canonical source through one integration therefore
  // deduplicates instead of spending on another hydration of identical input.
  const contentHashInput = {
    sourceProvider: parsedRef.provider,
    sourceType: "pointer",
    sourceRef,
  };

  return {
    sourceProvider: parsedRef.provider,
    sourceType: "pointer",
    externalId: sourceRef,
    sourceRef,
    title,
    occurredAt: capturedAt,
    capturedAt,
    contentHash: sha256(stableJson(contentHashInput)),
    contentHashInput,
    content: { pointer },
  };
}

export function isNormalizedGoatBrainPointerSourceItem(
  value: unknown,
): value is NormalizedGoatBrainPointerSourceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NormalizedGoatBrainPointerSourceItem>;
  if (
    !isHydratablePointerProvider(item.sourceProvider) ||
    item.sourceType !== "pointer" ||
    typeof item.externalId !== "string" ||
    typeof item.sourceRef !== "string" ||
    !isValidGoatBrainSourceRef(item.sourceRef) ||
    typeof item.title !== "string" ||
    typeof item.occurredAt !== "string" ||
    typeof item.capturedAt !== "string" ||
    typeof item.contentHash !== "string" ||
    !item.content ||
    typeof item.content !== "object"
  ) {
    return false;
  }
  const parsedRef = parseGoatBrainSourceRef(item.sourceRef);
  if (parsedRef?.provider !== item.sourceProvider || item.externalId !== item.sourceRef) {
    return false;
  }
  const pointer = (item.content as Partial<NormalizedGoatBrainPointerContent>).pointer;
  return (
    !!pointer &&
    typeof pointer === "object" &&
    pointer.ref === item.sourceRef &&
    typeof pointer.chatSessionId === "string" &&
    typeof pointer.userMessageId === "string" &&
    typeof pointer.draftBrainId === "string" &&
    typeof pointer.draftFolder === "string" &&
    (pointer.fallbackText === undefined || typeof pointer.fallbackText === "string")
  );
}

function isHydratablePointerProvider(value: unknown): value is GoatBrainHydratablePointerProvider {
  return value === "slack" || value === "gmail" || value === "linear";
}

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
  externalId?: string;
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
  const externalId = input.externalId?.trim() || draftBrainId;

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
    externalId,
    title,
    capture,
  };

  return {
    sourceProvider: "goat-chat",
    sourceType: "capture",
    // Normal chat captures use the minted draft id. Durable host-tool callers
    // can supply a stable key so a recovered turn does not create a second draft.
    externalId,
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

export type NormalizedHubspotObjectType = "contact" | "company" | "deal";

export type NormalizedHubspotObjectActivity = {
  occurredAt: string;
  action: "create" | "update";
  propertyName?: string;
  propertyValue?: string;
  changeSource?: string;
};

export type NormalizedHubspotObjectContent = {
  object: {
    portalId: string;
    objectType: NormalizedHubspotObjectType;
    objectId: string;
    /** Display name: deal name, company name, or contact full name. */
    name: string;
    url?: string;
    lifecycleStage?: string;
    ownerName?: string;
    stage?: string;
    pipeline?: string;
    amount?: string;
    closeDate?: string;
    /** Selected CRM properties from the live snapshot, keyed by property name. */
    properties?: Record<string, string>;
    associatedCompanies?: string[];
    associatedContacts?: string[];
    createdAt?: string;
    updatedAt?: string;
    /** True when the live object snapshot could not be fetched (deleted object,
     * revoked token); fields above then reflect the buffered events only. */
    snapshotStale?: boolean;
    windowStart: string;
    windowEnd: string;
    activity: NormalizedHubspotObjectActivity[];
  };
};

export type NormalizedHubspotObjectSourceItem =
  NormalizedBrainSourceItem<NormalizedHubspotObjectContent> & {
    sourceProvider: "hubspot";
    sourceType: "activity";
  };

export function normalizeHubspotObjectWindow(input: {
  // Minted per flush, so it doubles as the stable external id for dedupe.
  windowId: string;
  portalId: string;
  objectType: NormalizedHubspotObjectType;
  objectId: string;
  name: string;
  activity: NormalizedHubspotObjectActivity[];
  flushedAt: string;
  url?: string;
  lifecycleStage?: string;
  ownerName?: string;
  stage?: string;
  pipeline?: string;
  amount?: string;
  closeDate?: string;
  properties?: Record<string, string>;
  associatedCompanies?: string[];
  associatedContacts?: string[];
  createdAt?: string;
  updatedAt?: string;
  snapshotStale?: boolean;
}): NormalizedHubspotObjectSourceItem {
  const windowId = input.windowId.trim();
  if (!windowId) throw invalid("object windowId must not be empty", "invalid_object");
  const portalId = input.portalId.trim();
  if (!portalId) throw invalid("object portalId must not be empty", "invalid_object");
  const objectId = input.objectId.trim();
  if (!objectId) throw invalid("object objectId must not be empty", "invalid_object");
  if (input.activity.length === 0) {
    throw invalid("object activity must not be empty", "invalid_object");
  }
  const flushedAt = optionalIsoString(input.flushedAt);
  if (!flushedAt) throw invalid("object flushedAt must be a timestamp", "invalid_object");
  const name = optionalString(input.name) ?? objectId;

  const activity = [...input.activity].sort(
    (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
  );
  const windowStart = activity[0]!.occurredAt;
  const windowEnd = activity[activity.length - 1]!.occurredAt;
  const url = optionalString(input.url);
  const lifecycleStage = optionalString(input.lifecycleStage);
  const ownerName = optionalString(input.ownerName);
  const stage = optionalString(input.stage);
  const pipeline = optionalString(input.pipeline);
  const amount = optionalString(input.amount);
  const closeDate = optionalString(input.closeDate);
  const createdAt = optionalIsoString(input.createdAt);
  const updatedAt = optionalIsoString(input.updatedAt);
  const properties =
    input.properties && Object.keys(input.properties).length > 0 ? input.properties : undefined;
  const associatedCompanies =
    input.associatedCompanies && input.associatedCompanies.length > 0
      ? input.associatedCompanies
      : undefined;
  const associatedContacts =
    input.associatedContacts && input.associatedContacts.length > 0
      ? input.associatedContacts
      : undefined;

  const object = {
    portalId,
    objectType: input.objectType,
    objectId,
    name,
    ...(url ? { url } : {}),
    ...(lifecycleStage ? { lifecycleStage } : {}),
    ...(ownerName ? { ownerName } : {}),
    ...(stage ? { stage } : {}),
    ...(pipeline ? { pipeline } : {}),
    ...(amount ? { amount } : {}),
    ...(closeDate ? { closeDate } : {}),
    ...(properties ? { properties } : {}),
    ...(associatedCompanies ? { associatedCompanies } : {}),
    ...(associatedContacts ? { associatedContacts } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(input.snapshotStale ? { snapshotStale: true } : {}),
    windowStart,
    windowEnd,
    activity,
  };
  const contentHashInput = {
    sourceProvider: "hubspot",
    sourceType: "activity",
    portalId,
    objectType: input.objectType,
    objectId,
    activity: activity.map((entry) => ({
      occurredAt: entry.occurredAt,
      action: entry.action,
      ...(entry.propertyName ? { propertyName: entry.propertyName } : {}),
    })),
    name,
    ...(stage ? { stage } : {}),
  };

  return {
    sourceProvider: "hubspot",
    sourceType: "activity",
    externalId: windowId,
    // HubSpot object ids are unique only within a portal. Keep the portal in
    // provenance so records from two connected accounts can never collide.
    sourceRef: `hubspot:${portalId}:${input.objectType}:${objectId}`,
    title: name,
    occurredAt: windowStart,
    capturedAt: flushedAt,
    contentHash: sha256(stableJson(contentHashInput)),
    contentHashInput,
    content: { object },
  };
}

export function isNormalizedHubspotObjectSourceItem(
  value: unknown,
): value is NormalizedHubspotObjectSourceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NormalizedHubspotObjectSourceItem>;
  if (
    item.sourceProvider !== "hubspot" ||
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
  const object = (item.content as Partial<NormalizedHubspotObjectContent>).object;
  return (
    !!object &&
    typeof object === "object" &&
    typeof object.portalId === "string" &&
    typeof object.objectType === "string" &&
    typeof object.objectId === "string" &&
    typeof object.name === "string" &&
    Array.isArray(object.activity) &&
    object.activity.length > 0
  );
}

export type NormalizedAttioObjectType = "person" | "company" | "deal";

export type NormalizedAttioObjectActivity = {
  occurredAt: string;
  action: "create" | "update" | "note";
  /** Resolved attribute title for update events, when enrichment succeeded. */
  attributeName?: string;
  noteTitle?: string;
  actorType?: string;
};

export type NormalizedAttioObjectNote = {
  noteId: string;
  title: string;
  createdAt?: string;
  /** Plaintext note content, truncated by the flush worker. */
  content: string;
};

export type NormalizedAttioObjectContent = {
  object: {
    workspaceId: string;
    objectType: NormalizedAttioObjectType;
    recordId: string;
    /** Display name: person full name, company name, or deal name. */
    name: string;
    url?: string;
    stage?: string;
    /** Selected record values from the live snapshot, keyed by attribute slug. */
    properties?: Record<string, string>;
    createdAt?: string;
    /** True when the live record snapshot could not be fetched (deleted record,
     * revoked key); fields above then reflect the buffered events only. */
    snapshotStale?: boolean;
    windowStart: string;
    windowEnd: string;
    activity: NormalizedAttioObjectActivity[];
    /** Full content of notes added inside this window, fetched at flush time. */
    notes?: NormalizedAttioObjectNote[];
  };
};

export type NormalizedAttioObjectSourceItem =
  NormalizedBrainSourceItem<NormalizedAttioObjectContent> & {
    sourceProvider: "attio";
    sourceType: "activity";
  };

export function normalizeAttioObjectWindow(input: {
  // Minted per flush, so it doubles as the stable external id for dedupe.
  windowId: string;
  workspaceId: string;
  objectType: NormalizedAttioObjectType;
  recordId: string;
  name: string;
  activity: NormalizedAttioObjectActivity[];
  flushedAt: string;
  url?: string;
  stage?: string;
  properties?: Record<string, string>;
  createdAt?: string;
  snapshotStale?: boolean;
  notes?: NormalizedAttioObjectNote[];
}): NormalizedAttioObjectSourceItem {
  const windowId = input.windowId.trim();
  if (!windowId) throw invalid("object windowId must not be empty", "invalid_object");
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) throw invalid("object workspaceId must not be empty", "invalid_object");
  const recordId = input.recordId.trim();
  if (!recordId) throw invalid("object recordId must not be empty", "invalid_object");
  if (input.activity.length === 0) {
    throw invalid("object activity must not be empty", "invalid_object");
  }
  const flushedAt = optionalIsoString(input.flushedAt);
  if (!flushedAt) throw invalid("object flushedAt must be a timestamp", "invalid_object");
  const name = optionalString(input.name) ?? recordId;

  const activity = [...input.activity].sort(
    (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
  );
  const windowStart = activity[0]!.occurredAt;
  const windowEnd = activity[activity.length - 1]!.occurredAt;
  const url = optionalString(input.url);
  const stage = optionalString(input.stage);
  const createdAt = optionalIsoString(input.createdAt);
  const properties =
    input.properties && Object.keys(input.properties).length > 0 ? input.properties : undefined;
  const notes = input.notes && input.notes.length > 0 ? input.notes : undefined;

  const object = {
    workspaceId,
    objectType: input.objectType,
    recordId,
    name,
    ...(url ? { url } : {}),
    ...(stage ? { stage } : {}),
    ...(properties ? { properties } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(input.snapshotStale ? { snapshotStale: true } : {}),
    windowStart,
    windowEnd,
    activity,
    ...(notes ? { notes } : {}),
  };
  const contentHashInput = {
    sourceProvider: "attio",
    sourceType: "activity",
    workspaceId,
    objectType: input.objectType,
    recordId,
    activity: activity.map((entry) => ({
      occurredAt: entry.occurredAt,
      action: entry.action,
      ...(entry.attributeName ? { attributeName: entry.attributeName } : {}),
    })),
    name,
    ...(stage ? { stage } : {}),
    ...(notes ? { noteIds: notes.map((note) => note.noteId) } : {}),
  };

  return {
    sourceProvider: "attio",
    sourceType: "activity",
    externalId: windowId,
    // Attio record ids are unique only within a workspace. Keep the workspace
    // in provenance so records from two connected accounts can never collide.
    sourceRef: `attio:${workspaceId}:${input.objectType}:${recordId}`,
    title: name,
    occurredAt: windowStart,
    capturedAt: flushedAt,
    contentHash: sha256(stableJson(contentHashInput)),
    contentHashInput,
    content: { object },
  };
}

export function isNormalizedAttioObjectSourceItem(
  value: unknown,
): value is NormalizedAttioObjectSourceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NormalizedAttioObjectSourceItem>;
  if (
    item.sourceProvider !== "attio" ||
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
  const object = (item.content as Partial<NormalizedAttioObjectContent>).object;
  return (
    !!object &&
    typeof object === "object" &&
    typeof object.workspaceId === "string" &&
    typeof object.objectType === "string" &&
    typeof object.recordId === "string" &&
    typeof object.name === "string" &&
    Array.isArray(object.activity) &&
    object.activity.length > 0
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

export type NormalizedGitHubActivityEvent = {
  state: "opened" | "merged" | "commented";
  occurredAt: string;
  sourceRef: string;
  url: string;
  body: string;
  truncatedBody: boolean;
  author?: string;
  mergedBy?: string;
  baseRef?: string;
  headRef?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  commits?: number;
  labels?: string[];
};

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
    // Present for buffered pull-request windows. Older persisted items and
    // direct-enqueued issue activity remain valid single-event items.
    windowStart?: string;
    windowEnd?: string;
    events?: NormalizedGitHubActivityEvent[];
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

// Combines normalized webhook events for one pull request into a single source
// item. Each event remains explicit evidence for the ingest agent, while the
// PR-level source ref stays stable and one flush produces one billed agent job.
export function normalizeGitHubPullRequestWindow(input: {
  windowId: string;
  events: readonly NormalizedGitHubActivitySourceItem[];
  flushedAt: string;
}): NormalizedGitHubActivitySourceItem {
  const windowId = input.windowId.trim();
  if (!windowId) throw invalid("GitHub windowId must not be empty", "invalid_activity");
  const flushedAt = optionalIsoString(input.flushedAt);
  if (!flushedAt) throw invalid("GitHub flushedAt must be a timestamp", "invalid_activity");
  if (input.events.length === 0) {
    throw invalid("GitHub pull request window must not be empty", "invalid_activity");
  }

  const sorted = input.events
    .map((item) => {
      if (!isNormalizedGitHubActivitySourceItem(item)) {
        throw invalid("GitHub window contains an invalid activity item", "invalid_activity");
      }
      const activity = item.content.activity;
      if (activity.kind !== "pull_request" || activity.number === undefined) {
        throw invalid("GitHub window contains non-pull-request activity", "invalid_activity");
      }
      const occurredAt = optionalIsoString(item.occurredAt);
      if (!occurredAt) {
        throw invalid("GitHub activity occurredAt must be a timestamp", "invalid_activity");
      }
      return { item, activity, occurredAt };
    })
    .sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());

  const first = sorted[0]!;
  for (const event of sorted.slice(1)) {
    if (
      event.activity.repository.id !== first.activity.repository.id ||
      event.activity.number !== first.activity.number
    ) {
      throw invalid("GitHub window events must belong to one pull request", "invalid_activity");
    }
  }

  const latest = sorted.at(-1)!;
  const events: NormalizedGitHubActivityEvent[] = sorted.map(({ item, activity, occurredAt }) => ({
    state: activity.state,
    occurredAt,
    sourceRef: item.sourceRef,
    url: activity.url,
    body: activity.body,
    truncatedBody: activity.truncatedBody,
    ...(activity.author ? { author: activity.author } : {}),
    ...(activity.mergedBy ? { mergedBy: activity.mergedBy } : {}),
    ...(activity.baseRef ? { baseRef: activity.baseRef } : {}),
    ...(activity.headRef ? { headRef: activity.headRef } : {}),
    ...(activity.additions !== undefined ? { additions: activity.additions } : {}),
    ...(activity.deletions !== undefined ? { deletions: activity.deletions } : {}),
    ...(activity.changedFiles !== undefined ? { changedFiles: activity.changedFiles } : {}),
    ...(activity.commits !== undefined ? { commits: activity.commits } : {}),
    ...(activity.labels ? { labels: activity.labels } : {}),
  }));
  const windowStart = events[0]!.occurredAt;
  const windowEnd = events.at(-1)!.occurredAt;
  // A comment is activity on the PR, not its lifecycle state. Prefer the
  // newest opened/merged snapshot for the window-level state and canonical
  // URL; a comment-only follow-up window falls back to its newest comment.
  const lifecycleSnapshot =
    [...sorted].reverse().find((event) => event.activity.state !== "commented") ?? latest;
  const activity: NormalizedGitHubActivityContent["activity"] = {
    ...lifecycleSnapshot.activity,
    repository: latest.activity.repository,
    title: latest.activity.title,
    windowStart,
    windowEnd,
    events,
  };
  const contentHashInput = {
    sourceProvider: "github",
    sourceType: "activity",
    repositoryId: activity.repository.id,
    pullRequestNumber: activity.number,
    title: activity.title,
    events,
  };
  const externalId = `${activity.repository.fullName}:pull:${activity.number}`;

  return {
    sourceProvider: "github",
    sourceType: "activity",
    externalId: windowId,
    sourceRef: `github:${externalId}`,
    title: `${activity.repository.fullName} #${activity.number} activity: ${activity.title}`,
    occurredAt: windowStart,
    capturedAt: flushedAt,
    contentHash: sha256(stableJson(contentHashInput)),
    contentHashInput,
    content: { activity },
  };
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
  const validEvents =
    activity?.events === undefined ||
    (Array.isArray(activity.events) &&
      activity.events.length > 0 &&
      activity.events.every(
        (event) =>
          !!event &&
          typeof event === "object" &&
          (event.state === "opened" || event.state === "merged" || event.state === "commented") &&
          typeof event.occurredAt === "string" &&
          typeof event.sourceRef === "string" &&
          typeof event.url === "string" &&
          typeof event.body === "string" &&
          typeof event.truncatedBody === "boolean",
      ) &&
      typeof activity.windowStart === "string" &&
      typeof activity.windowEnd === "string");
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
    typeof activity.body === "string" &&
    validEvents
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

// Normalizes one note from the Granola public API (GET /v1/notes/{id} with
// include=transcript). Granola only lists notes whose AI summary and
// transcript are generated, but the guard on the summary stays defensive.
export function normalizeGranolaMeetingNote(
  payload: unknown,
  options: { capturedAt?: string } = {},
): NormalizedGranolaMeetingSourceItem {
  const root = readObject(payload, "note");
  const noteId = readString(root.id, "note.id");
  const calendarEvent =
    root.calendar_event && typeof root.calendar_event === "object"
      ? readObject(root.calendar_event, "note.calendar_event")
      : null;
  const title =
    optionalString(root.title) ??
    (calendarEvent ? optionalString(calendarEvent.event_title) : undefined) ??
    "Untitled meeting";
  const createdAt = readIsoString(root.created_at, "note.created_at");
  const updatedAt = optionalIsoString(root.updated_at) ?? createdAt;
  const webUrl = optionalString(root.web_url);
  const summaryMarkdown =
    optionalString(root.summary_markdown) ?? optionalString(root.summary_text);
  if (!summaryMarkdown) {
    throw invalid("note.summary_markdown or note.summary_text is required", "invalid_summary");
  }
  const startTime =
    (calendarEvent ? optionalIsoString(calendarEvent.scheduled_start_time) : undefined) ??
    createdAt;
  const endTime = calendarEvent ? optionalIsoString(calendarEvent.scheduled_end_time) : undefined;
  const participants = normalizeGranolaParticipants(root.attendees, calendarEvent);
  const transcript = normalizeGranolaTranscript(root.transcript);
  const ownerObject =
    root.owner && typeof root.owner === "object" ? readObject(root.owner, "note.owner") : null;
  const ownerName = ownerObject ? optionalString(ownerObject.name) : undefined;
  const ownerEmail = ownerObject ? optionalString(ownerObject.email) : undefined;
  const capturedAt = optionalIsoString(options.capturedAt) ?? updatedAt;

  const contentHashInput = {
    sourceProvider: "granola",
    sourceType: "meeting",
    externalId: noteId,
    title,
    startTime,
    ...(endTime ? { endTime } : {}),
    summaryMarkdown,
    participants,
    transcript,
  };

  return {
    sourceProvider: "granola",
    sourceType: "meeting",
    externalId: noteId,
    sourceRef: `granola:note:${noteId}`,
    title,
    occurredAt: startTime,
    capturedAt,
    contentHash: sha256(stableJson(contentHashInput)),
    contentHashInput,
    content: {
      owner: {
        ...(ownerName ? { name: ownerName } : {}),
        ...(ownerEmail ? { email: ownerEmail } : {}),
      },
      note: {
        id: noteId,
        ...(webUrl ? { webUrl } : {}),
        createdAt,
        updatedAt,
      },
      meeting: {
        title,
        startTime,
        ...(endTime ? { endTime } : {}),
        summaryMarkdown,
        participants,
        transcript,
      },
    },
  };
}

export function isNormalizedGranolaMeetingSourceItem(
  value: unknown,
): value is NormalizedGranolaMeetingSourceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NormalizedGranolaMeetingSourceItem>;
  return (
    item.sourceProvider === "granola" &&
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

// Normalizes one meeting from the Fathom public API (GET /external/v1/meetings
// with include_transcript, include_summary, and include_action_items). The
// live poll worker only normalizes meetings once the summary and transcript
// responses are ready. Both fields still degrade to empty because history import
// and stored payload validation must tolerate generation failures or disabled
// content.
export function normalizeFathomMeeting(
  payload: unknown,
  options: { capturedAt?: string } = {},
): NormalizedFathomMeetingSourceItem {
  const root = readObject(payload, "meeting");
  const recordingIdValue = root.recording_id;
  const recordingId =
    typeof recordingIdValue === "number" && Number.isFinite(recordingIdValue)
      ? String(recordingIdValue)
      : typeof recordingIdValue === "string" && recordingIdValue
        ? recordingIdValue
        : null;
  if (!recordingId) {
    throw invalid("meeting.recording_id is required", "invalid_recording_id");
  }
  const title =
    optionalString(root.meeting_title) ?? optionalString(root.title) ?? "Untitled meeting";
  const createdAt = readIsoString(root.created_at, "meeting.created_at");
  const startTime =
    optionalIsoString(root.recording_start_time) ??
    optionalIsoString(root.scheduled_start_time) ??
    createdAt;
  const endTime =
    optionalIsoString(root.recording_end_time) ?? optionalIsoString(root.scheduled_end_time);
  const url = optionalString(root.url);
  const shareUrl = optionalString(root.share_url);
  const summaryObject =
    root.default_summary && typeof root.default_summary === "object"
      ? readObject(root.default_summary, "meeting.default_summary")
      : null;
  const summaryMarkdown = summaryObject
    ? (optionalString(summaryObject.markdown_formatted) ?? "")
    : "";
  const actionItems = normalizeFathomActionItems(root.action_items);
  const participants = normalizeFathomParticipants(root.calendar_invitees, root.recorded_by);
  const transcript = normalizeFathomTranscript(root.transcript);
  const recordedByObject =
    root.recorded_by && typeof root.recorded_by === "object"
      ? readObject(root.recorded_by, "meeting.recorded_by")
      : null;
  const recordedByName = recordedByObject ? optionalString(recordedByObject.name) : undefined;
  const recordedByEmail = recordedByObject ? optionalString(recordedByObject.email) : undefined;
  const capturedAt = optionalIsoString(options.capturedAt) ?? createdAt;

  const contentHashInput = {
    sourceProvider: "fathom",
    sourceType: "meeting",
    externalId: recordingId,
    title,
    startTime,
    ...(endTime ? { endTime } : {}),
    summaryMarkdown,
    actionItems,
    participants,
    transcript,
  };

  return {
    sourceProvider: "fathom",
    sourceType: "meeting",
    externalId: recordingId,
    sourceRef: `fathom:recording:${recordingId}`,
    title,
    occurredAt: startTime,
    capturedAt,
    contentHash: sha256(stableJson(contentHashInput)),
    contentHashInput,
    content: {
      recordedBy: {
        ...(recordedByName ? { name: recordedByName } : {}),
        ...(recordedByEmail ? { email: recordedByEmail } : {}),
      },
      recording: {
        id: recordingId,
        ...(url ? { url } : {}),
        ...(shareUrl ? { shareUrl } : {}),
        createdAt,
      },
      meeting: {
        title,
        startTime,
        ...(endTime ? { endTime } : {}),
        summaryMarkdown,
        actionItems,
        participants,
        transcript,
      },
    },
  };
}

export function isNormalizedFathomMeetingSourceItem(
  value: unknown,
): value is NormalizedFathomMeetingSourceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NormalizedFathomMeetingSourceItem>;
  return (
    item.sourceProvider === "fathom" &&
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

function normalizeFathomParticipants(
  invitees: unknown,
  recordedBy: unknown,
): NormalizedFathomMeetingParticipant[] {
  const participants: NormalizedFathomMeetingParticipant[] = [];
  const seen = new Set<string>();
  const push = (name: string | undefined, email: string | undefined) => {
    if (!name && !email) return;
    const key = (email ?? name ?? "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    participants.push({ ...(name ? { name } : {}), ...(email ? { email } : {}) });
  };
  if (Array.isArray(invitees)) {
    for (const invitee of invitees) {
      if (!invitee || typeof invitee !== "object" || Array.isArray(invitee)) continue;
      const record = invitee as Record<string, unknown>;
      push(optionalString(record.name), optionalString(record.email));
    }
  }
  // Fall back to the recorder when Fathom reports no calendar invitees (e.g.
  // an ad-hoc recording without a calendar event).
  if (participants.length === 0 && recordedBy && typeof recordedBy === "object") {
    const record = recordedBy as Record<string, unknown>;
    push(optionalString(record.name), optionalString(record.email));
  }
  return participants;
}

function normalizeFathomTranscript(value: unknown): NormalizedFathomMeetingTranscriptSegment[] {
  // Transcript is optional on the meeting payload (only present with
  // include_transcript); an empty transcript degrades to summary-only ingest.
  if (!Array.isArray(value)) return [];
  return value.flatMap((segment) => {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) return [];
    const record = segment as Record<string, unknown>;
    const text = optionalString(record.text);
    if (!text) return [];
    const speakerRecord =
      record.speaker && typeof record.speaker === "object" && !Array.isArray(record.speaker)
        ? (record.speaker as Record<string, unknown>)
        : null;
    const speaker = speakerRecord
      ? optionalString(speakerRecord.display_name)
      : speakerName(record.speaker);
    const startedAt = optionalString(record.timestamp);
    return [
      {
        text,
        ...(speaker ? { speaker } : {}),
        ...(startedAt ? { startedAt } : {}),
      },
    ];
  });
}

function normalizeFathomActionItems(value: unknown): NormalizedFathomMeetingActionItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const description = optionalString(record.description);
    if (!description) return [];
    const assigneeRecord =
      record.assignee && typeof record.assignee === "object" && !Array.isArray(record.assignee)
        ? (record.assignee as Record<string, unknown>)
        : null;
    const assignee = assigneeRecord
      ? (optionalString(assigneeRecord.name) ?? optionalString(assigneeRecord.email))
      : optionalString(record.assignee);
    return [
      {
        description,
        ...(assignee ? { assignee } : {}),
        ...(typeof record.completed === "boolean" ? { completed: record.completed } : {}),
      },
    ];
  });
}

function normalizeGranolaParticipants(
  attendees: unknown,
  calendarEvent: Record<string, unknown> | null,
): NormalizedGranolaMeetingParticipant[] {
  const participants: NormalizedGranolaMeetingParticipant[] = [];
  const seen = new Set<string>();
  const push = (name: string | undefined, email: string | undefined) => {
    if (!name && !email) return;
    const key = (email ?? name ?? "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    participants.push({ ...(name ? { name } : {}), ...(email ? { email } : {}) });
  };
  if (Array.isArray(attendees)) {
    for (const attendee of attendees) {
      if (!attendee || typeof attendee !== "object" || Array.isArray(attendee)) continue;
      const record = attendee as Record<string, unknown>;
      push(optionalString(record.name), optionalString(record.email));
    }
  }
  // Fall back to the calendar invite list when Granola reports no attendees.
  if (participants.length === 0 && calendarEvent) {
    if (Array.isArray(calendarEvent.invitees)) {
      for (const invitee of calendarEvent.invitees) {
        if (!invitee || typeof invitee !== "object" || Array.isArray(invitee)) continue;
        push(undefined, optionalString((invitee as Record<string, unknown>).email));
      }
    }
    push(undefined, optionalString(calendarEvent.organiser));
  }
  return participants;
}

function normalizeGranolaTranscript(value: unknown): NormalizedGranolaMeetingTranscriptSegment[] {
  // Transcript is optional on the note payload (it is only present with
  // include=transcript); an empty transcript degrades to summary-only ingest.
  if (!Array.isArray(value)) return [];
  return value.flatMap((segment) => {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) return [];
    const record = segment as Record<string, unknown>;
    const text = optionalString(record.text);
    if (!text) return [];
    const speakerRecord =
      record.speaker && typeof record.speaker === "object" && !Array.isArray(record.speaker)
        ? (record.speaker as Record<string, unknown>)
        : null;
    const speaker = speakerRecord
      ? (optionalString(speakerRecord.name) ??
        optionalString(speakerRecord.diarization_label) ??
        optionalString(speakerRecord.source))
      : speakerName(record.speaker);
    const startedAt = optionalTimestampString(record.start_time);
    const endedAt = optionalTimestampString(record.end_time);
    return [
      {
        text,
        ...(speaker ? { speaker } : {}),
        ...(startedAt ? { startedAt } : {}),
        ...(endedAt ? { endedAt } : {}),
      },
    ];
  });
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
