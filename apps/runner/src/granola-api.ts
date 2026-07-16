// Minimal client for the Granola public API (https://docs.granola.ai).
// Auth is a per-user API key; rate limits are 25-request bursts at a
// sustained 5 req/s, far above what the poll worker generates.

export const GRANOLA_API_BASE_URL = "https://public-api.granola.ai/v1";
export const GRANOLA_NOTES_PAGE_SIZE = 30;
export const GRANOLA_API_REQUEST_TIMEOUT_MS = 20_000;

export class GranolaApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GranolaApiError";
    this.status = status;
  }
}

export class GranolaApiTimeoutError extends Error {
  constructor(message = "Granola API request timed out.") {
    super(message);
    this.name = "GranolaApiTimeoutError";
  }
}

export function isGranolaAuthError(error: unknown): boolean {
  return error instanceof GranolaApiError && (error.status === 401 || error.status === 403);
}

export type GranolaNoteSummary = {
  id: string;
  title: string | null;
  updatedAt: string | null;
  raw: Record<string, unknown>;
};

export type GranolaNotesPage = {
  notes: GranolaNoteSummary[];
  hasMore: boolean;
  cursor: string | null;
};

export async function listGranolaNotes(input: {
  apiKey: string;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  cursor?: string;
  pageSize?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<GranolaNotesPage> {
  const params = new URLSearchParams();
  params.set("page_size", String(input.pageSize ?? GRANOLA_NOTES_PAGE_SIZE));
  if (input.createdAfter) params.set("created_after", input.createdAfter);
  if (input.createdBefore) params.set("created_before", input.createdBefore);
  if (input.updatedAfter) params.set("updated_after", input.updatedAfter);
  if (input.cursor) params.set("cursor", input.cursor);
  const body = await granolaApiCall<{
    notes?: unknown[];
    hasMore?: boolean;
    cursor?: string | null;
  }>({
    apiKey: input.apiKey,
    path: `/notes?${params.toString()}`,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  const notes = (Array.isArray(body.notes) ? body.notes : []).flatMap(
    (note): GranolaNoteSummary[] => {
      if (!note || typeof note !== "object" || Array.isArray(note)) return [];
      const record = note as Record<string, unknown>;
      if (typeof record.id !== "string" || !record.id) return [];
      return [
        {
          id: record.id,
          title: typeof record.title === "string" ? record.title : null,
          updatedAt: typeof record.updated_at === "string" ? record.updated_at : null,
          raw: record,
        },
      ];
    },
  );
  return {
    notes,
    hasMore: Boolean(body.hasMore),
    cursor: typeof body.cursor === "string" && body.cursor ? body.cursor : null,
  };
}

export async function fetchGranolaNote(input: {
  apiKey: string;
  noteId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  return granolaApiCall<Record<string, unknown>>({
    apiKey: input.apiKey,
    path: `/notes/${encodeURIComponent(input.noteId)}?include=transcript`,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
}

async function granolaApiCall<T>(input: {
  apiKey: string;
  path: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<T> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(),
    input.timeoutMs ?? GRANOLA_API_REQUEST_TIMEOUT_MS,
  );
  timeout.unref?.();
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    const response = await fetch(`${GRANOLA_API_BASE_URL}${input.path}`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal,
    });
    if (!response.ok) {
      throw new GranolaApiError(
        `Granola API request failed (${response.status}) for ${input.path.split("?")[0]}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  } catch (error) {
    if (!input.signal?.aborted && timeoutController.signal.aborted) {
      throw new GranolaApiTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
