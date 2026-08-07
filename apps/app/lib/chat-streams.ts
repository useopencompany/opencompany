import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { createClient } from "redis";
import { createResumableStreamContext, type ResumableStreamContext } from "resumable-stream";

// Redis-backed coordination for resumable chat streams. Everything in here is
// best-effort: chat generation and persistence must keep working when Redis is
// down, so callers treat failures as "resume unavailable", never as turn
// failures. Postgres stays the system of record for messages.

const ACTIVE_STREAM_TTL_SECONDS = 30 * 60;
const STOP_SIGNAL_TTL_SECONDS = 10 * 60;
const STOP_POLL_INTERVAL_MS = 1_000;
// Slightly above the chat route's maxDuration so a watcher can never outlive
// its turn by much when cleanup is missed.
const STOP_WATCH_MAX_MS = 250_000;

export function isGoatChatResumeEnabled() {
  return Boolean(redisUrl());
}

export function newGoatChatStreamId() {
  return `goat_chat_stream_${randomUUID()}`;
}

let streamContext: ResumableStreamContext | null = null;

export function getGoatChatStreamContext() {
  streamContext ??= createResumableStreamContext({
    waitUntil: after,
    keyPrefix: "goat:chat:resumable",
  });
  return streamContext;
}

export async function setActiveGoatChatStream(sessionId: string, streamId: string) {
  const redis = await getRedis();
  await redis.set(activeStreamKey(sessionId), streamId, { EX: ACTIVE_STREAM_TTL_SECONDS });
}

export async function getActiveGoatChatStream(sessionId: string) {
  try {
    const redis = await getRedis();
    return await redis.get(activeStreamKey(sessionId));
  } catch (error) {
    warnOnce("goat.chat_stream_active_lookup_failed", error);
    return null;
  }
}

/** Clears the active-stream pointer unless a newer stream already replaced it. */
export async function clearActiveGoatChatStream(sessionId: string, streamId: string) {
  try {
    const redis = await getRedis();
    const active = await redis.get(activeStreamKey(sessionId));
    if (active === streamId) await redis.del(activeStreamKey(sessionId));
  } catch (error) {
    warnOnce("goat.chat_stream_clear_failed", error);
  }
}

/**
 * Records an explicit stop request for the session's active stream. Returns
 * false when there is nothing to stop (no active stream or Redis unavailable).
 */
export async function requestGoatChatStop(sessionId: string) {
  try {
    const redis = await getRedis();
    const streamId = await redis.get(activeStreamKey(sessionId));
    if (!streamId) return false;
    await redis.set(stopSignalKey(streamId), "1", { EX: STOP_SIGNAL_TTL_SECONDS });
    await redis.del(activeStreamKey(sessionId));
    return true;
  } catch (error) {
    warnOnce("goat.chat_stream_stop_request_failed", error);
    return false;
  }
}

/**
 * Polls for a stop request against the given stream and invokes `onStop` once
 * when it appears. Returns a cleanup function.
 */
export function watchGoatChatStop(streamId: string, onStop: () => void) {
  const startedAt = Date.now();
  let stopped = false;
  const interval = setInterval(() => {
    if (Date.now() - startedAt > STOP_WATCH_MAX_MS) {
      cleanup();
      return;
    }
    void getRedis()
      .then((redis) => redis.get(stopSignalKey(streamId)))
      .then((value) => {
        if (!value || stopped) return;
        cleanup();
        onStop();
      })
      .catch((error) => warnOnce("goat.chat_stream_stop_poll_failed", error));
  }, STOP_POLL_INTERVAL_MS);
  const cleanup = () => {
    stopped = true;
    clearInterval(interval);
  };
  return cleanup;
}

function activeStreamKey(sessionId: string) {
  return `goat:chat:active-stream:${sessionId}`;
}

function stopSignalKey(streamId: string) {
  return `goat:chat:stop:${streamId}`;
}

function redisUrl() {
  return process.env.REDIS_URL?.trim() || process.env.KV_URL?.trim() || null;
}

// Minimal view of the redis client so the generic client type (which fights
// exactOptionalPropertyTypes) stays out of our signatures.
type GoatRedisClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

let redisClientPromise: Promise<GoatRedisClient> | null = null;

function getRedis(): Promise<GoatRedisClient> {
  redisClientPromise ??= (async () => {
    const url = redisUrl();
    if (!url) throw new Error("Goat chat resume requires REDIS_URL (or KV_URL).");
    const client = createClient({ url });
    client.on("error", (error) => warnOnce("goat.chat_stream_redis_error", error));
    await client.connect();
    return client as unknown as GoatRedisClient;
  })().catch((error) => {
    // Allow the next caller to retry the connection instead of caching failure.
    redisClientPromise = null;
    throw error;
  });
  return redisClientPromise;
}

const warnedEvents = new Set<string>();

function warnOnce(event: string, error: unknown) {
  if (warnedEvents.has(event)) return;
  warnedEvents.add(event);
  console.warn("Goat chat stream coordination degraded.", { event, error });
}
