import { ExpiringOAuthReauthRequired } from "@opencompany/agent/integrations/expiring-oauth-access-token";
import { isGitHubAppWebhookConfigured } from "@opencompany/agent/integrations/github-app-events";
import {
  GitHubUserAccessAuthError,
  GitHubUserAccessRateLimitError,
  isGitHubUserIntegrationConfigured,
  listGitHubUserInstallationRepositories,
  listGitHubUserInstallations,
} from "@opencompany/agent/integrations/github-user";
import {
  type Actor,
  COMPANY_GITHUB_EVENTS,
  COMPANY_GITHUB_INTEGRATION_PROVIDER,
  COMPANY_GITHUB_PROVIDER,
  type WorkflowEventTrigger,
} from "@opencompany/core";
import {
  type CompanyGitHubInstallation,
  connectCompanyGitHubInstallation,
  disconnectCompanyGitHubInstallation,
  listCompanyGitHubInstallations,
} from "@opencompany/db/company-github";
import type { WorkflowSqlExecute } from "@opencompany/db/workflow-repository";
import { createLogger } from "@opencompany/observability";
import type {
  CompanyGitHubAvailableInstallationsDto,
  CompanyGitHubPluginDto,
} from "@opencompany/protocol/schemas";
import { sql } from "drizzle-orm";
import { ApiError } from "./errors";

const logger = createLogger({ service: "opencompany-api", runtime: "company-github" });
const ADMIN_ONLY_MESSAGE = "Only workspace admins can manage company plugins.";

type DbLike = any;

export type CompanyGitHubService = {
  get(actor: Actor): Promise<CompanyGitHubPluginDto>;
  listAvailableInstallations(actor: Actor): Promise<CompanyGitHubAvailableInstallationsDto>;
  link(actor: Actor, installationId: string): Promise<CompanyGitHubPluginDto>;
  unlink(actor: Actor, integrationId: string): Promise<CompanyGitHubPluginDto>;
};

// The company GitHub plugin links installations of the same GitHub App members already install for
// "GitHub as you". Linking needs no new GitHub authorization: the admin proves they can reach the
// installation with their own GitHub connection, and signed App webhooks do the rest.
export function createCompanyGitHubService(input: {
  db: DbLike;
  listInstallations?: typeof listGitHubUserInstallations;
}): CompanyGitHubService {
  const { db } = input;
  const listInstallations = input.listInstallations ?? listGitHubUserInstallations;

  async function plugin(actor: Actor): Promise<CompanyGitHubPluginDto> {
    const installations = await listCompanyGitHubInstallations(actor.workspaceId, db);
    return {
      configured: isGitHubUserIntegrationConfigured() && isGitHubAppWebhookConfigured(),
      canManage: actor.role === "admin",
      installations: installations.map(installationDto),
      events: COMPANY_GITHUB_EVENTS.map((event) => ({
        ...event,
        filters: event.filters.map((filter) => ({ ...filter })),
      })),
    };
  }

  async function adminInstallations(actor: Actor) {
    try {
      return await listInstallations({ userWorkosId: actor.userId, db });
    } catch (error) {
      if (
        error instanceof GitHubUserAccessAuthError ||
        error instanceof ExpiringOAuthReauthRequired
      ) {
        return null;
      }
      if (error instanceof GitHubUserAccessRateLimitError) {
        throw new ApiError(
          429,
          "rate_limited",
          "GitHub is rate limiting requests. Try again shortly.",
          true,
        );
      }
      logger.warn("GitHub installations could not be listed", {
        event: "opencompany.company_github_installations_failed",
        error_message: error instanceof Error ? error.message : String(error),
      });
      throw new ApiError(503, "unavailable", "GitHub could not be reached. Try again.", true);
    }
  }

  return {
    get: plugin,

    async listAvailableInstallations(actor) {
      requireAdmin(actor);
      const installations = await adminInstallations(actor);
      return {
        installations:
          installations?.map((installation) => ({
            installationId: installation.id,
            accountLogin: installation.account.login,
            accountType: installation.account.type,
            avatarUrl: installation.account.avatarUrl,
            suspended: installation.suspendedAt !== null,
          })) ?? null,
      };
    },

    async link(actor, installationId) {
      requireAdmin(actor);
      const installations = await adminInstallations(actor);
      if (!installations) {
        throw new ApiError(
          409,
          "conflict",
          "Connect GitHub as you first, so opencompany can see the organizations you manage.",
        );
      }
      // The installation id comes from the browser; only one the admin's own GitHub account can
      // reach may be linked, so nobody can subscribe a workspace to another organization's events.
      const installation = installations.find((candidate) => candidate.id === installationId);
      if (!installation) {
        throw new ApiError(404, "not_found", "Your GitHub account can't access that installation.");
      }
      if (installation.suspendedAt) {
        throw new ApiError(409, "conflict", "This GitHub installation is suspended on GitHub.");
      }
      await connectCompanyGitHubInstallation({
        workspaceId: actor.workspaceId,
        userWorkosId: actor.userId,
        installationId: installation.id,
        accountLogin: installation.account.login,
        accountType: installation.account.type,
        db,
      });
      return plugin(actor);
    },

    async unlink(actor, integrationId) {
      requireAdmin(actor);
      const removed = await disconnectCompanyGitHubInstallation({
        workspaceId: actor.workspaceId,
        integrationId,
        db,
      });
      if (!removed) throw new ApiError(404, "not_found", "That GitHub account is not linked.");
      return plugin(actor);
    },
  };
}

// The linked installation is the workspace's, but which repository a trigger listens to is the
// author's choice, bounded by their own GitHub access. Without this a member could route events
// from a private repository they cannot open into their own runs. The check needs GitHub, so it
// runs only when a trigger's author, account, or repository actually changed.
export async function validateCompanyGitHubTriggerAccess(input: {
  execute: WorkflowSqlExecute;
  actor: Actor;
  trigger: WorkflowEventTrigger & { id?: string };
  listRepositories?: typeof listGitHubUserInstallationRepositories;
}): Promise<string | null> {
  if (input.trigger.provider !== COMPANY_GITHUB_PROVIDER) return null;
  const repositoryId = input.trigger.filters.repository?.id;
  if (!repositoryId) return null;
  if (input.trigger.id && (await unchangedTrigger(input.execute, input.actor, input.trigger))) {
    return null;
  }
  const [integration] = rows<{ installationId: string }>(
    await input.execute(sql`
      SELECT external_id AS "installationId"
      FROM goat.integrations
      WHERE id = ${input.trigger.integrationId}
        AND workspace_id = ${input.actor.workspaceId}
        AND provider = ${COMPANY_GITHUB_INTEGRATION_PROVIDER}
      LIMIT 1
    `),
  );
  if (!integration) return "Event triggers need an account your workspace admin connected.";
  try {
    const repositories = await (input.listRepositories ?? listGitHubUserInstallationRepositories)({
      userWorkosId: input.actor.userId,
      installationId: integration.installationId,
    });
    return repositories.some((repository) => repository.id === repositoryId)
      ? null
      : "Choose a repository your GitHub account can access.";
  } catch (error) {
    if (
      error instanceof GitHubUserAccessAuthError ||
      error instanceof ExpiringOAuthReauthRequired
    ) {
      return "Connect GitHub as you in Plugins to use GitHub events.";
    }
    logger.warn("GitHub repository access could not be confirmed", {
      event: "opencompany.company_github_trigger_access_failed",
      error_message: error instanceof Error ? error.message : String(error),
    });
    return "GitHub could not confirm access to this repository. Try again.";
  }
}

async function unchangedTrigger(
  execute: WorkflowSqlExecute,
  actor: Actor,
  trigger: WorkflowEventTrigger & { id?: string },
) {
  const found = rows<{ id: string }>(
    await execute(sql`
      SELECT workflow.id
      FROM goat.workflows AS workflow
      CROSS JOIN LATERAL jsonb_array_elements(workflow.automation_triggers) AS stored(value)
      WHERE workflow.workspace_id = ${actor.workspaceId}
        AND stored.value->>'id' = ${trigger.id}
        AND stored.value->>'type' = 'event'
        AND stored.value->>'provider' = ${trigger.provider}
        AND stored.value->>'userWorkosId' = ${actor.userId}
        AND stored.value->>'integrationId' = ${trigger.integrationId}
        AND stored.value->'filters'->'repository'->>'id' = ${trigger.filters.repository?.id ?? null}
      LIMIT 1
    `),
  );
  return found.length > 0;
}

function installationDto(installation: CompanyGitHubInstallation) {
  return {
    integrationId: installation.integrationId,
    installationId: installation.installationId,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    status: installation.status,
    statusReason: installation.statusReason,
    linkedAt: installation.linkedAt.toISOString(),
  };
}

function requireAdmin(actor: Actor) {
  if (actor.role !== "admin") throw new ApiError(403, "forbidden", ADMIN_ONLY_MESSAGE);
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
