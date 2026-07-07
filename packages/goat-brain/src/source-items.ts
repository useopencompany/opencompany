import { createHash } from "node:crypto";

export type BrainSourceProvider = "jamie";
export type BrainSourceType = "meeting";

export type NormalizedBrainSourceItem<TContent = unknown> = {
  provider: BrainSourceProvider;
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
    provider: "jamie";
    sourceType: "meeting";
  };

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
    provider: "jamie",
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
    provider: "jamie",
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
    item.provider === "jamie" &&
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
