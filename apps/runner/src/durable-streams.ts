import { randomUUID } from "node:crypto";
import { DurableStream, DurableStreamError, IdempotentProducer } from "@durable-streams/client";
import { createLogger } from "@opencompany/observability";
import type { RuntimeEventForStream } from "./events";

/**
 * Durable Streams publisher (Phase 3, plane B — see INSTANT_REFACTOR.md). Appends
 * every session runtime event (durable rows AND transient token deltas) to a
 * per-session Durable Stream so the web client can consume a resumable, offset
 * addressable transcript instead of the in-process-broker SSE.
 *
 * This is ADDITIVE and flag-gated: it does nothing unless `DURABLE_STREAMS_URL`
 * is set, so the existing SSE path keeps working until we cut over. Publishing is
 * fire-and-forget and best-effort — a streaming failure must never break the run
 * (Postgres remains the system of record; the runner still persists durable rows).
 *
 * Why this module reads `process.env` directly rather than RunnerEnv: events are
 * published from `events.ts`, a standalone module that already reaches for global
 * process state (`getDb()`); threading typed env through every `publishRuntimeEvent`
 * call site would be invasive for an optional, flag-gated transport.
 */

const logger = createLogger({ service: "opencompany-runner", runtime: "durable-streams" });

// Created with this content type so the server frames each append as one JSON
// message; the consumer then reads framed items via the JSON read API.
const JSON_CONTENT_TYPE = "application/json";

type DurableStreamsConfig = { baseUrl: string; token: string | undefined };

function readConfig(): DurableStreamsConfig | null {
  const baseUrl = process.env.DURABLE_STREAMS_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) return null;
  return { baseUrl, token: process.env.DURABLE_STREAMS_TOKEN?.trim() || undefined };
}

export function isDurableStreamsEnabled(): boolean {
  return readConfig() !== null;
}

/** Stream name for a session. Mirrored by the web read proxy. */
export function sessionStreamName(sessionId: string): string {
  return `session-${sessionId}`;
}

function streamUrl(baseUrl: string, sessionId: string): string {
  return `${baseUrl}/${sessionStreamName(sessionId)}`;
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// One idempotent producer per session, created lazily on first publish. The
// producer batches appends (lingerMs ~5ms), preserves order, and gives
// exactly-once delivery via producerId + epoch — so high-frequency token deltas
// don't pay a network round-trip each.
const producers = new Map<string, Promise<IdempotentProducer>>();

async function ensureStream(
  url: string,
  headers: Record<string, string>,
): Promise<DurableStream> {
  try {
    return await DurableStream.create({ url, headers, contentType: JSON_CONTENT_TYPE });
  } catch (error) {
    // The stream already exists (e.g. a resumed session or a second runner
    // instance) — attach a cold handle (no network IO) and keep appending.
    if (error instanceof DurableStreamError && error.code === "CONFLICT_EXISTS") {
      return new DurableStream({ url, headers, contentType: JSON_CONTENT_TYPE });
    }
    throw error;
  }
}

async function ensureProducer(sessionId: string): Promise<IdempotentProducer | null> {
  const config = readConfig();
  if (!config) return null;

  let pending = producers.get(sessionId);
  if (!pending) {
    const headers = authHeaders(config.token);
    pending = ensureStream(streamUrl(config.baseUrl, sessionId), headers)
      .then(
        (handle) =>
          // A UNIQUE producer id per instance. Producers are detached + evicted when a
          // turn ends (`detachSessionStream`), so a session's later turn (or a resume)
          // re-creates one. Reusing a stable id would restart the producer at epoch 0,
          // seq 0 — colliding with the prior instance's already-committed (id, epoch,
          // seq) and getting silently deduped (event lost). A fresh id per instance
          // gives each turn its own idempotency scope; the run lease already guarantees a
          // single writer per session, so cross-instance fencing isn't needed.
          new IdempotentProducer(handle, `runner-${sessionId}-${randomUUID()}`, {
            headers,
            onError: (error) =>
              logger.warn("Durable stream producer error", {
                event: "opencompany.durable_stream_producer_error",
                session_id: sessionId,
                error: error instanceof Error ? error.message : String(error),
              }),
          }),
      )
      .catch((error) => {
        // Drop the cached rejection so the next event retries the connection.
        producers.delete(sessionId);
        throw error;
      });
    producers.set(sessionId, pending);
  }
  return pending;
}

/**
 * Append a runtime event to its session's Durable Stream. No-op when streaming is
 * unconfigured. Fire-and-forget: failures are logged, never thrown — the run and
 * the durable Postgres write are unaffected.
 */
export function publishToDurableStream(sessionId: string, event: RuntimeEventForStream): void {
  if (!isDurableStreamsEnabled()) return;
  void (async () => {
    try {
      const producer = await ensureProducer(sessionId);
      producer?.append(JSON.stringify(event));
    } catch (error) {
      logger.warn("Durable stream publish failed", {
        event: "opencompany.durable_stream_publish_failed",
        session_id: sessionId,
        runtime_event_type: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}

/** Flush pending appends for a session (await delivery). Best-effort. */
export async function flushSessionStream(sessionId: string): Promise<void> {
  const pending = producers.get(sessionId);
  if (!pending) return;
  try {
    const producer = await pending;
    await producer.flush();
  } catch (error) {
    logger.warn("Durable stream flush failed", {
      event: "opencompany.durable_stream_flush_failed",
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Flush every cached producer. Used by the graceful-shutdown drain so an in-flight
 * batch isn't lost on deploy/SIGTERM. Best-effort. */
export async function flushAllSessionStreams(): Promise<void> {
  const sessionIds = [...producers.keys()];
  await Promise.allSettled(sessionIds.map((sessionId) => flushSessionStream(sessionId)));
}

/**
 * End this instance's producer for a session without closing the stream: flush any
 * pending appends, stop the producer, and evict it from the cache. Called when a run
 * finishes (any terminal/pause status) so the producer map doesn't grow unbounded in
 * the long-lived runner. A later turn (or a resume) transparently re-creates the
 * producer — `autoClaim` claims a fresh epoch, so the stream stays writable. No-op
 * when no producer is cached. Best-effort.
 *
 * Evicts BEFORE detaching so a publish racing in re-creates a fresh producer rather
 * than appending to the one we're tearing down (detach makes `append` throw).
 */
export async function detachSessionStream(sessionId: string): Promise<void> {
  const pending = producers.get(sessionId);
  if (!pending) return;
  producers.delete(sessionId);
  try {
    const producer = await pending;
    await producer.detach();
  } catch (error) {
    logger.warn("Durable stream detach failed", {
      event: "opencompany.durable_stream_detach_failed",
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Close a session's stream (EOF) — call ONLY when the session is permanently done
 * (archived/deleted), never on turn completion: a closed stream is monotonic and
 * rejects all future appends, but a completed session can still receive a new user
 * message → a new turn. If this instance still holds a producer, close through it
 * (flush + EOF, idempotent) and evict; otherwise the turn already ended and the
 * producer was detached, so close via a cold handle. Treats "never created"
 * (NOT_FOUND) and "already closed" (STREAM_CLOSED) as success. Best-effort.
 */
export async function closeSessionStream(sessionId: string): Promise<void> {
  const config = readConfig();
  if (!config) return;

  const pending = producers.get(sessionId);
  producers.delete(sessionId);
  try {
    if (pending) {
      const producer = await pending;
      await producer.close();
      return;
    }
    const headers = authHeaders(config.token);
    const url = streamUrl(config.baseUrl, sessionId);
    await new DurableStream({ url, headers, contentType: JSON_CONTENT_TYPE }).close();
  } catch (error) {
    if (
      error instanceof DurableStreamError &&
      (error.code === "NOT_FOUND" || error.code === "STREAM_CLOSED")
    ) {
      return;
    }
    logger.warn("Durable stream close failed", {
      event: "opencompany.durable_stream_close_failed",
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Test-only: clear the producer cache between cases. */
export function __resetDurableStreamsForTests(): void {
  producers.clear();
}
