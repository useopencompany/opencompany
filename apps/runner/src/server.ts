import { createLogger } from "@opencompany/observability";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import { abortSession, archiveSession } from "./agent-loop";
import {
  authenticateDeviceConnection,
  disconnectDevice,
  registerDeviceConnection,
} from "./device-bridge";
import type { RunnerEnv } from "./env";
import { enqueueRunnerJob } from "./jobs";

const logger = createLogger({ service: "opencompany-runner", runtime: "server" });

export function createServer(env: RunnerEnv, options: { onJobEnqueued?: () => void } = {}) {
  const app = Fastify({ logger: false });

  // Nudge the in-process job worker as soon as a job lands so it claims the run on the
  // next tick instead of waiting out its poll interval. Best-effort: never block the
  // 202 response, and never let a worker hiccup fail the enqueue.
  const wakeWorker = () => {
    try {
      options.onJobEnqueued?.();
    } catch (error) {
      logger.warn("Failed to wake runner job worker", {
        event: "opencompany.runner_job_worker_wake_failed",
        error,
      });
    }
  };

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
    await enqueueRunnerJob({
      kind: "start",
      sessionId: id,
    });
    wakeWorker();
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
    await enqueueRunnerJob({
      kind: "message",
      sessionId: id,
      messageId,
    });
    wakeWorker();
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/sessions/:id/approvals/:toolCallId/resume", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { id, toolCallId } = request.params as { id: string; toolCallId: string };
    logger.info("Runner approval resume accepted", {
      event: "opencompany.runner_approval_resume_accepted",
      session_id: id,
      tool_call_id: toolCallId,
    });
    // The resume job carries the toolCallId in the message_id column (its idempotency
    // key is resume_approval:{sessionId}:{toolCallId}).
    await enqueueRunnerJob({
      kind: "resume_approval",
      sessionId: id,
      messageId: toolCallId,
    });
    wakeWorker();
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/sessions/:id/questions/:toolCallId/resume", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { id, toolCallId } = request.params as { id: string; toolCallId: string };
    logger.info("Runner question resume accepted", {
      event: "opencompany.runner_question_resume_accepted",
      session_id: id,
      tool_call_id: toolCallId,
    });
    // The resume job carries the toolCallId in the message_id column (its idempotency
    // key is resume_question:{sessionId}:{toolCallId}).
    await enqueueRunnerJob({
      kind: "resume_question",
      sessionId: id,
      messageId: toolCallId,
    });
    wakeWorker();
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/sessions/:id/messages/:messageId/title", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { id, messageId } = request.params as { id: string; messageId: string };
    await enqueueRunnerJob({
      kind: "title",
      sessionId: id,
      messageId,
    });
    wakeWorker();
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/sessions/:id/after-session", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { id } = request.params as { id: string };
    const query = request.query as { messageId?: string };
    const messageId = query.messageId?.trim();
    if (!messageId) {
      reply.status(400).send({ error: "messageId is required." });
      return;
    }
    logger.info("Runner after-session accepted", {
      event: "opencompany.runner_after_session_accepted",
      session_id: id,
      message_id: messageId,
    });
    await enqueueRunnerJob({
      kind: "after_session",
      sessionId: id,
      messageId,
    });
    wakeWorker();
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

  app.post("/internal/devices/:id/disconnect", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { id } = request.params as { id: string };
    const dropped = disconnectDevice(id);
    reply.send({ ok: true, dropped });
  });

  // The local-bridge daemon's outbound WebSocket. The daemon authenticates with its
  // device secret (only the hash is stored server-side); a failed auth closes with 4401.
  // Note the asymmetry to /internal routes: devices belong to end users, not the web
  // backend, so this is deliberately NOT behind the internal token.
  app.register(fastifyWebsocket);
  app.register(async (scope) => {
    scope.get("/bridge/ws", { websocket: true }, async (socket, request) => {
      const identity = await authenticateDeviceConnection({
        authorizationHeader: request.headers.authorization,
        deviceIdHeader: request.headers["x-device-id"] as string | undefined,
      });
      if (!identity) {
        logger.warn("Rejected device bridge connection", {
          event: "opencompany.device_bridge_auth_failed",
        });
        socket.close(4401, "Unauthorized device.");
        return;
      }
      const handlers = registerDeviceConnection({
        ...identity,
        socket: {
          send: (data) => socket.send(data),
          close: (code, reason) => socket.close(code, reason),
        },
      });
      socket.on("message", (data: Buffer | string) => {
        handlers.onMessage(typeof data === "string" ? data : data.toString("utf8"));
      });
      socket.on("close", () => handlers.onClose());
      socket.on("error", () => handlers.onClose());
    });
  });

  return app;
}

function requireInternalAuth(header: string | undefined, token: string) {
  if (header !== `Bearer ${token}`) {
    throw new Error("Unauthorized runner request.");
  }
}
