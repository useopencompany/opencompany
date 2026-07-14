import { createLogger } from "@opencompany/observability";
import Fastify from "fastify";
import { abortSession, archiveSession } from "./agent-loop";
import {
  pollCodexDeviceAuthFlow,
  pollGoatCodexDeviceAuthFlow,
  startCodexDeviceAuthFlow,
  startGoatCodexDeviceAuthFlow,
} from "./codex-auth";
import type { RunnerEnv } from "./env";
import { wakeGoatBrainImportWorker } from "./goat-brain-import-worker";
import { wakeGoatBrainIngestWorker } from "./goat-brain-ingest-worker";
import { wakeGoatCodexChatWorker } from "./goat-codex-chat-worker";
import { wakeGoatGoogleDriveSyncWorker } from "./goat-google-drive-sync-worker";
import { executeGoatGoogleTool, isGoatGoogleToolName } from "./goat-google-tools";
import { planGoatHarnessForTask } from "./goat-harness";
import { getGoatHarnessPlannerContextForRunner } from "./goat-harness-planner";
import { verifyGoatToolToken } from "./goat-tool-auth";
import { wakeGoatTaskWorker } from "./goat-worker";
import { enqueueRunnerJob } from "./jobs";
import { type LlmBrokerOptions, registerLlmBrokerRoutes } from "./llm-broker";
import { getSandboxLifecycleStatus } from "./sandbox";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "server",
});

export function createServer(
  env: RunnerEnv,
  options: {
    onJobEnqueued?: () => void;
    llmBroker?: Pick<LlmBrokerOptions, "store" | "fetchImpl">;
  } = {},
) {
  const app = Fastify({ logger: false });

  // LLM broker (llm-broker.ts): authenticated reverse proxy for sandboxed CLIs. Lives
  // in its own encapsulated plugin scope so its raw-buffer content-type parser cannot
  // affect the JSON parsing of the /internal/* routes below.
  app.register(async (instance) => {
    registerLlmBrokerRoutes(instance, { env, ...options.llmBroker });
  });

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

  app.post("/internal/goat/tasks/:taskId/run", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    if (!env.goatTaskWorkerEnabled) {
      reply.status(503).send({ error: "Goat task worker is disabled." });
      return;
    }
    const { taskId } = request.params as { taskId: string };
    logger.info("Goat task run accepted", {
      event: "opencompany.goat_task_run_accepted",
      task_id: taskId,
    });
    wakeGoatTaskWorker();
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/goat/codex-chat/wake", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    if (!env.goatTaskWorkerEnabled) {
      reply.status(503).send({ error: "Goat workers are disabled." });
      return;
    }
    wakeGoatCodexChatWorker();
    reply.status(202).send({ ok: true });
  });

  app.get("/internal/goat/codex-chat/sandboxes/:sandboxId/status", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { sandboxId } = request.params as { sandboxId: string };
    if (!sandboxId.trim()) {
      reply.status(400).send({ error: "sandboxId is required." });
      return;
    }

    const status = await getSandboxLifecycleStatus(sandboxId);
    reply.send({ ok: true, status });
  });

  app.post("/internal/goat/brain-ingest/wake", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    if (!env.goatTaskWorkerEnabled) {
      reply.status(503).send({ error: "Goat workers are disabled." });
      return;
    }
    wakeGoatBrainIngestWorker();
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/goat/google-drive/sync", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    if (!env.goatTaskWorkerEnabled) {
      reply.status(503).send({ error: "Goat workers are disabled." });
      return;
    }
    wakeGoatGoogleDriveSyncWorker();
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/goat/brain-import/wake", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    if (!env.goatTaskWorkerEnabled) {
      reply.status(503).send({ error: "Goat workers are disabled." });
      return;
    }
    wakeGoatBrainImportWorker();
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/goat/task-harness/plan", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    if (!env.goatTaskWorkerEnabled) {
      reply.status(503).send({ error: "Goat task worker is disabled." });
      return;
    }

    const body = request.body as { userWorkosId?: unknown; prompt?: unknown } | undefined;
    const userWorkosId = typeof body?.userWorkosId === "string" ? body.userWorkosId.trim() : "";
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (!userWorkosId || !prompt) {
      reply.status(400).send({ error: "userWorkosId and prompt are required." });
      return;
    }

    const plannerContext = await getGoatHarnessPlannerContextForRunner(userWorkosId, {
      browserEnabled: env.goatBrowserEnabled,
    });
    const planned = await planGoatHarnessForTask({
      prompt,
      model: "moonshotai/kimi-k2.6",
      availableTools: plannerContext.availableTools,
      githubRepositories: plannerContext.githubRepositories,
      gatewayApiKey: env.vercelAiGatewayApiKey,
      userWorkosId,
      signal: new AbortController().signal,
    });
    reply.send({ ok: true, harnessSpec: planned.harnessSpec });
  });

  app.post("/goat/tools/:taskId", async (request, reply) => {
    if (!env.goatTaskWorkerEnabled) {
      reply.status(404).send({ error: "Not found." });
      return;
    }
    const { taskId } = request.params as { taskId: string };
    let payload;
    try {
      payload = verifyGoatToolToken({
        taskId,
        secret: env.internalToken,
        token: readBearerToken(request.headers.authorization),
      });
    } catch {
      reply.status(401).send({ error: "Unauthorized Goat tool request." });
      return;
    }

    const body = request.body as { name?: unknown; args?: unknown } | undefined;
    const name = typeof body?.name === "string" ? body.name : "";
    if (!isGoatGoogleToolName(name)) {
      reply.status(400).send({ error: "Unknown Goat tool." });
      return;
    }

    try {
      const output = await executeGoatGoogleTool({
        name,
        args: body?.args ?? {},
        userWorkosId: payload.userWorkosId,
        env,
        signal: new AbortController().signal,
      });
      reply.send({ ok: true, output });
    } catch (error) {
      reply.status(400).send({
        ok: false,
        error: error instanceof Error ? error.message : "Goat tool failed.",
      });
    }
  });

  app.post("/internal/codex-auth/device/start", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const body = request.body as { workspaceId?: string; requestedByUserId?: string } | undefined;
    const workspaceId = body?.workspaceId?.trim();
    const requestedByUserId = body?.requestedByUserId?.trim();
    if (!workspaceId || !requestedByUserId) {
      reply.status(400).send({ error: "workspaceId and requestedByUserId are required." });
      return;
    }
    logger.info("Codex device auth start route received", {
      event: "opencompany.runner_codex_auth_start_route_received",
      workspace_id: workspaceId,
      requested_by_user_id: requestedByUserId,
    });
    const flow = await startCodexDeviceAuthFlow({
      workspaceId,
      requestedByUserId,
      env,
    });
    logger.info("Codex device auth start route completed", {
      event: "opencompany.runner_codex_auth_start_route_completed",
      workspace_id: workspaceId,
      flow_id: flow.id,
      flow_status: flow.status,
    });
    reply.send({ ok: true, flow });
  });

  app.post("/internal/codex-auth/device/:flowId/poll", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { flowId } = request.params as { flowId: string };
    const body = request.body as { workspaceId?: string } | undefined;
    const workspaceId = body?.workspaceId?.trim();
    if (!workspaceId) {
      reply.status(400).send({ error: "workspaceId is required." });
      return;
    }
    logger.debug("Codex device auth poll route received", {
      event: "opencompany.runner_codex_auth_poll_route_received",
      workspace_id: workspaceId,
      flow_id: flowId,
    });
    const flow = await pollCodexDeviceAuthFlow({ workspaceId, flowId, env });
    if (!flow) {
      reply.status(404).send({ error: "Codex device auth flow was not found." });
      return;
    }
    logger.debug("Codex device auth poll route completed", {
      event: "opencompany.runner_codex_auth_poll_route_completed",
      workspace_id: workspaceId,
      flow_id: flow.id,
      flow_status: flow.status,
      has_user_code: Boolean(flow.userCode),
      has_verification_uri: Boolean(flow.verificationUri),
    });
    reply.send({ ok: true, flow });
  });

  app.post("/internal/goat/codex-auth/device/start", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const body = request.body as { userWorkosId?: unknown } | undefined;
    const userWorkosId = typeof body?.userWorkosId === "string" ? body.userWorkosId.trim() : "";
    if (!userWorkosId) {
      reply.status(400).send({ error: "userWorkosId is required." });
      return;
    }
    logger.info("Goat Codex device auth start route received", {
      event: "opencompany.runner_goat_codex_auth_start_route_received",
      user_workos_id: userWorkosId,
    });
    const flow = await startGoatCodexDeviceAuthFlow({ userWorkosId, env });
    logger.info("Goat Codex device auth start route completed", {
      event: "opencompany.runner_goat_codex_auth_start_route_completed",
      user_workos_id: userWorkosId,
      flow_id: flow.id,
      flow_status: flow.status,
    });
    reply.send({ ok: true, flow });
  });

  app.post("/internal/goat/codex-auth/device/:flowId/poll", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { flowId } = request.params as { flowId: string };
    const body = request.body as { userWorkosId?: unknown } | undefined;
    const userWorkosId = typeof body?.userWorkosId === "string" ? body.userWorkosId.trim() : "";
    if (!userWorkosId) {
      reply.status(400).send({ error: "userWorkosId is required." });
      return;
    }
    logger.debug("Goat Codex device auth poll route received", {
      event: "opencompany.runner_goat_codex_auth_poll_route_received",
      user_workos_id: userWorkosId,
      flow_id: flowId,
    });
    const flow = await pollGoatCodexDeviceAuthFlow({
      userWorkosId,
      flowId,
      env,
    });
    if (!flow) {
      reply.status(404).send({ error: "Goat Codex device auth flow was not found." });
      return;
    }
    logger.debug("Goat Codex device auth poll route completed", {
      event: "opencompany.runner_goat_codex_auth_poll_route_completed",
      user_workos_id: userWorkosId,
      flow_id: flow.id,
      flow_status: flow.status,
      has_user_code: Boolean(flow.userCode),
      has_verification_uri: Boolean(flow.verificationUri),
    });
    reply.send({ ok: true, flow });
  });

  app.post("/internal/sessions/:id/messages/:messageId/run", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { id, messageId } = request.params as {
      id: string;
      messageId: string;
    };
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

  app.post("/internal/sessions/:id/messages/:messageId/codex-turn", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { id, messageId } = request.params as {
      id: string;
      messageId: string;
    };
    logger.info("Runner Codex turn accepted", {
      event: "opencompany.runner_codex_turn_accepted",
      session_id: id,
      message_id: messageId,
    });
    await enqueueRunnerJob({
      kind: "codex_turn",
      sessionId: id,
      messageId,
    });
    wakeWorker();
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/sessions/:id/approvals/:toolCallId/resume", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { id, toolCallId } = request.params as {
      id: string;
      toolCallId: string;
    };
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
    const { id, toolCallId } = request.params as {
      id: string;
      toolCallId: string;
    };
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
    const { id, messageId } = request.params as {
      id: string;
      messageId: string;
    };
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

  return app;
}

function requireInternalAuth(header: string | undefined, token: string) {
  if (header !== `Bearer ${token}`) {
    throw new Error("Unauthorized runner request.");
  }
}

function readBearerToken(header: string | undefined) {
  if (!header?.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}
