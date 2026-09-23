import { createHash } from "node:crypto";
import {
  isGitHubAppWebhookConfigured,
  parseGitHubAppWebhook,
  verifyGitHubWebhookSignature,
} from "@opencompany/agent/integrations/github-app-events";
import { COMPANY_GITHUB_PROVIDER } from "@opencompany/core";
import {
  listGitHubAppInstallationIntegrations,
  markGitHubAppInstallationRemoved,
} from "@opencompany/db/company-github";
import {
  enqueueWorkflowEventRuns,
  listCompanyWorkflowEventTriggerRoutes,
  workflowEventFiltersMatch,
} from "@opencompany/db/workflow-event-routes";
import { createLogger } from "@opencompany/observability";

const logger = createLogger({ service: "opencompany-api", runtime: "github-app-ingress" });

type DbLike = any;

export type GitHubAppIngressService = {
  webhook(request: Request): Promise<Response>;
};

// Signed webhooks from the GitHub App, routed to the event triggers of every workspace that linked
// the delivering installation as its company GitHub plugin.
export function createGitHubAppIngress(input: { db: DbLike }): GitHubAppIngressService {
  return { webhook: (request) => handleWebhook(input.db, request) };
}

async function handleWebhook(db: DbLike, request: Request): Promise<Response> {
  if (!isGitHubAppWebhookConfigured()) {
    return Response.json({ error: "GitHub webhooks are not configured." }, { status: 503 });
  }
  const rawBody = await request.text();
  if (
    !verifyGitHubWebhookSignature({
      rawBody,
      signature: request.headers.get("x-hub-signature-256"),
    })
  ) {
    return Response.json({ error: "Invalid GitHub signature." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const eventName = request.headers.get("x-github-event");
  const parsed = parseGitHubAppWebhook({ eventName, payload });
  // A verified delivery is only acknowledged after its durable writes finish, so a failure is
  // visible as a failed delivery GitHub can redeliver; every write downstream is idempotent.
  try {
    if (parsed.kind === "ignored") return Response.json({ ok: true, ignored: parsed.reason });
    if (parsed.kind === "installation_removed") {
      await markGitHubAppInstallationRemoved({ installationId: parsed.installationId, db });
      return Response.json({ ok: true });
    }

    const integrations = await listGitHubAppInstallationIntegrations(parsed.installationId, db);
    const routes = await listCompanyWorkflowEventTriggerRoutes(
      { provider: COMPANY_GITHUB_PROVIDER, integrations },
      db,
    );
    const matched = routes.filter(
      (route) =>
        route.event === parsed.event &&
        workflowEventFiltersMatch(route, { repository: parsed.repositoryId }),
    );
    const workflowRuns = await enqueueWorkflowEventRuns(
      {
        routes: matched,
        deliveryId:
          request.headers.get("x-github-delivery")?.trim() ||
          createHash("sha256").update(rawBody).digest("hex"),
        eventAt: parsed.occurredAt ?? new Date(),
        context: parsed.context,
      },
      db,
    );
    return Response.json(
      workflowRuns > 0 ? { ok: true, workflowRuns } : { ok: true, dropped: true },
    );
  } catch (error) {
    logger.error("Failed to process GitHub App event", {
      event: "opencompany.github_app_event_failed",
      github_event: eventName,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { error: "GitHub event processing failed; redeliver this event." },
      { status: 503 },
    );
  }
}
