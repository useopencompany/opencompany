import { serve } from "@hono/node-server";
import { ChatApplicationService } from "@opencompany/core";
import {
  PostgresChatAttachmentRepository,
  PostgresChatRepository,
} from "@opencompany/db/chat-repository";
import { createPooledDb } from "@opencompany/db/pool";
import {
  registerGoatNodeObservability,
  shutdownGoatNodeObservability,
} from "@opencompany/goat-observability/node";
import { createLogger } from "@opencompany/observability";
import { createApiApp } from "./app";
import { createAttachmentUploadService } from "./attachments";
import { createWorkOsApiAuthenticator } from "./auth";
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
const notifier = new PostgresRunEventNotifier(database.pool);
const app = createApiApp({
  chat,
  attachments: createAttachmentUploadService({ repository: attachmentRepository }),
  authenticate: createWorkOsApiAuthenticator(execute),
  notifier,
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
