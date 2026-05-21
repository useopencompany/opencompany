import { verifySessionStreamToken } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { agentSessions } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { abortSession, runMessage, startSession } from "./agent-loop";
import type { RunnerEnv } from "./env";
import { listSessionEvents } from "./events";

export function createServer(env: RunnerEnv) {
  const app = Fastify({ logger: true });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && env.allowedOrigins.includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID");
      reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    if (request.method === "OPTIONS") {
      return reply.status(204).send();
    }
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/internal/sessions/:id/start", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { id } = request.params as { id: string };
    void startSession(id, env).catch((error) => app.log.error(error));
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/sessions/:id/messages/:messageId/run", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { id, messageId } = request.params as { id: string; messageId: string };
    void runMessage({ sessionId: id, messageId, env }).catch((error) => app.log.error(error));
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/sessions/:id/abort", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { id } = request.params as { id: string };
    await abortSession(id);
    reply.send({ ok: true });
  });

  app.get("/sessions/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { token?: string; after?: string };
    const token = query.token ?? "";
    const payload = verifySessionStreamToken(token, env.streamTokenSecret);
    if (payload.sessionId !== id) {
      reply.status(403).send({ error: "Token does not match session." });
      return;
    }

    const [session] = await getDb()
      .select({ id: agentSessions.id, userId: agentSessions.userId })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!session || session.userId !== payload.userId) {
      reply.status(404).send({ error: "Session not found." });
      return;
    }

    const raw = reply.raw;
    reply.hijack();
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let lastId = readLastEventId(request.headers["last-event-id"], query.after);
    let closed = false;
    request.raw.on("close", () => {
      closed = true;
    });

    const flush = async () => {
      const events = await listSessionEvents({ sessionId: id, afterId: lastId, limit: 100 });
      for (const event of events) {
        lastId = event.id;
        raw.write(`id: ${event.id}\n`);
        raw.write(`data: ${JSON.stringify({ id: event.id, type: event.type, payload: event.payload, messageId: event.messageId })}\n\n`);
      }
    };

    await flush();
    const timer = setInterval(() => {
      void flush().catch((error) => {
        app.log.error(error);
        raw.write(`event: session.error\ndata: ${JSON.stringify({ message: "Event stream failed." })}\n\n`);
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
