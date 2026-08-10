import { hc } from "hono/client";
import { decodeEventCursor, parseRunEvent, type RunEventDto } from "./events";
import type { V1AppType } from "./routes";

export { formatEventCursor, parseEventCursor, parseRunEvent } from "./events";

export type OpenCompanyClientOptions = Parameters<typeof hc>[1];

export function createOpenCompanyClient(baseUrl: string, options?: OpenCompanyClientOptions) {
  return hc<V1AppType>(baseUrl, options);
}

export type OpenCompanyClient = ReturnType<typeof createOpenCompanyClient>;

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
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  onCursor?: (cursor: string) => void;
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
): AsyncGenerator<RunEventDto, void, void> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 8;
  let cursor = options.cursor;
  let reconnectAttempts = 0;

  while (!options.signal?.aborted) {
    const url = new URL(
      `/v1/runs/${encodeURIComponent(options.runId)}/events`,
      normalizedBaseUrl(options.baseUrl),
    );
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      credentials: "include",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw await protocolResponseError(response);
    if (!response.body) throw new Error("The Run event stream returned no response body.");
    const responseRunStatus = response.headers.get("X-OpenCompany-Run-Status");

    let receivedEvent = false;
    let lastEventEndedStream = false;
    for await (const data of sseDataFields(response.body, options.signal)) {
      const event = parseRunEvent(parseJson(data));
      if (event.runId !== options.runId) {
        throw new Error("The Run event stream returned an event for another Run.");
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

    if (options.signal?.aborted) return;
    if (lastEventEndedStream || isStreamEndRunStatus(responseRunStatus)) return;
    reconnectAttempts += 1;
    if (reconnectAttempts > maxReconnectAttempts) {
      throw new Error("The Run event stream disconnected repeatedly before the Run finished.");
    }
    await abortableDelay(receivedEvent ? 0 : (options.reconnectDelayMs ?? 250), options.signal);
  }
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

async function protocolResponseError(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : null;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(
    `${message ?? `The Run event stream failed with HTTP ${response.status}.`}${
      requestId ? ` (request ${requestId})` : ""
    }`,
  );
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
