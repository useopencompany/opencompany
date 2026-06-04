import { DurableStream, DurableStreamError } from "@durable-streams/client";
import { createLogger } from "@opencompany/observability";

/**
 * Web-side Durable Streams publisher (see docs/stack/electric-sync.md).
 *
 * Some durable session events are written by the WEB, not the runner: the user's
 * message (submitAgentSessionMessage → insertUserMessage) and the optimistic abort
 * status. Those bypass the runner's stream publisher, so when the transcript is
 * sourced from the Durable Stream they would never appear. This appends them to
 * the session's stream so the stream stays a complete, durable transcript.
 *
 * No-op unless DURABLE_STREAMS_URL is set and best-effort — a stream failure never
 * breaks the write (Postgres remains the system of record).
 */

const logger = createLogger({ service: "opencompany-web", runtime: "durable-streams" });
const JSON_CONTENT_TYPE = "application/json";

export type SessionStreamEvent = {
  id: number | null;
  type: string;
  messageId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  transient?: boolean;
};

function readConfig(): { baseUrl: string; token: string | undefined } | null {
  const baseUrl = process.env.DURABLE_STREAMS_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) return null;
  return { baseUrl, token: process.env.DURABLE_STREAMS_TOKEN?.trim() || undefined };
}

async function ensureCreated(url: string, headers: Record<string, string>): Promise<void> {
  try {
    await DurableStream.create({ url, headers, contentType: JSON_CONTENT_TYPE });
  } catch (error) {
    // Already exists (the runner or a prior write created it) — fine.
    if (!(error instanceof DurableStreamError && error.code === "CONFLICT_EXISTS")) throw error;
  }
}

/**
 * Append one event to a session's Durable Stream. Lazily creates the stream if
 * this is the first write (e.g. the first user message of a brand-new session,
 * before the runner has created it). No-op when streaming is unconfigured.
 */
export async function appendSessionStreamEvent(
  sessionId: string,
  event: SessionStreamEvent,
): Promise<void> {
  const config = readConfig();
  if (!config) return;

  const url = `${config.baseUrl}/session-${sessionId}`;
  const headers = config.token ? { Authorization: `Bearer ${config.token}` } : {};
  const body = JSON.stringify(event);

  try {
    const handle = new DurableStream({ url, headers, contentType: JSON_CONTENT_TYPE });
    try {
      await handle.append(body);
    } catch (error) {
      if (error instanceof DurableStreamError && error.code === "NOT_FOUND") {
        await ensureCreated(url, headers);
        await handle.append(body);
      } else {
        throw error;
      }
    }
  } catch (error) {
    logger.warn("Durable stream append failed", {
      event: "opencompany.durable_stream_web_append_failed",
      session_id: sessionId,
      runtime_event_type: event.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Close a session's Durable Stream (EOF). Call ONLY when the session is permanently
 * archived/deleted (the web's no-sandbox archive path) — a closed stream is monotonic
 * and rejects all future appends, so closing a session that could still receive a
 * message would break its next turn. Idempotent and best-effort: "already closed"
 * (STREAM_CLOSED) and "never created" (NOT_FOUND) are success; any other failure is
 * logged, never thrown (Postgres remains the system of record). No-op when streaming
 * is unconfigured.
 */
export async function closeSessionStream(sessionId: string): Promise<void> {
  const config = readConfig();
  if (!config) return;

  const url = `${config.baseUrl}/session-${sessionId}`;
  const headers = config.token ? { Authorization: `Bearer ${config.token}` } : {};

  try {
    await new DurableStream({ url, headers, contentType: JSON_CONTENT_TYPE }).close();
  } catch (error) {
    if (
      error instanceof DurableStreamError &&
      (error.code === "STREAM_CLOSED" || error.code === "NOT_FOUND")
    ) {
      return;
    }
    logger.warn("Durable stream close failed", {
      event: "opencompany.durable_stream_web_close_failed",
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
