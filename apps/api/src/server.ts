import { serve } from "@hono/node-server";
import { captureGoatServerEvent } from "@opencompany/analytics/goat/server";
import { createGoatBillingApplicationService } from "@opencompany/billing/application-service";
import { getGoatStripe, getGoatStripeWebhookSecret } from "@opencompany/billing/stripe";
import { RedisChatPresentationStream } from "@opencompany/chat-presentation";
import {
  ChatApplicationService,
  KnowledgeApplicationService,
  SkillImportApplicationService,
  TaskApplicationService,
} from "@opencompany/core";
import {
  PostgresChatAttachmentRepository,
  PostgresChatRepository,
} from "@opencompany/db/chat-repository";
import { PostgresKnowledgeRepository } from "@opencompany/db/knowledge-repository";
import { createPooledDb } from "@opencompany/db/pool";
import { PostgresTaskRepository } from "@opencompany/db/task-repository";
import { getGoatAppUrl } from "@opencompany/goat-agent/app-url";
import { resolvePersistedAutoModelRouting } from "@opencompany/goat-agent/application/persisted-auto-model-routing";
import { GoatBrainImportApplicationService } from "@opencompany/goat-agent/brain-imports";
import { GoatBrainSourceApplicationService } from "@opencompany/goat-agent/brain-sources";
import { GoatBrowserProfileApplicationService } from "@opencompany/goat-agent/browser-profiles/service";
import { getGoatAvailableHarnessTools } from "@opencompany/goat-agent/integrations/google-data";
import { createGoatSkillImportResolver } from "@opencompany/goat-agent/skill-import";
import {
  registerGoatNodeObservability,
  shutdownGoatNodeObservability,
} from "@opencompany/goat-observability/node";
import { createLogger } from "@opencompany/observability";
import { WorkOS } from "@workos-inc/node";
import { createApiApp } from "./app";
import { createAttachmentUploadService } from "./attachments";
import { createAttioIngress } from "./attio-ingress";
import { createWorkOsApiAuthenticator, createWorkOsApiIdentityVerifier } from "./auth";
import { createAutomationServices } from "./automations";
import { createBillingReconcileService } from "./billing-reconcile";
import { createBrainAssetService } from "./brain-assets";
import { createBrainControlService } from "./brain-control";
import { parseBrowserOrigins } from "./browser-origins";
import { createChatResourceService } from "./chat-resources";
import { createChatTitleService } from "./chat-title";
import { ElectricReadModelProxy } from "./electric-read-models";
import { createEngineAuthService } from "./engine-auth";
import { createEngineSessionService } from "./engine-sessions";
import { createFeedbackService } from "./feedback";
import { createGitHubIngress } from "./github-ingress";
import { createGoogleIngress } from "./google-ingress";
import { createHubspotIngress } from "./hubspot-ingress";
import { createIdentityService } from "./identity";
import { createIntegrationAccountService } from "./integration-accounts";
import { createJamieIngress } from "./jamie-ingress";
import { createLinearIngress } from "./linear-ingress";
import { createMcpOAuthIngress } from "./mcp-oauth-ingress";
import { createOnboardingService } from "./onboarding";
import { createOnboardingEmailService } from "./onboarding-emails";
import { createRepoConfigService } from "./repo-configs";
import { PostgresRunEventNotifier } from "./run-event-notifier";
import { createRunnerClient } from "./runner-client";
import { createSlackBotIngress } from "./slack-bot-ingress";
import { createSlackIngress } from "./slack-ingress";
import { createStripeIngress } from "./stripe-ingress";
import { createUserSettingsService } from "./user-settings";
import { createWorkspaceCapabilityService } from "./workspace-capabilities";
import { createWorkspaceControlService } from "./workspace-control";
import { createXAccountIngress } from "./x-account-ingress";

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
  ...(process.env.VERCEL_AI_GATEWAY_API_KEY?.trim()
    ? { gatewayApiKey: process.env.VERCEL_AI_GATEWAY_API_KEY.trim() }
    : {}),
});
const knowledgeRepository = new PostgresKnowledgeRepository(database.db);
const knowledge = new KnowledgeApplicationService(knowledgeRepository);
const brainSources = new GoatBrainSourceApplicationService(database.db);
const brainImports = new GoatBrainImportApplicationService(database.db, brainSources);
const browserProfiles = new GoatBrowserProfileApplicationService(database.db);
const skillImports = new SkillImportApplicationService(
  knowledgeRepository,
  createGoatSkillImportResolver(),
);
const notifier = new PostgresRunEventNotifier(database.pool);
const presentation = createPresentationStream();
const readModels = createElectricReadModels();
const authenticate = createWorkOsApiAuthenticator(execute);
const identityVerifier = createWorkOsApiIdentityVerifier();
const runnerClient = createRunnerClient();
const stripe = getGoatStripe();
const workos = createWorkOSClient();
const app = createApiApp({
  chat,
  tasks,
  workflows: automations.workflows,
  schedules: automations.schedules,
  knowledge,
  brainSources,
  brainImports,
  browserProfiles,
  skillImports,
  brainAssets: createBrainAssetService({ db: database.db, knowledge }),
  chatResources: createChatResourceService({ db: database.db }),
  chatTitles: createChatTitleService({
    db: database.db,
    ...(process.env.VERCEL_AI_GATEWAY_API_KEY
      ? { apiKey: process.env.VERCEL_AI_GATEWAY_API_KEY }
      : {}),
  }),
  captureChatMessage: (event) =>
    captureGoatServerEvent(
      "chat_message_sent",
      event.actor.userId,
      {
        workspace_id: event.actor.workspaceId,
        session_id: event.conversationId,
        is_first_message: event.firstMessage,
        engine: event.engine,
        usage_source: event.engine === "opencompany" ? "owned_platform" : "external_harness",
        model: event.model,
        message_length: event.messageLength,
        selection_mode: event.selectionMode,
        ...(event.routing
          ? {
              routing_tier: event.routing.tier,
              routing_reason: event.routing.reason,
              routing_outcome: event.routing.outcome,
              routing_duration_ms: event.routing.durationMs,
            }
          : {}),
      },
      { workspaceId: event.actor.workspaceId },
    ),
  brainControl: createBrainControlService({ db: database.db }),
  attachments: createAttachmentUploadService({ repository: attachmentRepository }),
  userSettings: createUserSettingsService({ db: database.db }),
  feedback: createFeedbackService({ db: database.db }),
  repoConfigs: createRepoConfigService({ db: database.db }),
  integrationAccounts: createIntegrationAccountService({ db: database.db, runner: runnerClient }),
  billing: createGoatBillingApplicationService({
    db: database.db,
    stripe,
    appUrl: getGoatAppUrl(),
  }),
  // The engine-auth device/browser flows run through the runner's internal
  // control routes; the client resolves RUNNER_INTERNAL_URL/RUNNER_PUBLIC_URL
  // and RUNNER_INTERNAL_TOKEN per call.
  engineAuth: createEngineAuthService({ db: database.db, runner: runnerClient }),
  engineSessions: createEngineSessionService({ db: database.db, runner: runnerClient }),
  workspaceCapabilities: createWorkspaceCapabilityService({ db: database.db }),
  workspaceControl: createWorkspaceControlService({ db: database.db, workos }),
  identity: createIdentityService({ db: database.db, workos, stripe }),
  onboarding: createOnboardingService({ db: database.db, workos }),
  onboardingEmails: createOnboardingEmailService({ db: database.db }),
  authenticate,
  identify: identityVerifier,
  ...(process.env.CRON_SECRET ? { emailLifecycleInternalSecret: process.env.CRON_SECRET } : {}),
  browserOrigins: parseBrowserOrigins(process.env.API_BROWSER_ORIGINS),
  githubIngress: createGitHubIngress({ db: database.db, identify: identityVerifier }),
  googleIngress: createGoogleIngress({ db: database.db, identify: identityVerifier }),
  slackIngress: createSlackIngress({ db: database.db, identify: identityVerifier }),
  linearIngress: createLinearIngress({ db: database.db, identify: identityVerifier }),
  hubspotIngress: createHubspotIngress({ db: database.db, identify: identityVerifier }),
  attioIngress: createAttioIngress({ db: database.db }),
  jamieIngress: createJamieIngress({ db: database.db }),
  mcpOAuthIngress: createMcpOAuthIngress({ db: database.db, identify: identityVerifier }),
  xAccountIngress: createXAccountIngress({ db: database.db, identify: identityVerifier }),
  slackBotIngress: createSlackBotIngress({
    db: database.db,
    identify: identityVerifier,
    runner: runnerClient,
  }),
  stripeIngress: createStripeIngress({
    db: database.db,
    stripe,
    webhookSecret: getGoatStripeWebhookSecret(),
  }),
  billingReconcile: createBillingReconcileService({
    db: database.db,
    stripe,
    secret: process.env.CRON_SECRET?.trim() ?? "",
  }),
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

function createWorkOSClient() {
  const apiKey = process.env.WORKOS_API_KEY?.trim();
  const clientId = process.env.WORKOS_CLIENT_ID?.trim();
  if (!apiKey || !clientId) throw new Error("WORKOS_API_KEY and WORKOS_CLIENT_ID are required.");
  return new WorkOS(apiKey, { clientId });
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
