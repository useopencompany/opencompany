import { createLogger } from "@opencompany/observability";
import Fastify from "fastify";
import { wakeBrainImportWorker } from "./brain-import-worker";
import { wakeBrainIngestWorker } from "./brain-ingest-worker";
import { pollCodexDeviceAuthFlow, startCodexDeviceAuthFlow } from "./codex-auth";
import { CodingWorkspaceAccessError, mintCodingWorkspaceAccess } from "./coding-workspace-runtime";
import { createCodingWorkspaceTransport } from "./coding-workspace-runtime-transport";
import { createDictationTicket } from "./dictation-auth";
import type { RunnerEnv } from "./env";
import { wakeGoogleDriveSyncWorker } from "./google-drive-sync-worker";
import { planHarnessForTask } from "./harness";
import { getHarnessPlannerContextForRunner } from "./harness-planner";
import { completeInfisicalAuthFlow, startInfisicalAuthFlow } from "./infisical-auth";
import { type LlmBrokerOptions, registerLlmBrokerRoutes } from "./llm-broker";
import { getSandboxLifecycleStatus, killSandbox } from "./sandbox";
import { wakeCodexChatWorker } from "./turn-worker";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "server",
});

export function createServer(
  env: RunnerEnv,
  options: {
    llmBroker?: Pick<LlmBrokerOptions, "store" | "fetchImpl">;
  } = {},
) {
  const runtimeTransport = createCodingWorkspaceTransport(env);
  const app = Fastify({
    logger: false,
    serverFactory: runtimeTransport.serverFactory,
  });
  app.addHook("preClose", () => runtimeTransport.close());

  // LLM broker (llm-broker.ts): authenticated reverse proxy for sandboxed CLIs. Lives
  // in its own encapsulated plugin scope so its raw-buffer content-type parser cannot
  // affect the JSON parsing of the /internal/* routes below.
  app.register(async (instance) => {
    registerLlmBrokerRoutes(instance, { env, ...options.llmBroker });
  });

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

  app.post("/internal/goat/codex-chat/wake", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    if (!env.taskWorkerEnabled) {
      reply.status(503).send({ error: "Goat workers are disabled." });
      return;
    }
    wakeCodexChatWorker();
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

  app.post(
    "/internal/goat/coding-workspaces/sessions/:codingSessionId/runtime-access",
    async (request, reply) => {
      requireInternalAuth(request.headers.authorization, env.internalToken);
      const { codingSessionId } = request.params as { codingSessionId: string };
      const body = request.body as { userWorkosId?: unknown } | undefined;
      const userWorkosId = typeof body?.userWorkosId === "string" ? body.userWorkosId.trim() : "";
      if (!codingSessionId.trim() || !userWorkosId) {
        reply.status(400).send({ error: "codingSessionId and userWorkosId are required." });
        return;
      }

      try {
        const access = await mintCodingWorkspaceAccess({
          codingSessionId,
          userWorkosId,
          env,
        });
        reply.send(access);
      } catch (error) {
        if (error instanceof CodingWorkspaceAccessError) {
          reply.status(error.statusCode).send({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );

  app.post("/internal/goat/dictation/access", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const body = request.body as { userWorkosId?: unknown } | undefined;
    const userWorkosId = typeof body?.userWorkosId === "string" ? body.userWorkosId.trim() : "";
    if (!userWorkosId) {
      reply.status(400).send({ error: "userWorkosId is required." });
      return;
    }

    reply.send(createDictationTicket({ userWorkosId, secret: env.streamTokenSecret }));
  });

  app.delete("/internal/goat/codex-chat/sandboxes/:sandboxId", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { sandboxId } = request.params as { sandboxId: string };
    if (!sandboxId.trim()) {
      reply.status(400).send({ error: "sandboxId is required." });
      return;
    }

    const killed = await killSandbox(sandboxId);
    reply.send({ ok: true, killed });
  });

  app.post("/internal/goat/brain-ingest/wake", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    if (!env.taskWorkerEnabled) {
      reply.status(503).send({ error: "Goat workers are disabled." });
      return;
    }
    wakeBrainIngestWorker();
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/goat/google-drive/sync", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    if (!env.taskWorkerEnabled) {
      reply.status(503).send({ error: "Goat workers are disabled." });
      return;
    }
    wakeGoogleDriveSyncWorker();
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/goat/brain-import/wake", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    if (!env.taskWorkerEnabled) {
      reply.status(503).send({ error: "Goat workers are disabled." });
      return;
    }
    wakeBrainImportWorker();
    reply.status(202).send({ ok: true });
  });

  app.post("/internal/goat/task-harness/plan", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    if (!env.taskWorkerEnabled) {
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

    const plannerContext = await getHarnessPlannerContextForRunner(userWorkosId, {
      browserEnabled: env.browserEnabled,
    });
    const planned = await planHarnessForTask({
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
    const flow = await startCodexDeviceAuthFlow({ userWorkosId, env });
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
    const flow = await pollCodexDeviceAuthFlow({
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

  app.post("/internal/goat/infisical-auth/start", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const body = request.body as
      | { workspaceId?: unknown; requestedByWorkosId?: unknown }
      | undefined;
    const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
    const requestedByWorkosId =
      typeof body?.requestedByWorkosId === "string" ? body.requestedByWorkosId.trim() : "";
    if (!workspaceId || !requestedByWorkosId) {
      reply.status(400).send({ error: "workspaceId and requestedByWorkosId are required." });
      return;
    }
    try {
      const flow = await startInfisicalAuthFlow({ workspaceId, requestedByWorkosId, env });
      reply.send({ ok: true, flow });
    } catch (error) {
      const forbidden =
        error instanceof Error && error.message === "Only workspace admins can do this.";
      reply.status(forbidden ? 403 : 502).send({
        error: forbidden
          ? "Only workspace admins can do this."
          : "Infisical connection could not start. Please try again.",
      });
    }
  });

  app.post("/internal/goat/infisical-auth/:flowId/complete", async (request, reply) => {
    requireInternalAuth(request.headers.authorization, env.internalToken);
    const { flowId } = request.params as { flowId: string };
    const body = request.body as
      | { workspaceId?: unknown; requestedByWorkosId?: unknown; browserToken?: unknown }
      | undefined;
    const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
    const requestedByWorkosId =
      typeof body?.requestedByWorkosId === "string" ? body.requestedByWorkosId.trim() : "";
    const browserToken = typeof body?.browserToken === "string" ? body.browserToken.trim() : "";
    if (!workspaceId || !requestedByWorkosId || !browserToken) {
      reply
        .status(400)
        .send({ error: "workspaceId, requestedByWorkosId, and browserToken are required." });
      return;
    }
    try {
      const flow = await completeInfisicalAuthFlow({
        workspaceId,
        requestedByWorkosId,
        flowId,
        browserToken,
      });
      if (!flow) {
        reply.status(404).send({ error: "Infisical authentication flow was not found." });
        return;
      }
      reply.send({ ok: true, flow });
    } catch (error) {
      const message = safeInfisicalCompletionRouteError(error);
      reply.status(message === "Only workspace admins can do this." ? 403 : 400).send({
        error: message,
      });
    }
  });

  return app;
}

function requireInternalAuth(header: string | undefined, token: string) {
  if (header !== `Bearer ${token}`) {
    const error = new Error("Unauthorized runner request.") as Error & { statusCode: number };
    error.statusCode = 401;
    throw error;
  }
}

function safeInfisicalCompletionRouteError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "Only workspace admins can do this.") return message;
  if (message === "That does not look like a valid Infisical browser token.") return message;
  return "Infisical connection could not be completed. Please try again.";
}
