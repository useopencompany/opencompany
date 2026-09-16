// Lists the resources of one connected account so a workflow event trigger can
// offer real filter options (Linear teams, Gmail labels, Granola folders).
//
// This used to live on the Brain source service, because Brain sources and
// workflow triggers picked from the same lists. Brain is gone; workflow filters
// are the only caller left, so the read is gated on workflow:read alone.

import {
  type Actor,
  actorHasPermission,
  CoreError,
  WORKFLOW_READ_PERMISSION,
} from "@opencompany/core";
import { type GmailLabelRef, gmailFilterLabelOptions } from "@opencompany/db/gmail";
import { GRANOLA_CREDENTIAL_KIND } from "@opencompany/db/granola";
import { loadIntegrationCredential, markIntegrationStatus } from "@opencompany/db/integrations";
import { LINEAR_MCP_EXTERNAL_ID, type LinearTeamRef } from "@opencompany/db/linear";
import {
  type IntegrationProvider,
  type IntegrationStatus,
  integrations,
  isWorkspaceOwnedIntegrationProvider,
} from "@opencompany/db/product-schema";
import { and, eq, isNull, ne, type SQL } from "drizzle-orm";
import { listGmailLabels, loadOwnGmailAccount } from "./integrations/gmail-source";
import { GoogleAccessAuthError } from "./integrations/google-access-token";
import { listGranolaFolders } from "./integrations/granola";
import { GRANOLA_MCP_EXTERNAL_ID } from "./integrations/granola-mcp";
import { isLinearAuthenticationError, linearGraphqlRequest } from "./integrations/linear-api";
import { getLinearIngestAccessToken, LinearIngestAuthError } from "./integrations/linear-ingest";

type DbLike = any;

export type IntegrationResourceOptionsCommand =
  | { provider: "linear"; includeTriageStateIds?: boolean }
  | { provider: "granola" }
  | { provider: "gmail" };

export type IntegrationResourceOptions =
  | { provider: "linear"; teams: LinearTeamRef[]; partial: boolean }
  | {
      provider: "granola";
      folders: Array<{ id: string; name: string; parentFolderId: string | null }>;
      partial: boolean;
    }
  | { provider: "gmail"; labels: GmailLabelRef[] };

type IntegrationRow = {
  id: string;
  provider: IntegrationProvider;
  userWorkosId: string;
  workspaceId: string | null;
  externalId: string;
  status: IntegrationStatus;
};

export class IntegrationResourceOptionsService {
  constructor(private readonly db: DbLike) {}

  async listOptions(
    actor: Actor,
    integrationId: string,
    command: IntegrationResourceOptionsCommand,
  ): Promise<IntegrationResourceOptions> {
    if (!actorHasPermission(actor, WORKFLOW_READ_PERMISSION)) {
      throw new CoreError("forbidden", "Workflow permission is required.");
    }
    const integration = resourceId(integrationId, "integrationId");
    switch (command.provider) {
      case "linear":
        return this.listLinearOptions(actor, integration, command.includeTriageStateIds ?? false);
      case "granola":
        return this.listGranolaOptions(actor, integration);
      case "gmail":
        return this.listGmailOptions(actor, integration);
    }
  }

  private async listGranolaOptions(
    actor: Actor,
    integrationId: string,
  ): Promise<Extract<IntegrationResourceOptions, { provider: "granola" }>> {
    const integration = await this.loadIntegration(actor, integrationId, "granola");
    if (!integration || integration.status !== "connected") {
      throw new CoreError("conflict", "Save a Granola API key in your settings first.");
    }
    const credential = await loadIntegrationCredential({
      userWorkosId: actor.userId,
      integrationId,
      provider: "granola",
      kind: GRANOLA_CREDENTIAL_KIND,
      db: this.db,
    }).catch(() => null);
    const apiKey = credential?.payload.apiKey;
    if (typeof apiKey !== "string" || !apiKey) {
      throw new CoreError("conflict", "Save a Granola API key in your settings first.");
    }
    const result = await listGranolaFolders({ apiKey });
    if (!result.ok) {
      if (result.reason !== "unauthorized") throw new CoreError("unavailable", result.error);
      // Surface a revoked key on the plugin page the author is sent to, not just in this response.
      await markIntegrationStatus({
        userWorkosId: actor.userId,
        integrationId,
        provider: "granola",
        status: "needs_reauth",
        statusReason: "Granola rejected the saved API key. Save a new key.",
        db: this.db,
      });
      throw new CoreError("conflict", result.error);
    }
    return {
      provider: "granola",
      folders: result.folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        parentFolderId: folder.parentFolderId,
      })),
      partial: result.partial,
    };
  }

  private async listLinearOptions(
    actor: Actor,
    integrationId: string,
    includeTriageStateIds: boolean,
  ): Promise<Extract<IntegrationResourceOptions, { provider: "linear" }>> {
    const integration = await this.loadIntegration(actor, integrationId, "linear");
    if (!integration || integration.status !== "connected") {
      throw new CoreError("conflict", "Connect Linear in your settings first.");
    }
    const token = await this.linearAccessToken(actor, integrationId);
    const teams: LinearTeamRef[] = [];
    let cursor: string | undefined;
    let partial = false;
    let loadedTeamPage = false;
    do {
      try {
        const page = await this.linearOptionsRequest<{
          teams?: {
            nodes?: Array<{ id?: string; key?: string; name?: string }>;
            pageInfo?: { hasNextPage?: boolean; endCursor?: string };
          };
        }>(actor, integrationId, {
          token,
          query: `query LinearTeams($after: String) {
              teams(first: 100, after: $after) {
                nodes { id key name }
                pageInfo { hasNextPage endCursor }
              }
            }`,
          variables: cursor ? { after: cursor } : {},
        });
        if (!page.teams) throw new Error("Linear GraphQL returned no team data.");
        loadedTeamPage = true;
        for (const team of page.teams.nodes ?? []) {
          if (!team.id) continue;
          teams.push({
            id: team.id,
            name: team.name?.trim() || team.key?.trim() || team.id,
            ...(team.key?.trim() ? { key: team.key.trim() } : {}),
          });
        }
        cursor = page.teams.pageInfo?.hasNextPage
          ? (page.teams.pageInfo.endCursor ?? undefined)
          : undefined;
      } catch (error) {
        if (!loadedTeamPage || error instanceof CoreError) throw error;
        partial = true;
        cursor = undefined;
      }
    } while (cursor);

    if (includeTriageStateIds) {
      const triageStateByTeam = new Map<string, string>();
      cursor = undefined;
      try {
        do {
          const page: {
            workflowStates?: {
              nodes?: Array<{ id?: string; team?: { id?: string } }>;
              pageInfo?: { hasNextPage?: boolean; endCursor?: string };
            };
          } = await this.linearOptionsRequest(actor, integrationId, {
            token,
            query: `query LinearTriageStates($after: String) {
              workflowStates(first: 100, after: $after, filter: { type: { eq: "triage" } }) {
                nodes { id team { id } }
                pageInfo { hasNextPage endCursor }
              }
            }`,
            variables: cursor ? { after: cursor } : {},
          });
          if (!page.workflowStates) {
            throw new Error("Linear GraphQL returned no workflow-state data.");
          }
          for (const state of page.workflowStates.nodes ?? []) {
            if (state.id && state.team?.id) triageStateByTeam.set(state.team.id, state.id);
          }
          cursor = page.workflowStates.pageInfo?.hasNextPage
            ? (page.workflowStates.pageInfo.endCursor ?? undefined)
            : undefined;
        } while (cursor);
      } catch (error) {
        if (error instanceof CoreError) throw error;
        partial = true;
      }
      for (const team of teams) {
        const triageStateId = triageStateByTeam.get(team.id);
        if (triageStateId) team.triageStateId = triageStateId;
      }
    }
    teams.sort((a, b) => a.name.localeCompare(b.name));
    return { provider: "linear", teams, partial };
  }

  private async linearOptionsRequest<T>(
    actor: Actor,
    integrationId: string,
    request: Parameters<typeof linearGraphqlRequest<T>>[0],
  ) {
    try {
      return await linearGraphqlRequest<T>(request);
    } catch (error) {
      if (!isLinearAuthenticationError(error)) throw error;
      const refreshedToken = await this.linearAccessToken(actor, integrationId, {
        refreshIfAccessToken: request.token,
      });
      try {
        return await linearGraphqlRequest<T>({ ...request, token: refreshedToken });
      } catch (retryError) {
        if (!isLinearAuthenticationError(retryError)) throw retryError;
      }
      await markIntegrationStatus({
        userWorkosId: actor.userId,
        integrationId,
        provider: "linear",
        status: "needs_reauth",
        statusReason: "Linear rejected the saved connection. Reconnect Linear.",
        db: this.db,
      });
      throw new CoreError("conflict", "Reconnect Linear in Settings first.");
    }
  }

  private async linearAccessToken(
    actor: Actor,
    integrationId: string,
    options: { refreshIfAccessToken?: string } = {},
  ) {
    try {
      return await getLinearIngestAccessToken(
        { userWorkosId: actor.userId, integrationId },
        { ...options, db: this.db },
      );
    } catch (error) {
      if (!(error instanceof LinearIngestAuthError)) throw error;
      throw new CoreError("conflict", error.message);
    }
  }

  private async listGmailOptions(
    actor: Actor,
    integrationId: string,
  ): Promise<Extract<IntegrationResourceOptions, { provider: "gmail" }>> {
    const account = await loadOwnGmailAccount(actor.userId, integrationId, this.db);
    if (!account) {
      throw new CoreError("conflict", "Connect Gmail in Plugins first.");
    }
    try {
      return {
        provider: "gmail",
        labels: gmailFilterLabelOptions(await listGmailLabels({ account })),
      };
    } catch (error) {
      if (error instanceof CoreError) throw error;
      if (error instanceof GoogleAccessAuthError) {
        // The connection is already marked needs_reauth; the author is sent to the plugin page.
        throw new CoreError("conflict", "Reconnect Gmail in Plugins first.");
      }
      // Keep the cause: everything that is not a rejected credential reaches the author as the
      // same retryable message, so the original failure is the only way to tell a Gmail outage
      // from a misconfigured deployment.
      throw new CoreError("unavailable", "Could not load Gmail labels.", { cause: error });
    }
  }

  private async loadIntegration(
    actor: Actor,
    integrationId: string,
    provider: IntegrationProvider,
  ): Promise<IntegrationRow | null> {
    const [integration] = await this.db
      .select({
        id: integrations.id,
        provider: integrations.provider,
        userWorkosId: integrations.userWorkosId,
        workspaceId: integrations.workspaceId,
        externalId: integrations.externalId,
        status: integrations.status,
      })
      .from(integrations)
      .where(
        and(
          eq(integrations.id, integrationId),
          eq(integrations.provider, provider),
          integrationOwnerWhere(provider, actor),
          ...(provider === "linear"
            ? [ne(integrations.externalId, LINEAR_MCP_EXTERNAL_ID)]
            : provider === "granola"
              ? [ne(integrations.externalId, GRANOLA_MCP_EXTERNAL_ID)]
              : []),
        ),
      )
      .limit(1);
    return integration ?? null;
  }
}

function integrationOwnerWhere(provider: IntegrationProvider, actor: Actor): SQL {
  return isWorkspaceOwnedIntegrationProvider(provider)
    ? eq(integrations.workspaceId, actor.workspaceId)
    : and(eq(integrations.userWorkosId, actor.userId), isNull(integrations.workspaceId))!;
}

function resourceId(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new CoreError("invalid_argument", `${field} is invalid.`);
  }
  return normalized;
}
