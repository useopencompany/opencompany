// Minimal client for the Fathom public API (https://developers.fathom.ai).
// Auth is a per-user API key sent as X-Api-Key; users get 60 requests per
// minute across all of their keys, far above what the poll worker generates.

export const FATHOM_API_BASE_URL = "https://api.fathom.ai/external/v1";
export const FATHOM_API_REQUEST_TIMEOUT_MS = 30_000;

export class FathomApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "FathomApiError";
    this.status = status;
  }
}

export class FathomApiTimeoutError extends Error {
  constructor(message = "Fathom API request timed out.") {
    super(message);
    this.name = "FathomApiTimeoutError";
  }
}

export function isFathomAuthError(error: unknown): boolean {
  return error instanceof FathomApiError && (error.status === 401 || error.status === 403);
}

export type FathomMeetingSummary = {
  recordingId: string;
  title: string | null;
  createdAt: string | null;
  raw: Record<string, unknown>;
};

export type FathomMeetingsPage = {
  meetings: FathomMeetingSummary[];
  nextCursor: string | null;
};

export type FathomRecordingContent = {
  summary: Record<string, unknown> | null;
  transcript: unknown[] | null;
};

// Lists meetings with their transcript, summary, and action items inline.
// Filters must stay identical across pages of one pass; the continuation
// cursor is only valid for the filters it was minted with. The recording
// endpoints below are reserved for retrying the small set whose generated
// content is not ready on the list response.
export async function listFathomMeetings(input: {
  apiKey: string;
  createdAfter?: string;
  createdBefore?: string;
  cursor?: string;
  includeContent?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<FathomMeetingsPage> {
  const params = new URLSearchParams();
  if (input.createdAfter) params.set("created_after", input.createdAfter);
  if (input.createdBefore) params.set("created_before", input.createdBefore);
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.includeContent !== false) {
    params.set("include_transcript", "true");
    params.set("include_summary", "true");
    params.set("include_action_items", "true");
  }
  const query = params.toString();
  const body = await fathomApiCall<{
    items?: unknown[];
    next_cursor?: string | null;
  }>({
    apiKey: input.apiKey,
    path: `/meetings${query ? `?${query}` : ""}`,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  const meetings = (Array.isArray(body.items) ? body.items : []).flatMap(
    (meeting): FathomMeetingSummary[] => {
      if (!meeting || typeof meeting !== "object" || Array.isArray(meeting)) return [];
      const record = meeting as Record<string, unknown>;
      const recordingId =
        typeof record.recording_id === "number" && Number.isFinite(record.recording_id)
          ? String(record.recording_id)
          : typeof record.recording_id === "string" && record.recording_id
            ? record.recording_id
            : null;
      if (!recordingId) return [];
      return [
        {
          recordingId,
          title:
            typeof record.meeting_title === "string"
              ? record.meeting_title
              : typeof record.title === "string"
                ? record.title
                : null,
          createdAt: typeof record.created_at === "string" ? record.created_at : null,
          raw: record,
        },
      ];
    },
  );
  return {
    meetings,
    nextCursor: typeof body.next_cursor === "string" && body.next_cursor ? body.next_cursor : null,
  };
}

export async function getFathomRecordingSummary(input: {
  apiKey: string;
  recordingId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<Record<string, unknown> | null> {
  const body = await fathomApiCall<{ summary?: unknown }>({
    apiKey: input.apiKey,
    path: `/recordings/${encodeURIComponent(input.recordingId)}/summary`,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  return asRecord(body.summary);
}

export async function getFathomRecordingTranscript(input: {
  apiKey: string;
  recordingId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<unknown[] | null> {
  const body = await fathomApiCall<{ transcript?: unknown }>({
    apiKey: input.apiKey,
    path: `/recordings/${encodeURIComponent(input.recordingId)}/transcript`,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  return Array.isArray(body.transcript) ? body.transcript : null;
}

export async function getFathomRecordingContent(input: {
  apiKey: string;
  recordingId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<FathomRecordingContent> {
  const request = {
    apiKey: input.apiKey,
    recordingId: input.recordingId,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };
  const [summaryResult, transcriptResult] = await Promise.allSettled([
    getFathomRecordingSummary(request),
    getFathomRecordingTranscript(request),
  ]);
  return {
    summary: settledFathomContent(summaryResult),
    transcript: settledFathomContent(transcriptResult),
  };
}

export function mergeFathomRecordingContent(
  rawPayload: Record<string, unknown>,
  content: FathomRecordingContent,
): Record<string, unknown> {
  const existingTranscript = Array.isArray(rawPayload.transcript) ? rawPayload.transcript : null;
  const shouldMergeTranscript =
    content.transcript !== null &&
    (hasUsableFathomTranscript(content.transcript) ||
      !hasUsableFathomTranscript(existingTranscript));
  return {
    ...rawPayload,
    ...(hasUsableFathomSummary(content.summary) ? { default_summary: content.summary } : {}),
    ...(shouldMergeTranscript ? { transcript: content.transcript } : {}),
  };
}

export function hasFathomMeetingContent(payload: Record<string, unknown>): boolean {
  return (
    hasUsableFathomSummary(asRecord(payload.default_summary)) && Array.isArray(payload.transcript)
  );
}

async function fathomApiCall<T>(input: {
  apiKey: string;
  path: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<T> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(),
    input.timeoutMs ?? FATHOM_API_REQUEST_TIMEOUT_MS,
  );
  timeout.unref?.();
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    const response = await fetch(`${FATHOM_API_BASE_URL}${input.path}`, {
      headers: { "X-Api-Key": input.apiKey },
      signal,
    });
    if (!response.ok) {
      throw new FathomApiError(
        `Fathom API request failed (${response.status}) for ${input.path.split("?")[0]}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  } catch (error) {
    if (!input.signal?.aborted && timeoutController.signal.aborted) {
      throw new FathomApiTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasUsableFathomSummary(summary: Record<string, unknown> | null): boolean {
  return (
    typeof summary?.markdown_formatted === "string" && summary.markdown_formatted.trim().length > 0
  );
}

function hasUsableFathomTranscript(transcript: unknown[] | null): boolean {
  return Boolean(
    transcript?.some((entry) => {
      const record = asRecord(entry);
      return typeof record?.text === "string" && record.text.trim().length > 0;
    }),
  );
}

function settledFathomContent<T>(result: PromiseSettledResult<T>): T | null {
  if (result.status === "fulfilled") return result.value;
  if (
    result.reason instanceof FathomApiError &&
    [400, 404, 409, 425].includes(result.reason.status)
  ) {
    return null;
  }
  throw result.reason;
}
