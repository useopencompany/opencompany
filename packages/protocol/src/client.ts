import { hc } from "hono/client";
import {
  decodeEventCursor,
  parseRunStreamEvent,
  type RunEventDto,
  type RunStreamEventDto,
} from "./events";
import type { V1AppType } from "./routes";

export {
  formatEventCursor,
  parseEventCursor,
  parseRunEvent,
  parseRunStreamEvent,
} from "./events";

export type ApiClientOptions = Parameters<typeof hc>[1];

export function createApiClient(baseUrl: string, options?: ApiClientOptions) {
  return hc<V1AppType>(baseUrl, options);
}

export type ApiClient = ReturnType<typeof createApiClient>;

const STREAM_END_EVENT_TYPES = new Set<RunEventDto["type"]>([
  "run.paused",
  "run.completed",
  "run.failed",
  "run.canceled",
]);

export type RunEventStreamOptions = {
  baseUrl: string;
  runId: string;
  cursor?: string;
  presentationCursor?: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  onCursor?: (cursor: string) => void;
  onPresentationCursor?: (cursor: string) => void;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
};

/**
 * Reads the canonical semantic SSE stream and reconnects from its last durable cursor when a
 * connection ends before a terminal Run event. This helper is browser/runtime neutral so web and
 * mobile clients use the exact same validation and replay behavior.
 */
export async function* streamRunEvents(
  options: RunEventStreamOptions,
): AsyncGenerator<RunStreamEventDto, void, void> {
  const fetchImpl = bindFetchToRuntime(options.fetch);
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 8;
  let cursor = options.cursor;
  let presentationCursor = options.presentationCursor;
  let reconnectAttempts = 0;

  while (!options.signal?.aborted) {
    const url = new URL(
      `/v1/runs/${encodeURIComponent(options.runId)}/events`,
      normalizedBaseUrl(options.baseUrl),
    );
    if (cursor) url.searchParams.set("cursor", cursor);
    if (presentationCursor) url.searchParams.set("presentationCursor", presentationCursor);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        credentials: "include",
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) return;
      if (!(error instanceof TypeError)) throw error;
      reconnectAttempts = await waitForRunEventReconnect({
        reconnectAttempts,
        maxReconnectAttempts,
        reconnectDelayMs: options.reconnectDelayMs,
        signal: options.signal,
        cause: error,
      });
      continue;
    }
    if (!response.ok) {
      const error = await protocolResponseError(response);
      if (!error.retryable) throw error;
      reconnectAttempts = await waitForRunEventReconnect({
        reconnectAttempts,
        maxReconnectAttempts,
        reconnectDelayMs: options.reconnectDelayMs,
        signal: options.signal,
        cause: error,
      });
      continue;
    }
    if (!response.body) {
      reconnectAttempts = await waitForRunEventReconnect({
        reconnectAttempts,
        maxReconnectAttempts,
        reconnectDelayMs: options.reconnectDelayMs,
        signal: options.signal,
        cause: new Error("The Run event stream returned no response body."),
      });
      continue;
    }
    const responseRunStatus = response.headers.get("X-OpenCompany-Run-Status");

    let receivedEvent = false;
    let lastEventEndedStream = false;
    try {
      for await (const data of sseDataFields(response.body, options.signal)) {
        const event: RunStreamEventDto = parseRunStreamEvent(parseJson(data));
        if (event.runId !== options.runId) {
          throw new Error("The Run event stream returned an event for another Run.");
        }
        if (event.type === "message.presentation_delta") {
          presentationCursor = event.presentationCursor;
          receivedEvent = true;
          reconnectAttempts = 0;
          options.onPresentationCursor?.(event.presentationCursor);
          yield event;
          continue;
        }
        if (cursor && decodeEventCursor(event.cursor) <= decodeEventCursor(cursor)) continue;
        const eventCursor = event.cursor;
        cursor = eventCursor;
        receivedEvent = true;
        reconnectAttempts = 0;
        options.onCursor?.(eventCursor);
        yield event;
        // A replay can contain a historical pause followed by approval.resolved and the continued
        // Attempt. Only the final event in this response describes why the server closed it.
        lastEventEndedStream = STREAM_END_EVENT_TYPES.has(event.type);
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      if (!(error instanceof RunEventStreamReadError)) throw error;
      reconnectAttempts = await waitForRunEventReconnect({
        reconnectAttempts,
        maxReconnectAttempts,
        reconnectDelayMs: receivedEvent ? 0 : options.reconnectDelayMs,
        signal: options.signal,
        cause: error.cause,
      });
      continue;
    }

    if (options.signal?.aborted) return;
    if (lastEventEndedStream || isStreamEndRunStatus(responseRunStatus)) return;
    reconnectAttempts = await waitForRunEventReconnect({
      reconnectAttempts,
      maxReconnectAttempts,
      reconnectDelayMs: receivedEvent ? 0 : options.reconnectDelayMs,
      signal: options.signal,
    });
  }
}

function bindFetchToRuntime(fetchImpl = globalThis.fetch) {
  return fetchImpl.bind(globalThis);
}

function isStreamEndRunStatus(value: string | null) {
  return value === "paused" || value === "completed" || value === "failed" || value === "canceled";
}

export async function* sseDataFields(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/u);
      buffer = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (line === "") {
          if (dataLines.length > 0) yield dataLines.join("\n");
          dataLines = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line === "data") dataLines.push("");
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /u, ""));
      }
      if (done) {
        if (buffer) {
          const line = buffer;
          if (line === "data") dataLines.push("");
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /u, ""));
        }
        if (dataLines.length > 0) yield dataLines.join("\n");
        return;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new RunEventStreamReadError(error);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function normalizedBaseUrl(baseUrl: string) {
  const normalized = baseUrl.trim() || "/";
  if (/^https?:\/\//iu.test(normalized))
    return normalized.endsWith("/") ? normalized : `${normalized}/`;
  if (typeof globalThis.location === "undefined") {
    throw new Error("A fully qualified API base URL is required outside a browser.");
  }
  return new URL(normalized, globalThis.location.origin).toString();
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("The Run event stream returned malformed JSON.");
  }
}

class RunEventStreamReadError extends Error {
  constructor(cause: unknown) {
    super("The Run event stream could not be read.", { cause });
    this.name = "RunEventStreamReadError";
  }
}

class RunEventStreamHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RunEventStreamHttpError";
  }
}

async function protocolResponseError(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown; retryable?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : null;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  const retryable =
    typeof body?.error?.retryable === "boolean"
      ? body.error.retryable
      : response.status === 408 || response.status === 429 || response.status >= 500;
  return new RunEventStreamHttpError(
    `${message ?? `The Run event stream failed with HTTP ${response.status}.`}${
      requestId ? ` (request ${requestId})` : ""
    }`,
    response.status,
    retryable,
  );
}

async function waitForRunEventReconnect(input: {
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  reconnectDelayMs: number | undefined;
  signal: AbortSignal | undefined;
  cause?: unknown;
}) {
  const reconnectAttempts = input.reconnectAttempts + 1;
  if (reconnectAttempts > input.maxReconnectAttempts) {
    throw new Error("The Run event stream disconnected repeatedly before the Run finished.", {
      cause: input.cause,
    });
  }
  await abortableDelay(input.reconnectDelayMs ?? 250, input.signal);
  return reconnectAttempts;
}

async function abortableDelay(delayMs: number, signal?: AbortSignal) {
  if (delayMs <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    signal?.addEventListener("abort", done, { once: true });
  });
}
