import {
  ATTIO_CREDENTIAL_KIND,
  ATTIO_OBJECT_SLUGS,
  ATTIO_PROVIDER,
  type AttioApiKeyCredentialPayload,
} from "@opencompany/db/attio";
import { loadIntegrationCredential, markIntegrationStatus } from "@opencompany/db/integrations";
import type { AttioObjectType } from "@opencompany/db/schema";
import { createLogger } from "@opencompany/observability";
import { getDb } from "./db";

// Read-only Attio helpers for the flush worker's prompt enrichment (live
// record snapshot, attribute titles, and note content). Enrichment failures
// must never fail a flush: the worker falls back to the buffered webhook
// payloads. Attio workspace API keys do not expire; a 401/403 means the user
// revoked the key, which marks the integration needs_reauth.

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-attio-api" });

const ATTIO_API_BASE_URL = "https://api.attio.com/v2";
const ATTIO_API_TIMEOUT_MS = 10_000;
const SNAPSHOT_PROPERTY_VALUE_MAX_CHARS = 2_000;
const SNAPSHOT_PROPERTY_MAX_COUNT = 40;
const NOTE_CONTENT_MAX_CHARS = 8_000;

// Record values that are system bookkeeping or interaction rollups; they
// change constantly and carry no durable knowledge for the prompt.
const SNAPSHOT_SKIP_ATTRIBUTE_TYPES = new Set(["interaction", "actor-reference"]);

export class AttioAuthError extends Error {}

export type AttioRecordSnapshot = {
  name: string | null;
  url: string | null;
  stage?: string;
  properties: Record<string, string>;
  createdAt?: string;
};

export type AttioNote = {
  noteId: string;
  title: string;
  createdAt?: string;
  content: string;
};

export async function loadAttioApiKey(input: {
  userWorkosId: string;
  integrationId: string;
}): Promise<string | null> {
  const credential = await loadIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: ATTIO_PROVIDER,
    kind: ATTIO_CREDENTIAL_KIND,
    db: getDb(),
  }).catch((error) => {
    logger.warn("Goat Attio credential load failed", {
      event: "opencompany.goat_attio_credential_load_failed",
      integration_id: input.integrationId,
      error,
    });
    return null;
  });
  if (!credential) return null;
  const payload = credential.payload as AttioApiKeyCredentialPayload;
  return typeof payload.apiKey === "string" && payload.apiKey ? payload.apiKey : null;
}

export async function markAttioNeedsReauth(
  input: { userWorkosId: string; integrationId: string },
  reason: string,
) {
  await markIntegrationStatus({
    userWorkosId: input.userWorkosId,
    integrationId: input.integrationId,
    provider: ATTIO_PROVIDER,
    status: "needs_reauth",
    statusReason: reason,
    db: getDb(),
  }).catch((error) => {
    logger.warn("Goat Attio needs_reauth marking failed", {
      event: "opencompany.goat_attio_needs_reauth_mark_failed",
      integration_id: input.integrationId,
      error,
    });
  });
}

// Returns null when the record is gone or unreadable (deleted record, missing
// scope); the caller then normalizes from the buffered events instead. Auth
// failures propagate as AttioAuthError so the flush worker can mark the
// integration.
export async function fetchAttioRecordSnapshot(input: {
  apiKey: string;
  objectType: AttioObjectType;
  recordId: string;
}): Promise<AttioRecordSnapshot | null> {
  try {
    const slug = ATTIO_OBJECT_SLUGS[input.objectType];
    const record = (await attioApiRequest({
      apiKey: input.apiKey,
      path: `/objects/${slug}/records/${encodeURIComponent(input.recordId)}`,
    })) as {
      data?: {
        values?: Record<string, unknown>;
        created_at?: string;
        web_url?: string;
      };
    } | null;
    if (!record?.data) return null;

    const values = record.data.values ?? {};
    const properties: Record<string, string> = {};
    for (const [attributeSlug, entries] of Object.entries(values)) {
      if (Object.keys(properties).length >= SNAPSHOT_PROPERTY_MAX_COUNT) break;
      const rendered = renderAttioValues(entries);
      if (!rendered) continue;
      properties[attributeSlug] = rendered.slice(0, SNAPSHOT_PROPERTY_VALUE_MAX_CHARS);
    }

    return {
      name: properties.name ?? null,
      url: typeof record.data.web_url === "string" ? record.data.web_url : null,
      ...(properties.stage ? { stage: properties.stage } : {}),
      properties,
      ...(typeof record.data.created_at === "string" ? { createdAt: record.data.created_at } : {}),
    };
  } catch (error) {
    if (error instanceof AttioAuthError) throw error;
    logger.warn("Attio record snapshot fetch failed", {
      event: "opencompany.goat_attio_snapshot_failed",
      object_type: input.objectType,
      record_id: input.recordId,
      error,
    });
    return null;
  }
}

// Attribute titles for update events, one list call per object type. Returns
// an empty map on failure; activity lines then fall back to "an attribute".
export async function fetchAttioAttributeTitles(input: {
  apiKey: string;
  objectType: AttioObjectType;
}): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    const slug = ATTIO_OBJECT_SLUGS[input.objectType];
    const response = (await attioApiRequest({
      apiKey: input.apiKey,
      path: `/objects/${slug}/attributes?limit=500`,
    })) as {
      data?: Array<{ id?: { attribute_id?: string }; title?: string }>;
    } | null;
    for (const attribute of response?.data ?? []) {
      const id = attribute.id?.attribute_id;
      if (typeof id === "string" && id && typeof attribute.title === "string") {
        titles.set(id, attribute.title);
      }
    }
  } catch (error) {
    if (error instanceof AttioAuthError) throw error;
    logger.warn("Attio attribute title fetch failed", {
      event: "opencompany.goat_attio_attribute_titles_failed",
      object_type: input.objectType,
      error,
    });
  }
  return titles;
}

// Full content for the specific notes buffered in the window. Fetch failures
// drop the note's content, never the flush.
export async function fetchAttioNotes(input: {
  apiKey: string;
  noteIds: readonly string[];
}): Promise<AttioNote[]> {
  const notes: AttioNote[] = [];
  for (const noteId of input.noteIds) {
    try {
      const response = (await attioApiRequest({
        apiKey: input.apiKey,
        path: `/notes/${encodeURIComponent(noteId)}`,
      })) as {
        data?: { title?: string; content_plaintext?: string; created_at?: string };
      } | null;
      if (!response?.data) continue;
      const content =
        typeof response.data.content_plaintext === "string"
          ? response.data.content_plaintext.slice(0, NOTE_CONTENT_MAX_CHARS)
          : "";
      notes.push({
        noteId,
        title: typeof response.data.title === "string" ? response.data.title : "Untitled note",
        ...(typeof response.data.created_at === "string"
          ? { createdAt: response.data.created_at }
          : {}),
        content,
      });
    } catch (error) {
      if (error instanceof AttioAuthError) throw error;
      logger.warn("Attio note fetch failed", {
        event: "opencompany.goat_attio_note_fetch_failed",
        note_id: noteId,
        error,
      });
    }
  }
  return notes;
}

// Attio record values are arrays of typed value objects; render the active
// ones to a compact string. Unknown types fall back to their first primitive
// payload field so new attribute types degrade gracefully.
export function renderAttioValues(entries: unknown): string | null {
  if (!Array.isArray(entries)) return null;
  const parts: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (value.active_until != null) continue;
    const attributeType = typeof value.attribute_type === "string" ? value.attribute_type : "";
    if (SNAPSHOT_SKIP_ATTRIBUTE_TYPES.has(attributeType)) continue;
    const rendered = renderAttioValue(attributeType, value);
    if (rendered) parts.push(rendered);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

function renderAttioValue(attributeType: string, value: Record<string, unknown>): string | null {
  switch (attributeType) {
    case "personal-name": {
      const fullName = asDisplayString(value.full_name);
      if (fullName) return fullName;
      const joined = [asDisplayString(value.first_name), asDisplayString(value.last_name)]
        .filter(Boolean)
        .join(" ");
      return joined || null;
    }
    case "email-address":
      return asDisplayString(value.email_address);
    case "phone-number":
      return asDisplayString(value.phone_number) ?? asDisplayString(value.original_phone_number);
    case "domain":
      return asDisplayString(value.domain);
    case "select":
      return asDisplayString((value.option as Record<string, unknown> | undefined)?.title);
    case "status":
      return asDisplayString((value.status as Record<string, unknown> | undefined)?.title);
    case "currency":
      return asDisplayString(value.currency_value);
    case "location":
      return (
        [asDisplayString(value.locality), asDisplayString(value.country_code)]
          .filter(Boolean)
          .join(", ") || null
      );
    case "record-reference":
      // Reference values carry only target ids; ids are noise in a prompt.
      return null;
    default:
      return asDisplayString(value.value);
  }
}

function asDisplayString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

async function attioApiRequest(input: { apiKey: string; path: string }): Promise<unknown> {
  const response = await fetch(`${ATTIO_API_BASE_URL}${input.path}`, {
    headers: { Authorization: `Bearer ${input.apiKey}` },
    signal: AbortSignal.timeout(ATTIO_API_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (response.status === 401 || response.status === 403) {
    throw new AttioAuthError(`Attio API request rejected with ${response.status}.`);
  }
  if (!response.ok) {
    throw new Error(`Attio API request failed with ${response.status}.`);
  }
  return await response.json();
}
