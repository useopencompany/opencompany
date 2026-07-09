import { createHash } from "node:crypto";

export type BrainSourceProvider = "jamie" | "goat-chat" | "upload" | "slack";
export type BrainSourceType = "meeting" | "capture" | "asset" | "conversation";

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
    sourceRef: `goat-chat:${userMessageId}`,
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

  const conversation = {
    teamId,
    ...(teamDomain ? { teamDomain } : {}),
    channelId,
    channelName,
    channelType: input.channelType,
    windowStartTs,
    windowEndTs,
    messages,
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

// Slack ts values are epoch seconds with a fractional suffix ("1720000000.000200").
export function slackTsToIso(ts: string): string {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) {
    throw invalid(`slack ts must be numeric, got ${ts}`, "invalid_conversation");
  }
  return new Date(seconds * 1000).toISOString();
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

  const title = readString(event.title, "data.event.title");
  const startTime = readIsoString(event.startTime, "data.event.startTime");
  const endTime = optionalIsoString(event.endTime);
  const summaryMarkdown = normalizeSummary(event.summary);
  const transcript = normalizeTranscript(event.transcript);
  const participants = normalizeParticipants(event.participants);
  const actionItems = normalizeActionItems(event.actionItems ?? event.tasks);
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
      return [{ name: readNonEmpty(participant, `data.event.participants[${index}]`) }];
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
    const text = optionalString(object.text) ?? optionalString(object.title);
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
