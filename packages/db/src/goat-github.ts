import { and, eq, inArray } from "drizzle-orm";
import {
  GITHUB_ACTIVITY_EVENT_TYPES,
  type GitHubActivityEventType,
} from "../../goat-brain/src/source-items";
import { getDb } from "./client";
import {
  type GoatIntegrationStatus,
  goatBrainSources,
  goatIntegrationResources,
  goatIntegrations,
} from "./goat-schema";

type DbLike = any;

// Repository ids are GitHub's numeric repo ids (stringified) — stable across
// renames and transfers, unlike full names, which are kept only for display.
export type GoatGitHubRepositoryRef = {
  id: string;
  fullName: string;
};

// The routing contract between the repo picker, the events webhook, and the
// ingest pipeline: a GitHub event is ingested only when its repository id
// appears in the enabled brain-source config for the integration AND its
// event type is subscribed there. A missing `events` key means all supported
// event types (the picker's default state), not none.
export type GoatGitHubBrainSourceConfig = {
  repos?: GoatGitHubRepositoryRef[];
  events?: GitHubActivityEventType[];
};

export type GoatGitHubIntegrationForInstallation = {
  id: string;
  userWorkosId: string;
  status: GoatIntegrationStatus;
};

export type GoatGitHubBrainSourceRoute = {
  integrationId: string;
  brainRef: string;
  config: GoatGitHubBrainSourceConfig;
};

export function parseGoatGitHubBrainSourceConfig(value: unknown): GoatGitHubBrainSourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const repos = parseRepositoryRefs(record.repos);
  const events = parseEventTypes(record.events);
  return {
    ...(repos ? { repos } : {}),
    ...(events ? { events } : {}),
  };
}

export function goatGitHubSelectedRepoIds(config: GoatGitHubBrainSourceConfig): Set<string> {
  return new Set((config.repos ?? []).map((repo) => repo.id));
}

export function goatGitHubEnabledEventTypes(
  config: GoatGitHubBrainSourceConfig,
): Set<GitHubActivityEventType> {
  // Configs written before the event filter existed have no `events` key;
  // treat that as everything so enabling repos alone keeps working.
  return new Set(config.events ?? GITHUB_ACTIVITY_EVENT_TYPES);
}

export async function listGoatGitHubIntegrationsForInstallation(
  installationId: string,
  db: DbLike = getDb(),
): Promise<GoatGitHubIntegrationForInstallation[]> {
  return await db
    .select({
      id: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
      status: goatIntegrations.status,
    })
    .from(goatIntegrations)
    .where(
      and(eq(goatIntegrations.provider, "github"), eq(goatIntegrations.externalId, installationId)),
    );
}

export async function listEnabledGoatGitHubBrainSourceRoutes(
  integrationIds: readonly string[],
  db: DbLike = getDb(),
): Promise<GoatGitHubBrainSourceRoute[]> {
  if (integrationIds.length === 0) return [];
  const rows = await db
    .select({
      integrationId: goatBrainSources.integrationId,
      brainRef: goatBrainSources.brainId,
      config: goatBrainSources.config,
    })
    .from(goatBrainSources)
    .where(
      and(
        eq(goatBrainSources.provider, "github"),
        eq(goatBrainSources.enabled, true),
        inArray(goatBrainSources.integrationId, [...integrationIds]),
      ),
    );

  return rows.map((row: { integrationId: string; brainRef: string; config: unknown }) => ({
    integrationId: row.integrationId,
    brainRef: row.brainRef,
    config: parseGoatGitHubBrainSourceConfig(row.config),
  }));
}

// Repositories the integration's installation can see, synced into
// integration_resources at connect time — the repo picker reads from here so
// it needs no GitHub API call.
export async function listGoatGitHubIntegrationRepositories(
  integrationId: string,
  db: DbLike = getDb(),
): Promise<Array<GoatGitHubRepositoryRef & { private: boolean }>> {
  const rows = await db
    .select({
      externalId: goatIntegrationResources.externalId,
      name: goatIntegrationResources.name,
      metadata: goatIntegrationResources.metadata,
    })
    .from(goatIntegrationResources)
    .where(
      and(
        eq(goatIntegrationResources.integrationId, integrationId),
        eq(goatIntegrationResources.provider, "github"),
        eq(goatIntegrationResources.resourceType, "repository"),
        eq(goatIntegrationResources.status, "available"),
      ),
    );

  return rows
    .map((row: { externalId: string; name: string; metadata: unknown }) => {
      const metadata =
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {};
      return {
        id: row.externalId,
        fullName: row.name,
        private: metadata.private === true,
      };
    })
    .sort((a: GoatGitHubRepositoryRef, b: GoatGitHubRepositoryRef) =>
      a.fullName.localeCompare(b.fullName),
    );
}

function parseEventTypes(value: unknown): GitHubActivityEventType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const known = new Set<string>(GITHUB_ACTIVITY_EVENT_TYPES);
  const events = [
    ...new Set(
      value.filter(
        (entry): entry is GitHubActivityEventType => typeof entry === "string" && known.has(entry),
      ),
    ),
  ];
  return events;
}

function parseRepositoryRefs(value: unknown): GoatGitHubRepositoryRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) return [];
    const fullName = typeof record.fullName === "string" ? record.fullName.trim() : "";
    return [{ id, fullName: fullName || id }];
  });
  return refs.length > 0 ? refs : undefined;
}
