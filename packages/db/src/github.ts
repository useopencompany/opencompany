import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  GITHUB_ACTIVITY_EVENT_TYPES,
  type GitHubActivityEventType,
} from "../../brain/src/source-items";
import { getDb } from "./client";
import {
  brainSources,
  type GitHubPullRequestEventType,
  gitHubPullRequestEvents,
  type IntegrationStatus,
  integrationResources,
  integrations,
} from "./product-schema";

type DbLike = any;

// Repository ids are GitHub's numeric repo ids (stringified) — stable across
// renames and transfers, unlike full names, which are kept only for display.
export type GitHubRepositoryRef = {
  id: string;
  fullName: string;
};

// The routing contract between the repo picker, the events webhook, and the
// ingest pipeline: a GitHub event is ingested only when its repository id
// appears in the enabled brain-source config for the integration AND its
// event type is subscribed there. A missing `events` key means all supported
// event types (the picker's default state), not none.
export type GitHubBrainSourceConfig = {
  repos?: GitHubRepositoryRef[];
  events?: GitHubActivityEventType[];
};

export type GitHubIntegrationForInstallation = {
  id: string;
  userWorkosId: string;
  status: IntegrationStatus;
};

export type GitHubBrainSourceRoute = {
  integrationId: string;
  brainRef: string;
  config: GitHubBrainSourceConfig;
};

export type GitHubPullRequestEventInsert = {
  integrationId: string;
  userWorkosId: string;
  installationId: string;
  repositoryId: string;
  pullRequestNumber: number;
  deliveryId: string;
  eventType: GitHubPullRequestEventType;
  payload: Record<string, unknown>;
  eventTime: Date;
};

export function parseGitHubBrainSourceConfig(value: unknown): GitHubBrainSourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const repos = parseRepositoryRefs(record.repos);
  const events = parseEventTypes(record.events);
  return {
    ...(repos ? { repos } : {}),
    ...(events ? { events } : {}),
  };
}

export function gitHubSelectedRepoIds(config: GitHubBrainSourceConfig): Set<string> {
  return new Set((config.repos ?? []).map((repo) => repo.id));
}

export function gitHubEnabledEventTypes(
  config: GitHubBrainSourceConfig,
): Set<GitHubActivityEventType> {
  // Configs written before the event filter existed have no `events` key;
  // treat that as everything so enabling repos alone keeps working.
  return new Set(config.events ?? GITHUB_ACTIVITY_EVENT_TYPES);
}

export async function listGitHubIntegrationsForInstallation(
  installationId: string,
  db: DbLike = getDb(),
): Promise<GitHubIntegrationForInstallation[]> {
  return await db
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      status: integrations.status,
    })
    .from(integrations)
    .where(and(eq(integrations.provider, "github"), eq(integrations.externalId, installationId)));
}

export async function listEnabledGitHubBrainSourceRoutes(
  integrationIds: readonly string[],
  db: DbLike = getDb(),
): Promise<GitHubBrainSourceRoute[]> {
  if (integrationIds.length === 0) return [];
  const rows = await db
    .select({
      integrationId: brainSources.integrationId,
      brainRef: brainSources.brainId,
      config: brainSources.config,
    })
    .from(brainSources)
    .where(
      and(
        eq(brainSources.provider, "github"),
        eq(brainSources.enabled, true),
        inArray(brainSources.integrationId, [...integrationIds]),
      ),
    );

  return rows.map((row: { integrationId: string; brainRef: string; config: unknown }) => ({
    integrationId: row.integrationId,
    brainRef: row.brainRef,
    config: parseGitHubBrainSourceConfig(row.config),
  }));
}

export async function insertGitHubPullRequestEvents(
  events: readonly GitHubPullRequestEventInsert[],
  db: DbLike = getDb(),
): Promise<number> {
  if (events.length === 0) return 0;
  // GitHub retries deliveries with the same X-GitHub-Delivery UUID; the
  // per-integration unique index makes redeliveries no-ops.
  const rows = await db
    .insert(gitHubPullRequestEvents)
    .values(
      events.map((event) => ({
        id: newGitHubPullRequestEventId(),
        integrationId: event.integrationId,
        userWorkosId: event.userWorkosId,
        installationId: event.installationId,
        repositoryId: event.repositoryId,
        pullRequestNumber: event.pullRequestNumber,
        deliveryId: event.deliveryId,
        eventType: event.eventType,
        payload: event.payload,
        eventTime: event.eventTime,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: gitHubPullRequestEvents.id });
  return rows.length;
}

// Repositories the integration's installation can see, synced into
// integration_resources at connect time — the repo picker reads from here so
// it needs no GitHub API call.
export async function listGitHubIntegrationRepositories(
  integrationId: string,
  db: DbLike = getDb(),
): Promise<Array<GitHubRepositoryRef & { private: boolean }>> {
  const rows = await db
    .select({
      externalId: integrationResources.externalId,
      name: integrationResources.name,
      metadata: integrationResources.metadata,
    })
    .from(integrationResources)
    .where(
      and(
        eq(integrationResources.integrationId, integrationId),
        eq(integrationResources.provider, "github"),
        eq(integrationResources.resourceType, "repository"),
        eq(integrationResources.status, "available"),
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
    .sort((a: GitHubRepositoryRef, b: GitHubRepositoryRef) => a.fullName.localeCompare(b.fullName));
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

function parseRepositoryRefs(value: unknown): GitHubRepositoryRef[] | undefined {
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

export function newGitHubPullRequestEventId() {
  return `gghprevt_${randomUUID().replace(/-/g, "")}`;
}

export function newGitHubPullRequestWindowId() {
  return `gghprwin_${randomUUID().replace(/-/g, "")}`;
}
