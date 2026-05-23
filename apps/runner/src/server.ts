import { verifySessionStreamToken } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { agentSessions } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { abortSession, archiveSession, runMessage, startSession } from "./agent-loop";
import type { RunnerEnv } from "./env";
import { listSessionEvents, type PersistedRuntimeEvent, subscribeSessionEvents } from "./events";
import { generateSessionTitleForMessage } from "./session-title";

const logger = createLogger({ service: "opencompany-runner", runtime: "server" });

export function createServer(env: RunnerEnv) {
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && env.allowedOrigins.includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID");
      reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    } else if (origin) {
      logger.warn("Denied runner CORS origin", { origin });
    }
    if (request.method === "OPTIONS") {
      return reply.status(204).send();
    }
  });

  app.get("/healthz", async () => ({
    ok: true,
    service: "opencompany-runner",
    environment: process.env.OBSERVABILITY_ENV ?? process.env.NODE_ENV ?? "development",
    release:
      process.env.RENDER_GIT_COMMIT ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.OBSERVABILITY_RELEASE ??
      null,
    renderGitCommit: process.env.RENDER_GIT_COMMIT ?? null,
  }));

  app.post("/internal/sessions/:id/start", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { id } = request.params as { id: string };
    logger.info("Runner session start accepted", {
      event: "opencompany.runner_session_start_accepted",
      session_id: id,
    });
    void startSession(id, env).catch((error) => {
      captureException(error, {
        event: "opencompany.runner_start_failed",
        session_id: id,
      });
      logger.error("Runner start session failed", { session_id: id, error });
    });
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/sessions/:id/messages/:messageId/run", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { id, messageId } = request.params as { id: string; messageId: string };
    logger.info("Runner message run accepted", {
      event: "opencompany.runner_message_run_accepted",
      session_id: id,
      message_id: messageId,
    });
    void runMessage({ sessionId: id, messageId, env }).catch((error) => {
      logger.error("Runner message failed", {
        event: "opencompany.runner_message_failed",
        session_id: id,
        message_id: messageId,
        error,
      });
    });
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/sessions/:id/messages/:messageId/title", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { id, messageId } = request.params as { id: string; messageId: string };
    void generateSessionTitleForMessage({ sessionId: id, messageId, env }).catch((error) => {
      captureException(error, {
        event: "opencompany.runner_title_generation_failed",
        session_id: id,
        message_id: messageId,
      });
      logger.warn("Runner title generation failed", { session_id: id, message_id: messageId });
    });
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/sessions/:id/abort", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { id } = request.params as { id: string };
    logger.info("Runner session abort accepted", {
      event: "opencompany.runner_session_abort_accepted",
      session_id: id,
    });
    await abortSession(id);
    reply.send({ ok: true });
  });

  app.post("/internal/sessions/:id/archive", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { id } = request.params as { id: string };
    await archiveSession(id);
    reply.send({ ok: true });
  });

  app.get("/sessions/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { token?: string; after?: string };
    const token = query.token ?? "";
    const payload = verifyStreamToken(token, env.streamTokenSecret);
    if (!payload.ok) {
      logger.warn("Rejected session event stream", {
        event: "opencompany.runner_sse_rejected",
        session_id: id,
        reason: payload.reason,
      });
      reply.status(401).send({ error: payload.message });
      return;
    }

    if (payload.sessionId !== id) {
      logger.warn("Rejected session event stream token for another session", {
        event: "opencompany.runner_sse_rejected",
        session_id: id,
        reason: "session_mismatch",
      });
      reply.status(403).send({ error: "Token does not match session." });
      return;
    }

    const [session] = await getDb()
      .select({ id: agentSessions.id, userId: agentSessions.userId })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!session || session.userId !== payload.userId) {
      logger.warn("Rejected session event stream for missing session or user", {
        event: "opencompany.runner_sse_rejected",
        session_id: id,
        user_id: payload.userId,
        reason: "session_not_found_or_user_mismatch",
      });
      reply.status(404).send({ error: "Session not found." });
      return;
    }

    const raw = reply.raw;
    reply.hijack();
    raw.writeHead(200, createSseHeaders(env, request.headers.origin));

    let lastId = readLastEventId(request.headers["last-event-id"], query.after);
    const connectedAt = Date.now();
    const requestedAfterId = lastId;
    let closed = false;
    request.raw.on("close", () => {
      closed = true;
    });

    const writeEvent = (event: PersistedRuntimeEvent) => {
      if (closed || event.id <= lastId) return false;
      lastId = event.id;
      raw.write(formatSseEvent(event));
      return true;
    };

    const flush = async () => {
      const events = await listSessionEvents({ sessionId: id, afterId: lastId, limit: 100 });
      let written = 0;
      for (const event of events) {
        if (writeEvent(event)) written += 1;
      }
      return written;
    };

    const replayedEvents = await flush();
    logger.info("Runner SSE connected", {
      event: "opencompany.runner_sse_connected",
      session_id: id,
      user_id: payload.userId,
      after_id: requestedAfterId,
      latest_event_id: lastId,
      replayed_events: replayedEvents,
    });
    const unsubscribe = subscribeSessionEvents(id, (event) => {
      writeEvent(event);
    });
    const timer = setInterval(() => {
      void flush().catch((error) => {
        logger.error("Event stream flush failed", {
          event: "opencompany.runner_sse_flush_failed",
          session_id: id,
          error,
        });
        raw.write(formatStreamError("Event stream failed."));
      });
    }, 300);
    const heartbeat = setInterval(() => {
      raw.write(": heartbeat\n\n");
    }, 15000);

    while (!closed) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    clearInterval(timer);
    clearInterval(heartbeat);
    unsubscribe();
    logger.info("Runner SSE closed", {
      event: "opencompany.runner_sse_closed",
      session_id: id,
      user_id: payload.userId,
      latest_event_id: lastId,
      duration_ms: Date.now() - connectedAt,
    });
  });

  return app;
}

function requireInternalAuth(header: string | undefined, token: string) {
  if (header !== `Bearer ${token}`) {
    throw new Error("Unauthorized runner request.");
  }
}

function readLastEventId(header: string | string[] | undefined, after: string | undefined) {
  const value = Array.isArray(header) ? header[0] : header;
  const parsed = Number(value ?? after ?? "0");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function formatSseEvent(event: PersistedRuntimeEvent) {
  return `id: ${event.id}\ndata: ${JSON.stringify(toRuntimeEventPayload(event))}\n\n`;
}

export function formatStreamError(message: string) {
  return `event: session.error\ndata: ${JSON.stringify({ message })}\n\n`;
}

export function createSseHeaders(env: RunnerEnv, origin: string | undefined) {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...(origin && env.allowedOrigins.includes(origin)
      ? {
          "Access-Control-Allow-Origin": origin,
          Vary: "Origin",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, Last-Event-ID",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        }
      : {}),
  };
}

function toRuntimeEventPayload(event: PersistedRuntimeEvent) {
  return {
    id: event.id,
    type: event.type,
    payload: event.payload,
    messageId: event.messageId,
  };
}

function verifyStreamToken(token: string, secret: string) {
  if (!token) {
    return { ok: false as const, reason: "missing", message: "Missing stream token." };
  }

  try {
    return { ok: true as const, ...verifySessionStreamToken(token, secret) };
  } catch (error) {
    return {
      ok: false as const,
      reason: error instanceof Error ? error.message : "invalid",
      message: "Invalid stream token.",
    };
  }
}

export function redactStreamToken(url: string | undefined) {
  if (!url || !url.includes("token=")) return url;

  try {
    const parsed = new URL(url, "http://runner.local");
    if (parsed.searchParams.has("token")) {
      parsed.searchParams.set("token", "[redacted]");
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url.replace(/([?&]token=)[^&]*/g, "$1[redacted]");
  }
}
