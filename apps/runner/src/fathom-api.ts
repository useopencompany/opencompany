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

// Lists meetings with their transcript, summary, and action items inline —
// Fathom has no cheap per-meeting detail endpoint for API keys, so the list
// call is the payload fetch. Filters must stay identical across pages of one
// pass; the continuation cursor is only valid for the filters it was minted
// with.
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
