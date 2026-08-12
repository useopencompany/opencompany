import { serve } from "@hono/node-server";
import { RedisChatPresentationStream } from "@opencompany/chat-presentation";
import { ChatApplicationService, TaskApplicationService } from "@opencompany/core";
import {
  PostgresChatAttachmentRepository,
  PostgresChatRepository,
} from "@opencompany/db/chat-repository";
import { createPooledDb } from "@opencompany/db/pool";
import { PostgresTaskRepository } from "@opencompany/db/task-repository";
import { resolvePersistedAutoModelRouting } from "@opencompany/goat-agent/application/persisted-auto-model-routing";
import { getGoatAvailableHarnessTools } from "@opencompany/goat-agent/integrations/google-data";
import {
  registerGoatNodeObservability,
  shutdownGoatNodeObservability,
} from "@opencompany/goat-observability/node";
import { createLogger } from "@opencompany/observability";
import { createApiApp } from "./app";
import { createAttachmentUploadService } from "./attachments";
import { createWorkOsApiAuthenticator } from "./auth";
import { createAutomationServices } from "./automations";
import { parseBrowserOrigins } from "./browser-origins";
import { ElectricReadModelProxy } from "./electric-read-models";
import { PostgresRunEventNotifier } from "./run-event-notifier";

const logger = createLogger({ service: "opencompany-api", runtime: "server" });
registerGoatNodeObservability({ serviceName: "opencompany-api" });

const database = createPooledDb(resolveApiDatabaseUrl(), { max: resolvePoolMax() });
const execute = (query: Parameters<typeof database.db.execute>[0]) => database.db.execute(query);
const attachmentRepository = new PostgresChatAttachmentRepository(execute);
const chat = new ChatApplicationService(
  new PostgresChatRepository(execute, {
    resolveAttachments: (input) => attachmentRepository.resolve(input),
  }),
);
const tasks = new TaskApplicationService(
  new PostgresTaskRepository(execute, {
    resolveAttachments: (input) => attachmentRepository.resolve(input),
    resolveHarness: async ({ actor, command }) => ({
      schemaVersion: "goat.harness.v1",
      engine: command.engine,
      model: command.model,
      systemPrompt: "",
      initialUserMessage: command.goal,
      tools: await getGoatAvailableHarnessTools(actor.userId),
      skills: [],
      maxModelSteps: 16,
      resultMode: "assistant_final",
    }),
  }),
);
const automations = createAutomationServices({
  execute,
  resolveAttachments: (input) => attachmentRepository.resolve(input),
});
const notifier = new PostgresRunEventNotifier(database.pool);
const presentation = createPresentationStream();
const readModels = createElectricReadModels();
const app = createApiApp({
  chat,
  tasks,
  workflows: automations.workflows,
  schedules: automations.schedules,
  attachments: createAttachmentUploadService({ repository: attachmentRepository }),
  authenticate: createWorkOsApiAuthenticator(execute),
  browserOrigins: parseBrowserOrigins(process.env.API_BROWSER_ORIGINS),
  notifier,
  resolveAutoModel: (input) =>
    resolvePersistedAutoModelRouting({
      ...input,
      gatewayApiKey: process.env.VERCEL_AI_GATEWAY_API_KEY?.trim(),
      db: database.db,
    }),
  ...(presentation ? { presentation } : {}),
  ...(readModels ? { readModels } : {}),
});
const port = resolvePort();
const server = serve({ fetch: app.fetch, port });
logger.info("API server started", { event: "opencompany.api_started", port });

let closing = false;
async function close(signal: string) {
  if (closing) return;
  closing = true;
  logger.info("API server stopping", { event: "opencompany.api_stopping", signal });
  server.close();
  await notifier.close();
  await presentation?.close();
  await database.close();
  await shutdownGoatNodeObservability();
}

process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

export function resolveApiDatabaseUrl() {
  const explicit = process.env.API_DATABASE_URL?.trim() ?? process.env.RUNNER_DATABASE_URL?.trim();
  if (explicit) return explicit;
  const base = process.env.DATABASE_URL?.trim();
  if (!base) throw new Error("API_DATABASE_URL or DATABASE_URL is required.");
  return base.replace("-pooler.", ".");
}

function resolvePoolMax() {
  const raw = process.env.API_DB_POOL_MAX?.trim();
  if (!raw) return 10;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("API_DB_POOL_MAX must be a positive integer.");
  }
  return value;
}

function resolvePort() {
  const value = Number(process.env.PORT ?? "3001");
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return value;
}

function createElectricReadModels() {
  const electricUrl = process.env.ELECTRIC_URL?.trim();
  if (!electricUrl) return null;
  return new ElectricReadModelProxy({
    electricUrl,
    ...(process.env.ELECTRIC_SOURCE_ID?.trim()
      ? { sourceId: process.env.ELECTRIC_SOURCE_ID.trim() }
      : {}),
    ...(process.env.ELECTRIC_SOURCE_SECRET?.trim()
      ? { sourceSecret: process.env.ELECTRIC_SOURCE_SECRET.trim() }
      : {}),
    ...(process.env.ELECTRIC_SECRET?.trim()
      ? { electricSecret: process.env.ELECTRIC_SECRET.trim() }
      : {}),
    ...(process.env.ELECTRIC_TOKEN?.trim() ? { token: process.env.ELECTRIC_TOKEN.trim() } : {}),
  });
}

function createPresentationStream() {
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  return new RedisChatPresentationStream({
    url,
    onError: ({ operation, error }) => {
      logger.warn("API transient Chat presentation degraded to Postgres", {
        event: "opencompany.api_chat_presentation_redis_degraded",
        operation,
        error_name: error instanceof Error ? error.name : typeof error,
      });
    },
  });
}
