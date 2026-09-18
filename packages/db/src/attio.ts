import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./client";
import {
  type AttioEventAction,
  type AttioObjectType,
  type IntegrationStatus,
  integrations,
} from "./product-schema";

type DbLike = any;

export const ATTIO_PROVIDER = "attio" as const;
export const ATTIO_CREDENTIAL_KIND = "api_key" as const;

export const ATTIO_OBJECT_TYPES = ["person", "company", "deal"] as const;

// Attio's standard-object api slugs, keyed by our object type.
export const ATTIO_OBJECT_SLUGS: Record<AttioObjectType, string> = {
  person: "people",
  company: "companies",
  deal: "deals",
};

export type AttioObjectTypeRef = {
  id: AttioObjectType;
};

export const ATTIO_EVENT_TYPES = ["object_created", "object_updated", "note_added"] as const;
export const ATTIO_DEFAULT_EVENT_TYPES = ["object_created", "note_added"] as const;

// Attio record.updated payloads have no provider-native event id. Deliveries
// for the same update reach each member webhook within a short interval, while
// distinct windows are separated by the worker's 15-minute quiet period. A
// five-minute bucket therefore deduplicates the former without collapsing all
// changes to one attribute for an entire day.
export const ATTIO_UPDATE_CLAIM_BUCKET_MS = 5 * 60_000;

export type AttioEventType = (typeof ATTIO_EVENT_TYPES)[number];

export type AttioEventRef = {
  id: AttioEventType;
};

// The whole Attio connection lives in one api_key credential: the workspace
// key the user pasted, the webhook Attio minted for us at connect time (its
// secret signs inbound deliveries), and the workspace's object UUIDs so the
// webhook receiver can map event object ids to our object types without an
// API call.
export type AttioApiKeyCredentialPayload = {
  apiKey: string;
  workspaceId: string;
  authorizedByWorkspaceMemberId?: string | null;
  webhookId: string | null;
  webhookSecret: string | null;
  objectIdBySlug: Partial<Record<AttioObjectType, string>>;
  createdAt: string;
};

export type AttioIntegrationForWorkspace = {
  id: string;
  userWorkosId: string;
  status: IntegrationStatus;
};

export async function listAttioIntegrationsForWorkspace(
  workspaceId: string,
  db: DbLike = getDb(),
): Promise<AttioIntegrationForWorkspace[]> {
  return await db
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      status: integrations.status,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.provider, ATTIO_PROVIDER),
        // Integration rows key external_id on the Attio workspace id, so
        // inbound webhooks route by the event's workspace_id.
        eq(integrations.externalId, workspaceId),
      ),
    );
}
