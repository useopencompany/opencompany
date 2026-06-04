import { DurableStream, DurableStreamError } from "@durable-streams/client";
import { agentSessions, getDb } from "@opencompany/db";
import { createLogger } from "@opencompany/observability";
import { and, eq } from "drizzle-orm";
import { currentWorkspace } from "@/lib/auth";

const logger = createLogger({ service: "opencompany-web", runtime: "durable-streams-proxy" });
const JSON_CONTENT_TYPE = "application/json";

/**
 * Same-origin read proxy in front of the Durable Streams service (Phase 3, plane
 * B — see INSTANT_REFACTOR.md). The browser's `@durable-streams/client` reads a
 * session's transcript from THIS route, never from the Durable Streams service
 * directly: we authenticate the caller, verify they own the session, and forward
 * to the trusted `session-<id>` stream with the server-side write/read token. The
 * session is taken from the validated path — clients cannot widen their scope.
 *
 * Mirrors the Electric shape proxy (app/api/electric/v1/shape/route.ts).
 */

function durableStreamsConfig(): { baseUrl: string; token: string | undefined } | null {
  const baseUrl = process.env.DURABLE_STREAMS_URL?.replace(/\/+$/, "");
  if (!baseUrl) return null;
  return { baseUrl, token: process.env.DURABLE_STREAMS_TOKEN?.trim() || undefined };
}

/**
 * Idempotently create a session's Durable Stream. A stream is created lazily on
 * the first append (runner or web), so a reader that connects before any event
 * has been published gets a 404. Creating it here lets the read attach to a live
 * (possibly empty) stream and tail — subsequent appends then flow through.
 * Treats "already exists" as success (the producer raced us, which is fine).
 */
async function ensureStreamExists(baseStreamUrl: string, token: string | undefined): Promise<void> {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  try {
    await DurableStream.create({ url: baseStreamUrl, headers, contentType: JSON_CONTENT_TYPE });
  } catch (error) {
    if (error instanceof DurableStreamError && error.code === "CONFLICT_EXISTS") return;
    throw error;
  }
}

async function ownsSession(
  sessionId: string,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.workspaceId, workspaceId),
        eq(agentSessions.userId, userId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// Streaming proxy — never buffer/cache the response (the live SSE tail must flush
// chunk-by-chunk, not collect until the connection closes).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

// Request headers we must NOT relay upstream: routing/transfer headers, our own
// auth (we inject the service token), our session cookie (don't leak it to the
// stream origin), and accept-encoding (force an uncompressed stream so there is
// nothing to buffer-to-compress and no content-encoding to reconcile).
const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "content-encoding",
  "accept-encoding",
  "authorization",
  "cookie",
]);

// Upstream transfer headers that don't apply to our re-emitted body.
const HOP_BY_HOP_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const config = durableStreamsConfig();
  if (!config) {
    return new Response("Durable Streams is not configured.", { status: 503 });
  }

  const context = await currentWorkspace({ optional: true, skipOnboarding: true });
  if (!context) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { sessionId } = await params;
  if (!(await ownsSession(sessionId, context.workspace.id, context.user.id))) {
    return new Response("Forbidden", { status: 403 });
  }

  // Trusted upstream stream URL — built from the validated session, never client input.
  const upstreamUrl = new URL(`${config.baseUrl}/session-${sessionId}`);
  // Forward the client's protocol params verbatim (offset, live mode, cursor, …);
  // they only control where in the stream to read, not which stream.
  for (const [key, value] of new URL(request.url).searchParams) {
    upstreamUrl.searchParams.set(key, value);
  }

  // Relay the client's request headers (the Durable Streams protocol negotiates
  // live/SSE via Accept + its own headers) minus the denylist; inject the token.
  const requestHeaders = new Headers();
  for (const [key, value] of request.headers) {
    if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) requestHeaders.set(key, value);
  }
  requestHeaders.set("accept-encoding", "identity");
  if (config.token) requestHeaders.set("authorization", `Bearer ${config.token}`);

  const fetchUpstream = () =>
    fetch(upstreamUrl, { headers: requestHeaders, signal: request.signal, cache: "no-store" });

  let upstream = await fetchUpstream();
  let retriedAfterCreate = false;
  if (upstream.status === 404) {
    // The stream doesn't exist yet (created lazily on the first append). Create
    // it, then retry the read once so the client tails a live stream instead of
    // treating the 404 as terminal (which left sessions stuck on a spinner until
    // a manual reload). Best-effort: if creation fails, fall through with the 404.
    try {
      await ensureStreamExists(`${config.baseUrl}/session-${sessionId}`, config.token);
      upstream = await fetchUpstream();
      retriedAfterCreate = true;
    } catch (error) {
      logger.warn("Durable stream proxy create-on-404 failed", {
        event: "opencompany.durable_stream_proxy_create_failed",
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info("Durable stream proxy read", {
    event: "opencompany.durable_stream_proxy_read",
    session_id: sessionId,
    status: upstream.status,
    retried_after_create: retriedAfterCreate,
  });

  // Stream the body through unbuffered (SSE/long-poll), preserving the Durable
  // Streams protocol headers (Stream-Next-Offset, Stream-Cursor, …) the client
  // reads to track offsets, minus hop-by-hop transfer headers.
  const responseHeaders = new Headers(upstream.headers);
  for (const header of HOP_BY_HOP_HEADERS) responseHeaders.delete(header);
  // Defeat any intermediary buffering of the live stream.
  responseHeaders.set("Cache-Control", "no-cache, no-transform");
  responseHeaders.set("X-Accel-Buffering", "no");
  // Cached reads must vary by auth so one user can't read another's transcript.
  responseHeaders.set("Vary", "Cookie");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
