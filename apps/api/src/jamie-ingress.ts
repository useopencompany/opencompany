import {
  loadJamieWebhookContext,
  loadJamieWebhookContextForApiKey,
} from "@opencompany/agent/integrations/jamie";
import { JAMIE_WEBHOOK_SECRET_HEADER } from "@opencompany/agent/integrations/jamie-constants";
import { handleJamieWebhookDelivery } from "@opencompany/agent/integrations/jamie-webhook";
import { createLogger } from "@opencompany/observability";

type DbLike = any;

const logger = createLogger({ service: "opencompany-api", runtime: "jamie-ingress" });

// Provider ingress composition for the Jamie meeting-notes webhook. Connect is
// API-key based (a web Server Action), so there is no OAuth surface here. The
// global path resolves the integration from the delivery's API key; the
// per-integration path is the pre-key legacy URL shape.
export type JamieIngressService = {
  webhook(request: Request): Promise<Response>;
  webhookForIntegration(integrationId: string, request: Request): Promise<Response>;
};

export function createJamieIngress(input: {
  db: DbLike;
  wakeWikiIngest?: () => Promise<unknown>;
}): JamieIngressService {
  const wakeWikiIngest = input.wakeWikiIngest
    ? () => {
        input.wakeWikiIngest?.().catch((error) => {
          logger.warn("Wiki ingest worker wake failed after Jamie enqueue", {
            event: "opencompany.jamie_wiki_ingest_wake_failed",
            error,
          });
        });
      }
    : undefined;
  return {
    webhook: async (request) => {
      const webhookContext = await loadJamieWebhookContextForApiKey(
        request.headers.get(JAMIE_WEBHOOK_SECRET_HEADER),
        input.db,
      );
      return handleJamieWebhookDelivery({
        request,
        webhookContext,
        missingContextStatus: 401,
        db: input.db,
        ...(wakeWikiIngest ? { wakeWikiIngest } : {}),
      });
    },
    webhookForIntegration: async (integrationId, request) => {
      const webhookContext = await loadJamieWebhookContext(integrationId, input.db);
      return handleJamieWebhookDelivery({
        request,
        webhookContext,
        missingContextStatus: 404,
        db: input.db,
        ...(wakeWikiIngest ? { wakeWikiIngest } : {}),
      });
    },
  };
}
