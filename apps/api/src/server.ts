import { serve } from "@hono/node-server";
import { getAppUrl } from "@opencompany/agent/app-url";
import { resolvePersistedAutoModelRouting } from "@opencompany/agent/application/persisted-auto-model-routing";
import {
  BrainImportApplicationService,
  WikiImportApplicationService,
} from "@opencompany/agent/brain-imports";
import { BrainSourceApplicationService } from "@opencompany/agent/brain-sources";
import { BrowserProfileApplicationService } from "@opencompany/agent/browser-profiles/service";
import { createGmailMcpService } from "@opencompany/agent/integrations/gmail-mcp-server";
import { createGoogleCalendarMcpService } from "@opencompany/agent/integrations/google-calendar-mcp-server";
import { getAvailableHarnessTools } from "@opencompany/agent/integrations/google-data";
import { createGoogleDriveMcpService } from "@opencompany/agent/integrations/google-drive-mcp-server";
import { createMcpService } from "@opencompany/agent/mcp-http";
import {
  createPluginGatewayLifecycle,
  refreshPluginGatewayRegistrationsForWorkspaces,
} from "@opencompany/agent/plugin-gateway";
import { createPluginImportResolver } from "@opencompany/agent/plugin-import";
import { createSkillImportResolver } from "@opencompany/agent/skill-import";
import { createWorkspaceSkillArtifact } from "@opencompany/agent-runtime";
import { captureProductServerEvent } from "@opencompany/analytics/product/server";
import { createBillingApplicationService } from "@opencompany/billing/application-service";
import { getStripe, getStripeWebhookSecret } from "@opencompany/billing/stripe";
import { RedisChatPresentationStream } from "@opencompany/chat-presentation";
import {
  ChatApplicationService,
  KnowledgeApplicationService,
  PluginImportApplicationService,
  SkillImportApplicationService,
  TaskApplicationService,
  WikiCommandApplicationService,
} from "@opencompany/core";
import {
  PostgresChatAttachmentRepository,
  PostgresChatRepository,
} from "@opencompany/db/chat-repository";
import { PostgresKnowledgeRepository } from "@opencompany/db/knowledge-repository";
import { PostgresPluginRepository } from "@opencompany/db/plugin-repository";
import { createPooledDb } from "@opencompany/db/pool";
import { PostgresSkillBundleRepository } from "@opencompany/db/skill-bundle-repository";
import { PostgresTaskRepository } from "@opencompany/db/task-repository";
import { getWikiAccessForUser } from "@opencompany/db/wiki";
import { PostgresWikiCommandRepository } from "@opencompany/db/wiki-command-repository";
import { createLogger } from "@opencompany/observability";
import { registerNodeObservability, shutdownNodeObservability } from "@opencompany/telemetry/node";
import { WorkOS } from "@workos-inc/node";
import { createApiApp } from "./app";
import { createAttachmentUploadService } from "./attachments";
import { createAttioIngress } from "./attio-ingress";
import {
  createWorkOsApiAuthenticator,
  createWorkOsApiIdentityVerifier,
  resolveWikiServiceActor,
} from "./auth";
import { createAutomationServices } from "./automations";
import { createBillingReconcileService } from "./billing-reconcile";
import { createBrainAssetService } from "./brain-assets";
import { createBrainControlService } from "./brain-control";
import { parseBrowserOrigins } from "./browser-origins";
import { createChatResourceService } from "./chat-resources";
import { createChatTitleService } from "./chat-title";
import { ElectricReadModelProxy, parseElectricAuthMode } from "./electric-read-models";
import { createEngineAuthService } from "./engine-auth";
import { createEngineSessionService } from "./engine-sessions";
import { createFeedbackService } from "./feedback";
import { createGitHubUserIngress } from "./github-user-ingress";
import { createGoogleIngress } from "./google-ingress";
import { createHubspotIngress } from "./hubspot-ingress";
import { createIdentityService } from "./identity";
import { createIntegrationAccountService } from "./integration-accounts";
import { createLinearIngress } from "./linear-ingress";
import { createMcpOAuthIngress } from "./mcp-oauth-ingress";
import { PostgresMessagePresentationService } from "./message-presentations";
import { createOnboardingService } from "./onboarding";
import { createOnboardingEmailService } from "./onboarding-emails";
import { createRepoConfigService } from "./repo-configs";
import { PostgresRunEventNotifier } from "./run-event-notifier";
import { createRunnerClient } from "./runner-client";
import { closeHttpServer, createDrainAwareFetch } from "./server-lifecycle";
import { resolveApiPort } from "./server-port";
import { createSlackBotIngress } from "./slack-bot-ingress";
import { createSlackBotSettingsService } from "./slack-bot-settings";
import { createSlackIngress } from "./slack-ingress";
import { createStripeIngress } from "./stripe-ingress";
import { createUserSettingsService } from "./user-settings";
import { createWikiSourceService } from "./wiki-sources";
import { createWorkspaceCapabilityService } from "./workspace-capabilities";
import { createWorkspaceControlService } from "./workspace-control";
import { createXAccountIngress } from "./x-account-ingress";

const logger = createLogger({ service: "opencompany-api", runtime: "server" });
registerNodeObservability({ serviceName: "opencompany-api" });
const shutdownController = new AbortController();

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
      tools: await getAvailableHarnessTools(actor.userId),
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
const wikiCommands = new WikiCommandApplicationService(
  new PostgresWikiCommandRepository(database.db),
);
const wikiSources = createWikiSourceService({ db: database.db });
const brainSources = new BrainSourceApplicationService(database.db);
const brainImports = new BrainImportApplicationService(database.db, brainSources);
const wikiImports = new WikiImportApplicationService(database.db, wikiSources);
const browserProfiles = new BrowserProfileApplicationService(database.db);
const skillImports = new SkillImportApplicationService(
  new PostgresSkillBundleRepository(database.db),
  createSkillImportResolver(),
  { create: createWorkspaceSkillArtifact },
);
const pluginImports = new PluginImportApplicationService(
  new PostgresPluginRepository(database.db),
  createPluginImportResolver(),
  createPluginGatewayLifecycle({ db: database.db }),
);
const notifier = new PostgresRunEventNotifier(database.pool);
const presentation = createPresentationStream();
const readModels = createElectricReadModels();
const authenticate = createWorkOsApiAuthenticator(execute);
const identityVerifier = createWorkOsApiIdentityVerifier();
const runnerClient = createRunnerClient();
const stripe = getStripe();
const workos = createWorkOSClient();
const app = createApiApp({
  chat,
  tasks,
  workflows: automations.workflows,
  schedules: automations.schedules,
  knowledge,
  wikiCommands,
  resolveWikiServiceActor: (actorInput) => resolveWikiServiceActor(execute, actorInput),
  ...(process.env.API_INTERNAL_TOKEN?.trim()
    ? { wikiCommandsInternalSecret: process.env.API_INTERNAL_TOKEN.trim() }
    : {}),
  wikiSources,
  brainSources,
  brainImports,
  wikiImports,
  browserProfiles,
  skillImports,
  pluginImports,
  brainAssets: createBrainAssetService({ db: database.db, knowledge }),
  chatResources: createChatResourceService({ db: database.db }),
  messagePresentations: new PostgresMessagePresentationService(execute),
  chatTitles: createChatTitleService({
    db: database.db,
    ...(process.env.VERCEL_AI_GATEWAY_API_KEY
      ? { apiKey: process.env.VERCEL_AI_GATEWAY_API_KEY }
      : {}),
  }),
  captureChatMessage: (event) =>
    captureProductServerEvent(
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
  integrationAccounts: createIntegrationAccountService({
    db: database.db,
    runner: runnerClient,
    refreshRenderPluginRegistrations: ({ userWorkosId, workspaceId }) =>
      refreshPluginGatewayRegistrationsForWorkspaces({
        db: database.db,
        userWorkosId,
        workspaceIds: [workspaceId],
        connectionProvider: "render",
      }),
    refreshStripePluginRegistrations: ({ userWorkosId, workspaceId }) =>
      refreshPluginGatewayRegistrationsForWorkspaces({
        db: database.db,
        userWorkosId,
        workspaceIds: [workspaceId],
        connectionProvider: "stripe",
      }),
  }),
  slackBotSettings: createSlackBotSettingsService({ db: database.db }),
  mcp: createMcpService({
    // The API-hosted MCP tool runs the same command service in-process — no
    // loopback HTTP. The gateway resolves wiki access and reauthorizes the actor
    // from Postgres before executing.
    wiki: {
      getAccess: (userWorkosId) => getWikiAccessForUser(userWorkosId, database.db),
      execute: async ({ userWorkosId, workspaceId, command, idempotencyKey }) => {
        const actor = await resolveWikiServiceActor(execute, { userWorkosId, workspaceId });
        return wikiCommands.execute({ actor, command, idempotencyKey });
      },
    },
    ...(process.env.VERCEL_AI_GATEWAY_API_KEY
      ? { gatewayApiKey: process.env.VERCEL_AI_GATEWAY_API_KEY }
      : {}),
  }),
  ...(process.env.API_INTERNAL_TOKEN?.trim()
    ? {
        gmailMcp: createGmailMcpService({
          db: database.db,
          internalSecret: process.env.API_INTERNAL_TOKEN.trim(),
        }),
        googleCalendarMcp: createGoogleCalendarMcpService({
          db: database.db,
          internalSecret: process.env.API_INTERNAL_TOKEN.trim(),
        }),
        googleDriveMcp: createGoogleDriveMcpService({
          db: database.db,
          internalSecret: process.env.API_INTERNAL_TOKEN.trim(),
        }),
      }
    : {}),
  billing: createBillingApplicationService({
    db: database.db,
    stripe,
    appUrl: getAppUrl(),
  }),
  // The engine-auth device/browser flows run through the runner's internal
  // control routes; the client resolves RUNNER_INTERNAL_URL/RUNNER_PUBLIC_URL
  // and RUNNER_INTERNAL_TOKEN per call.
  engineAuth: createEngineAuthService({
    db: database.db,
    runner: runnerClient,
    refreshPluginRegistrations: ({ provider, userWorkosId, workspaceIds }) =>
      refreshPluginGatewayRegistrationsForWorkspaces({
        db: database.db,
        userWorkosId,
        workspaceIds,
        connectionProvider: provider,
      }),
  }),
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
  githubUserIngress: createGitHubUserIngress({
    db: database.db,
    identify: identityVerifier,
    refreshPluginRegistrations: ({ userWorkosId, workspaceIds }) =>
      refreshPluginGatewayRegistrationsForWorkspaces({
        db: database.db,
        userWorkosId,
        workspaceIds,
        // Registrations persist the Plugin package name; the gateway binding
        // maps package "github" to the personal github_user integration.
        connectionProvider: "github",
      }),
  }),
  googleIngress: createGoogleIngress({
    db: database.db,
    identify: identityVerifier,
    refreshPluginRegistrations: ({ provider, userWorkosId, workspaceIds }) =>
      refreshPluginGatewayRegistrationsForWorkspaces({
        db: database.db,
        userWorkosId,
        workspaceIds,
        connectionProvider:
          provider === "gmail"
            ? "gmail"
            : provider === "google_drive"
              ? "google-drive"
              : "google-calendar",
      }),
  }),
  slackIngress: createSlackIngress({
    db: database.db,
    identify: identityVerifier,
    refreshPluginRegistrations: ({ userWorkosId, workspaceIds }) =>
      refreshPluginGatewayRegistrationsForWorkspaces({
        db: database.db,
        userWorkosId,
        workspaceIds,
        connectionProvider: "slack",
      }),
  }),
  linearIngress: createLinearIngress({ db: database.db, identify: identityVerifier }),
  hubspotIngress: createHubspotIngress({ db: database.db, identify: identityVerifier }),
  attioIngress: createAttioIngress({ db: database.db }),
  mcpOAuthIngress: createMcpOAuthIngress({
    db: database.db,
    identify: identityVerifier,
    refreshPluginRegistrations: ({ provider, userWorkosId, workspaceIds }) =>
      refreshPluginGatewayRegistrationsForWorkspaces({
        db: database.db,
        userWorkosId,
        workspaceIds,
        connectionProvider: provider,
      }),
  }),
  xAccountIngress: createXAccountIngress({
    db: database.db,
    identify: identityVerifier,
    refreshPluginRegistrations: ({ userWorkosId, workspaceIds }) =>
      refreshPluginGatewayRegistrationsForWorkspaces({
        db: database.db,
        userWorkosId,
        workspaceIds,
        connectionProvider: "x",
      }),
  }),
  slackBotIngress: createSlackBotIngress({
    db: database.db,
    identify: identityVerifier,
    runner: runnerClient,
  }),
  stripeIngress: createStripeIngress({
    db: database.db,
    stripe,
    webhookSecret: getStripeWebhookSecret(),
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
  shutdownSignal: shutdownController.signal,
  ...(readModels ? { readModels } : {}),
});
const port = resolveApiPort(process.env);
const server = serve({ fetch: createDrainAwareFetch(app.fetch, shutdownController.signal), port });
logger.info("API server started", { event: "opencompany.api_started", port });

let closing = false;
async function close(signal: string) {
  if (closing) return;
  closing = true;
  logger.info("API server stopping", { event: "opencompany.api_stopping", signal });
  shutdownController.abort();
  await closeHttpServer(server);
  await notifier.close();
  await presentation?.close();
  await database.close();
  logger.info("API server stopped", { event: "opencompany.api_stopped", signal });
  await shutdownNodeObservability();
}

function handleSignal(signal: "SIGINT" | "SIGTERM") {
  void close(signal).then(
    () => process.exit(0),
    (error) => {
      logger.error("API server shutdown failed", {
        event: "opencompany.api_shutdown_failed",
        signal,
        error,
      });
      process.exit(1);
    },
  );
}

process.once("SIGINT", () => handleSignal("SIGINT"));
process.once("SIGTERM", () => handleSignal("SIGTERM"));

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

function createElectricReadModels() {
  const electricUrl = process.env.ELECTRIC_URL?.trim();
  if (!electricUrl) return null;
  const authMode = parseElectricAuthMode(process.env.ELECTRIC_AUTH_MODE);
  return new ElectricReadModelProxy({
    electricUrl,
    ...(authMode ? { authMode } : {}),
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
