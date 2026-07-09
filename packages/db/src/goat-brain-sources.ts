import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "./client";
import {
  type GoatBrainSourceConfigProvider,
  type GoatIntegrationStatus,
  goatBrainSources,
  goatIntegrations,
  goatUsers,
} from "./goat-schema";

type DbLike = any;

export type GoatBrainSourceWithIntegration = {
  id: string;
  brainId: string;
  provider: GoatBrainSourceConfigProvider;
  integrationId: string;
  userWorkosId: string;
  enabled: boolean;
  config: Record<string, unknown>;
  integrationStatus: GoatIntegrationStatus;
  integrationAccountName: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
};

export async function listGoatBrainSourcesForBrain(
  brainId: string,
  db: DbLike = getDb(),
): Promise<GoatBrainSourceWithIntegration[]> {
  const rows = await db
    .select({
      id: goatBrainSources.id,
      brainId: goatBrainSources.brainId,
      provider: goatBrainSources.provider,
      integrationId: goatBrainSources.integrationId,
      userWorkosId: goatBrainSources.userWorkosId,
      enabled: goatBrainSources.enabled,
      config: goatBrainSources.config,
      integrationStatus: goatIntegrations.status,
      integrationAccountName: goatIntegrations.accountName,
      ownerFirstName: goatUsers.firstName,
      ownerLastName: goatUsers.lastName,
      ownerEmail: goatUsers.email,
    })
    .from(goatBrainSources)
    .innerJoin(goatIntegrations, eq(goatBrainSources.integrationId, goatIntegrations.id))
    .innerJoin(goatUsers, eq(goatBrainSources.userWorkosId, goatUsers.workosUserId))
    .where(eq(goatBrainSources.brainId, brainId));

  return rows.map((row: (typeof rows)[number]) => ({
    id: row.id,
    brainId: row.brainId,
    provider: row.provider,
    integrationId: row.integrationId,
    userWorkosId: row.userWorkosId,
    enabled: row.enabled,
    config: row.config,
    integrationStatus: row.integrationStatus,
    integrationAccountName: row.integrationAccountName,
    ownerName: [row.ownerFirstName, row.ownerLastName].filter(Boolean).join(" ").trim() || null,
    ownerEmail: row.ownerEmail,
  }));
}

export async function listEnabledBrainRefsForIntegration(
  integrationId: string,
  db: DbLike = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ brainId: goatBrainSources.brainId })
    .from(goatBrainSources)
    .where(
      and(eq(goatBrainSources.integrationId, integrationId), eq(goatBrainSources.enabled, true)),
    );
  return rows.map((row: { brainId: string }) => row.brainId);
}

export async function hasAnyBrainSourceForIntegration(
  integrationId: string,
  db: DbLike = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: goatBrainSources.id })
    .from(goatBrainSources)
    .where(eq(goatBrainSources.integrationId, integrationId))
    .limit(1);
  return rows.length > 0;
}

export async function upsertGoatBrainSource(input: {
  brainId: string;
  provider: GoatBrainSourceConfigProvider;
  integrationId: string;
  userWorkosId: string;
  createdByWorkosId: string;
  enabled: boolean;
  now?: Date;
  db?: DbLike;
}): Promise<{ id: string }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();

  const [row] = await db
    .insert(goatBrainSources)
    .values({
      id: newGoatBrainSourceId(),
      brainId: input.brainId,
      provider: input.provider,
      integrationId: input.integrationId,
      userWorkosId: input.userWorkosId,
      createdByWorkosId: input.createdByWorkosId,
      enabled: input.enabled,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [goatBrainSources.brainId, goatBrainSources.integrationId],
      set: {
        enabled: input.enabled,
        updatedAt: now,
      },
    })
    .returning({ id: goatBrainSources.id });

  if (!row) throw new Error("Could not persist Goat Brain source.");
  return { id: row.id };
}

export function newGoatBrainSourceId() {
  return `gbscfg_${randomUUID().replace(/-/g, "")}`;
}
