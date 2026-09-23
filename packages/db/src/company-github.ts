import { randomUUID } from "node:crypto";
import { COMPANY_GITHUB_INTEGRATION_PROVIDER } from "@opencompany/core";
import { and, asc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "./client";
import { type IntegrationStatus, integrations } from "./product-schema";

type DbLike = any;

// A GitHub App installation an admin linked to the workspace as the company GitHub plugin. The row
// is workspace-owned and carries no credential: the installation id is the routing key for signed
// App webhooks, and `user_workos_id` only records which admin linked it.
export type CompanyGitHubInstallation = {
  integrationId: string;
  installationId: string;
  accountLogin: string;
  accountType: "Organization" | "User";
  status: IntegrationStatus;
  statusReason: string | null;
  linkedByUserId: string;
  linkedAt: Date;
};

const INSTALLATION_COLUMNS = {
  integrationId: integrations.id,
  installationId: integrations.externalId,
  accountLogin: integrations.accountName,
  accountType: integrations.accountType,
  status: integrations.status,
  statusReason: integrations.statusReason,
  linkedByUserId: integrations.userWorkosId,
  linkedAt: integrations.createdAt,
};

function companyGitHubRows(workspaceId: string) {
  return and(
    eq(integrations.workspaceId, workspaceId),
    eq(integrations.provider, COMPANY_GITHUB_INTEGRATION_PROVIDER),
    isNull(integrations.companyAgentId),
  );
}

// Disconnected rows are kept so relinking the same installation restores the id event triggers
// are bound to, but they are not part of the workspace's plugin anymore.
export async function listCompanyGitHubInstallations(
  workspaceId: string,
  db: DbLike = getDb(),
): Promise<CompanyGitHubInstallation[]> {
  const rows = await db
    .select(INSTALLATION_COLUMNS)
    .from(integrations)
    .where(and(companyGitHubRows(workspaceId), ne(integrations.status, "disconnected")))
    .orderBy(asc(integrations.accountName));
  return rows.map(installationFromRow);
}

export async function connectCompanyGitHubInstallation(input: {
  workspaceId: string;
  userWorkosId: string;
  installationId: string;
  accountLogin: string;
  accountType: "Organization" | "User";
  db?: DbLike;
  now?: Date;
}): Promise<CompanyGitHubInstallation> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const [row] = await db
    .insert(integrations)
    .values({
      id: `gint_${randomUUID().replace(/-/g, "")}`,
      userWorkosId: input.userWorkosId,
      workspaceId: input.workspaceId,
      provider: COMPANY_GITHUB_INTEGRATION_PROVIDER,
      externalId: input.installationId,
      connectionLabel: input.accountLogin,
      accountName: input.accountLogin,
      accountType: input.accountType,
      status: "connected",
      statusReason: null,
      scopes: [],
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [integrations.workspaceId, integrations.provider, integrations.externalId],
      targetWhere: sql`${integrations.workspaceId} IS NOT NULL AND ${integrations.companyAgentId} IS NULL`,
      // The original linking admin stays the attribution on relink; the row id is what triggers
      // bind to, so it must not change.
      set: {
        connectionLabel: input.accountLogin,
        accountName: input.accountLogin,
        accountType: input.accountType,
        status: "connected",
        statusReason: null,
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning(INSTALLATION_COLUMNS);
  return installationFromRow(row);
}

export async function disconnectCompanyGitHubInstallation(input: {
  workspaceId: string;
  integrationId: string;
  db?: DbLike;
  now?: Date;
}): Promise<boolean> {
  const rows = await (input.db ?? getDb())
    .update(integrations)
    .set({
      status: "disconnected",
      statusReason: "Disconnected by a workspace admin.",
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        companyGitHubRows(input.workspaceId),
        eq(integrations.id, input.integrationId),
        ne(integrations.status, "disconnected"),
      ),
    )
    .returning({ id: integrations.id });
  return rows.length > 0;
}

// Every workspace that linked this installation. One GitHub organization may be linked by more than
// one workspace; each receives the deliveries its own triggers select.
export async function listGitHubAppInstallationIntegrations(
  installationId: string,
  db: DbLike = getDb(),
) {
  const rows: Array<{
    id: string;
    workspaceId: string;
    userWorkosId: string;
    status: IntegrationStatus;
  }> = await db
    .select({
      id: integrations.id,
      workspaceId: integrations.workspaceId,
      userWorkosId: integrations.userWorkosId,
      status: integrations.status,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.provider, COMPANY_GITHUB_INTEGRATION_PROVIDER),
        eq(integrations.externalId, installationId),
        isNotNull(integrations.workspaceId),
        isNull(integrations.companyAgentId),
      ),
    );
  return rows;
}

// GitHub reports an uninstall once, to every workspace that linked it. Relinking after a reinstall
// creates a new installation id, so the old rows stay disconnected.
export async function markGitHubAppInstallationRemoved(input: {
  installationId: string;
  db?: DbLike;
  now?: Date;
}) {
  await (input.db ?? getDb())
    .update(integrations)
    .set({
      status: "disconnected",
      statusReason: "The GitHub App was uninstalled from this account.",
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        eq(integrations.provider, COMPANY_GITHUB_INTEGRATION_PROVIDER),
        eq(integrations.externalId, input.installationId),
        isNotNull(integrations.workspaceId),
        ne(integrations.status, "disconnected"),
      ),
    );
}

function installationFromRow(row: {
  integrationId: string;
  installationId: string;
  accountLogin: string | null;
  accountType: string | null;
  status: IntegrationStatus;
  statusReason: string | null;
  linkedByUserId: string;
  linkedAt: Date;
}): CompanyGitHubInstallation {
  return {
    integrationId: row.integrationId,
    installationId: row.installationId,
    accountLogin: row.accountLogin ?? row.installationId,
    accountType: row.accountType === "User" ? "User" : "Organization",
    status: row.status,
    statusReason: row.statusReason,
    linkedByUserId: row.linkedByUserId,
    linkedAt: row.linkedAt,
  };
}
