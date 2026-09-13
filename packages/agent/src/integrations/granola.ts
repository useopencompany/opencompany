import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  ensureGranolaSyncState,
  GRANOLA_CREDENTIAL_KIND,
  GRANOLA_PROVIDER,
} from "@opencompany/db/granola";
import { markIntegrationStatus, saveIntegrationCredential } from "@opencompany/db/integrations";
import { integrations } from "@opencompany/db/product-schema";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { GranolaProviderState } from "../integration-state";
import { captureConnectionAddedAnalytics } from "./analytics";

export const GRANOLA_API_BASE_URL = "https://public-api.granola.ai/v1";

// Follows the repo-wide injectable-db convention so the canonical API can pass
// its pooled handle while web/runner callers keep the getDb() default.
type DbLike = any;

export type GranolaApiKeyCredentialPayload = {
  apiKey: string;
  createdAt: string;
};

// One Granola connection per user: the key is minted per person in the Granola
// desktop app, so the personal-uniqueness index keys on this stable sentinel
// and a key rotation updates the row in place instead of minting a sibling.
export function granolaExternalIdForUser(userWorkosId: string) {
  return `granola:${userWorkosId}`;
}

export function isValidGranolaApiKey(apiKey: string) {
  return /^grn_[A-Za-z0-9_-]{10,200}$/.test(apiKey);
}

export type GranolaApiKeyValidation =
  | { ok: true; accountEmail: string | null; accountName: string | null }
  | { ok: false; error: string };

// Granola has no identity endpoint; a page_size=1 list call both proves the
// key works and — when a personal note exists — surfaces the key owner from
// the note's owner field.
export async function validateGranolaApiKey(apiKey: string): Promise<GranolaApiKeyValidation> {
  let response: Response;
  try {
    response = await fetch(`${GRANOLA_API_BASE_URL}/notes?page_size=1`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, error: "Could not reach the Granola API. Try again in a moment." };
  }
  if (response.status === 401) {
    return { ok: false, error: "Granola rejected this API key. Check it and try again." };
  }
  if (!response.ok) {
    return { ok: false, error: `Granola API returned an unexpected error (${response.status}).` };
  }
  let owner: { name?: unknown; email?: unknown } | null = null;
  try {
    const body = (await response.json()) as { notes?: Array<{ owner?: unknown }> };
    const first = body.notes?.[0]?.owner;
    if (first && typeof first === "object" && !Array.isArray(first)) {
      owner = first as { name?: unknown; email?: unknown };
    }
  } catch {
    // A valid key with an unparseable body still connects; identity stays null.
  }
  return {
    ok: true,
    accountEmail: typeof owner?.email === "string" ? owner.email : null,
    accountName: typeof owner?.name === "string" ? owner.name : null,
  };
}

// Folders are how Granola users separate customer, investor, and internal meetings, so they back
// the `meeting.notes_ready` event filter. `parent_folder_id` is carried through because the filter
// matches a folder and its descendants, the same scope Granola's own `folder_id` note query uses.
export type GranolaFolder = {
  id: string;
  name: string;
  parentFolderId: string | null;
};

export type GranolaFolderListResult =
  | { ok: true; folders: GranolaFolder[]; partial: boolean }
  | { ok: false; reason: "unauthorized" | "unavailable"; error: string };

const GRANOLA_FOLDERS_PAGE_SIZE = 30;
// Bounds one listing at 600 folders. Beyond that the result is reported as partial rather than
// presented as the whole tree, so a caller never silently treats a missing folder as absent.
const GRANOLA_FOLDERS_MAX_PAGES = 20;
const GRANOLA_FOLDERS_REQUEST_TIMEOUT_MS = 15_000;

export async function listGranolaFolders(input: {
  apiKey: string;
  signal?: AbortSignal;
}): Promise<GranolaFolderListResult> {
  const folders: GranolaFolder[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < GRANOLA_FOLDERS_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ page_size: String(GRANOLA_FOLDERS_PAGE_SIZE) });
    if (cursor) params.set("cursor", cursor);
    const timeout = AbortSignal.timeout(GRANOLA_FOLDERS_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${GRANOLA_API_BASE_URL}/folders?${params.toString()}`, {
        headers: { Authorization: `Bearer ${input.apiKey}` },
        signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      });
    } catch (error) {
      // A caller-driven abort is shutdown, not a Granola failure, and must not be reported as one.
      if (input.signal?.aborted) throw error;
      return {
        ok: false,
        reason: "unavailable",
        error: "Could not reach the Granola API. Try again in a moment.",
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reason: "unauthorized",
        error: "Granola rejected the saved API key. Save a new key to load folders.",
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: "unavailable",
        error: `Granola API returned an unexpected error (${response.status}).`,
      };
    }
    let body: { folders?: unknown; hasMore?: unknown; cursor?: unknown };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      return {
        ok: false,
        reason: "unavailable",
        error: "Granola returned an unreadable folder list.",
      };
    }
    for (const entry of Array.isArray(body.folders) ? body.folders : []) {
      const folder = parseGranolaFolder(entry);
      if (folder) folders.push(folder);
    }
    const nextCursor = typeof body.cursor === "string" && body.cursor ? body.cursor : null;
    // A repeated cursor would page forever; treat it as the end of a list we cannot fully trust.
    if (!body.hasMore || !nextCursor || seenCursors.has(nextCursor)) {
      return { ok: true, folders, partial: Boolean(body.hasMore) };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return { ok: true, folders, partial: true };
}

function parseGranolaFolder(value: unknown): GranolaFolder | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id) return null;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  return {
    id: record.id,
    name: name || record.id,
    parentFolderId:
      typeof record.parent_folder_id === "string" && record.parent_folder_id
        ? record.parent_folder_id
        : null,
  };
}

export async function connectGranolaIntegration(input: {
  userWorkosId: string;
  apiKey: string;
  accountEmail: string | null;
  accountName: string | null;
  now?: Date;
  db?: DbLike;
}): Promise<{ integrationId: string }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const connectionLabel = input.accountEmail?.trim() || input.accountName?.trim() || "Granola";

  const [integration] = await db
    .insert(integrations)
    .values({
      id: newIntegrationId(),
      userWorkosId: input.userWorkosId,
      provider: GRANOLA_PROVIDER,
      externalId: granolaExternalIdForUser(input.userWorkosId),
      connectionLabel,
      accountName: input.accountName,
      accountEmail: input.accountEmail,
      accountType: "granola_api_key",
      status: "connected",
      statusReason: null,
      scopes: [],
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [integrations.userWorkosId, integrations.provider, integrations.externalId],
      // The personal-uniqueness index is partial; the arbiter must match it.
      targetWhere: sql`${integrations.workspaceId} IS NULL`,
      set: {
        connectionLabel,
        accountName: input.accountName,
        accountEmail: input.accountEmail,
        accountType: "granola_api_key",
        status: "connected",
        statusReason: null,
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: integrations.id });

  if (!integration) {
    throw new Error("Could not persist opencompany Granola integration.");
  }

  const payload: GranolaApiKeyCredentialPayload = {
    apiKey: input.apiKey,
    createdAt: now.toISOString(),
  };

  try {
    await saveIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: GRANOLA_PROVIDER,
      kind: GRANOLA_CREDENTIAL_KIND,
      payload,
      // Granola API keys do not expire; users revoke them in the Granola app.
      expiresAt: null,
      db,
      now,
    });
  } catch (error) {
    await markIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: GRANOLA_PROVIDER,
      status: "sync_failed",
      statusReason: "Failed to persist Granola integration credentials.",
      db,
      now: new Date(),
    });
    throw error;
  }

  // Anchor the poll cursor row now so the first runner poll starts from the
  // moment of connection (no backfill) without racing the credential write.
  await ensureGranolaSyncState(
    { integrationId: integration.id, userWorkosId: input.userWorkosId },
    db,
  );

  await captureConnectionAddedAnalytics({
    connectionId: integration.id,
    userWorkosId: input.userWorkosId,
    provider: "granola",
  });

  return { integrationId: integration.id };
}

export async function getGranolaIntegrationState(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<GranolaProviderState> {
  const [row] = await db
    .select({
      id: integrations.id,
      status: integrations.status,
      accountEmail: integrations.accountEmail,
      accountName: integrations.accountName,
      statusReason: integrations.statusReason,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, userWorkosId),
        eq(integrations.provider, GRANOLA_PROVIDER),
        eq(integrations.externalId, granolaExternalIdForUser(userWorkosId)),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);

  if (!row) {
    return {
      provider: "granola",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountEmail: null,
      accountName: null,
      statusReason: null,
    };
  }

  return {
    provider: "granola",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    accountEmail: row.accountEmail,
    accountName: row.accountName,
    statusReason: row.statusReason,
  };
}

function newIntegrationId() {
  return `gint_${randomUUID().replace(/-/g, "")}`;
}
