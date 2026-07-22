import { getDb } from "@opencompany/db/client";
import {
  GOAT_ATTIO_CREDENTIAL_KIND,
  GOAT_ATTIO_OBJECT_SLUGS,
  GOAT_ATTIO_PROVIDER,
  type GoatAttioApiKeyCredentialPayload,
} from "@opencompany/db/goat-attio";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
} from "@opencompany/db/goat-integrations";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq } from "drizzle-orm";
import {
  GoatActionAuthError,
  type GoatActionExecuteContext,
  GoatActionInvalidParamsError,
  type GoatActionProviderCatalog,
  requiredStringParam,
} from "@/lib/actions/types";
import { GoatAttioApiRequestError, requestGoatAttioApi } from "@/lib/integrations/attio";

const STANDARD_OBJECTS = ["people", "companies", "deals"] as const;
const MAX_SEARCH_RECORDS = 10;
const DEFAULT_SEARCH_RECORDS = 5;
const MAX_QUERY_CHARS = 256;
const MAX_RECORD_ID_CHARS = 200;
const MAX_SEARCH_PROPERTIES = 8;
const MAX_DETAIL_PROPERTIES = 24;
const MAX_PROPERTY_CHARS = 200;
const MAX_TITLE_CHARS = 200;

type AttioObjectSlug = (typeof STANDARD_OBJECTS)[number];

type AttioConnection = {
  integrationId: string;
  workspaceId: string;
  workspaceName: string | null;
  selector: string;
};

type AttioCredential = {
  apiKey: string;
  objectSlugById: ReadonlyMap<string, AttioObjectSlug>;
  availableObjects: ReadonlySet<AttioObjectSlug>;
};

type AttioRecordInput = {
  id?: { object_id?: unknown; record_id?: unknown };
  object?: unknown;
  object_slug?: unknown;
  created_at?: unknown;
  web_url?: unknown;
  values?: unknown;
  record_text?: unknown;
  email_addresses?: unknown;
  phone_numbers?: unknown;
};

export async function resolveAttioActions(
  userWorkosId: string,
): Promise<GoatActionProviderCatalog | null> {
  const connections = await loadAttioConnections(userWorkosId);
  if (connections.length === 0) return null;

  const multipleAccounts = connections.length > 1;
  const accountParam = multipleAccounts
    ? {
        account: {
          type: "string" as const,
          enum: connections.map((connection) => connection.selector),
          description: "The connected Attio workspace to use.",
        },
      }
    : {};

  const credentialPromises = new Map<string, Promise<AttioCredential>>();
  const getCredential = (context: GoatActionExecuteContext, connection: AttioConnection) => {
    const existing = credentialPromises.get(connection.integrationId);
    if (existing) return existing;
    const pending = loadAttioCredential(context.userWorkosId, connection).catch((error) => {
      credentialPromises.delete(connection.integrationId);
      throw error;
    });
    credentialPromises.set(connection.integrationId, pending);
    return pending;
  };

  return {
    id: "attio",
    label:
      connections.length === 1
        ? `Attio (${connections[0]!.selector})`
        : `Attio (${connections.length} workspaces)`,
    description: "Search people, companies, and deals in Attio.",
    actions: [
      {
        id: "attio.search_records",
        provider: "attio",
        description:
          "Fuzzy-search Attio people, companies, and deals by name, domain, email, phone number, social handle, or deal label. Returns compact matches only; call attio.get_record with the returned object and id for full properties such as company domain or deal stage and value.",
        params: {
          type: "object",
          additionalProperties: false,
          required: multipleAccounts ? ["query", "account"] : ["query"],
          properties: {
            query: {
              type: "string",
              minLength: 1,
              maxLength: MAX_QUERY_CHARS,
              description: "The person, company, deal, email, domain, phone, or handle to find.",
            },
            objects: {
              type: "array",
              minItems: 1,
              maxItems: STANDARD_OBJECTS.length,
              uniqueItems: true,
              items: { type: "string", enum: [...STANDARD_OBJECTS] },
              description: "Optional record types to search. Defaults to every available type.",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_SEARCH_RECORDS,
              description: `Maximum matches to return (default ${DEFAULT_SEARCH_RECORDS}, max ${MAX_SEARCH_RECORDS}).`,
            },
            ...accountParam,
          },
        },
        execute: async (params, context) => {
          assertKnownParams(
            params,
            multipleAccounts
              ? ["query", "objects", "limit", "account"]
              : ["query", "objects", "limit"],
          );
          const query = requiredStringParam(params, "query");
          if (query.length > MAX_QUERY_CHARS) {
            throw new GoatActionInvalidParamsError(
              `"query" must be at most ${MAX_QUERY_CHARS} characters.`,
            );
          }
          const connection = resolveConnection(
            connections,
            multipleAccounts ? requiredStringParam(params, "account") : undefined,
          );
          const limit = parseLimit(params.limit);
          const credential = await getCredential(context, connection);
          const objects = parseObjects(params.objects, credential.availableObjects);
          const response = await searchAttioRecords({
            context,
            connection,
            credential,
            query,
            objects,
            limit,
          });
          return {
            workspace: connection.selector,
            records: attioRecordList(response, limit).flatMap((record) => {
              const compact = compactAttioRecord(
                record,
                credential.objectSlugById,
                MAX_SEARCH_PROPERTIES,
              );
              return compact ? [compact] : [];
            }),
          };
        },
      },
      {
        id: "attio.get_record",
        provider: "attio",
        description:
          "Get one Attio person, company, or deal by object and record id. Returns a detailed CRM record with a larger property set than attio.search_records.",
        params: {
          type: "object",
          additionalProperties: false,
          required: multipleAccounts ? ["object", "record_id", "account"] : ["object", "record_id"],
          properties: {
            object: {
              type: "string",
              enum: [...STANDARD_OBJECTS],
              description: "The record type returned by attio.search_records.",
            },
            record_id: {
              type: "string",
              minLength: 1,
              maxLength: MAX_RECORD_ID_CHARS,
              description: "The record id returned by attio.search_records.",
            },
            ...accountParam,
          },
        },
        execute: async (params, context) => {
          assertKnownParams(
            params,
            multipleAccounts ? ["object", "record_id", "account"] : ["object", "record_id"],
          );
          const connection = resolveConnection(
            connections,
            multipleAccounts ? requiredStringParam(params, "account") : undefined,
          );
          const credential = await getCredential(context, connection);
          const object = parseObject(
            requiredStringParam(params, "object"),
            credential.availableObjects,
          );
          const recordId = requiredStringParam(params, "record_id");
          if (recordId.length > MAX_RECORD_ID_CHARS) {
            throw new GoatActionInvalidParamsError(
              `"record_id" must be at most ${MAX_RECORD_ID_CHARS} characters.`,
            );
          }
          const response = await callAttioRecordsApi({
            context,
            connection,
            credential,
            path: `/objects/${encodeURIComponent(object)}/records/${encodeURIComponent(recordId)}`,
          });
          const record = asRecord(asRecord(response)?.data) as AttioRecordInput | null;
          const compact = record
            ? compactAttioRecord(record, credential.objectSlugById, MAX_DETAIL_PROPERTIES)
            : null;
          if (!compact) {
            throw new Error("Attio returned an invalid record response.");
          }
          return { workspace: connection.selector, record: compact };
        },
      },
    ],
  };
}

async function loadAttioConnections(userWorkosId: string): Promise<AttioConnection[]> {
  const rows = await getDb()
    .select({
      integrationId: goatIntegrations.id,
      workspaceId: goatIntegrations.externalId,
      workspaceName: goatIntegrations.connectionLabel,
      scopes: goatIntegrations.scopes,
      status: goatIntegrations.status,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, GOAT_ATTIO_PROVIDER),
        eq(goatIntegrations.status, "connected"),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt));

  const readable = rows
    .filter((row) => row.status === "connected" && hasAttioReadScopes(row.scopes))
    .map((row) => ({
      integrationId: row.integrationId,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
    }));
  const baseLabelCounts = new Map<string, number>();
  for (const connection of readable) {
    const label = baseConnectionLabel(connection).toLowerCase();
    baseLabelCounts.set(label, (baseLabelCounts.get(label) ?? 0) + 1);
  }
  return readable.map((connection) => {
    const base = baseConnectionLabel(connection);
    const selector =
      (baseLabelCounts.get(base.toLowerCase()) ?? 0) > 1
        ? `${base} (${truncate(connection.workspaceId, 100)})`
        : base;
    return { ...connection, selector };
  });
}

function hasAttioReadScopes(scopes: string[]) {
  // Connections saved before scope tracking still came through the same
  // read/write setup flow; execution remains the final permission check.
  if (scopes.length === 0) return true;
  const canReadObjects =
    scopes.includes("object_configuration:read") ||
    scopes.includes("object_configuration:read-write");
  const canReadRecords =
    scopes.includes("record_permission:read") || scopes.includes("record_permission:read-write");
  return canReadObjects && canReadRecords;
}

function baseConnectionLabel(connection: { workspaceId: string; workspaceName: string | null }) {
  const name = connection.workspaceName?.replace(/\s+/g, " ").trim();
  return truncate(name || connection.workspaceId || "Attio workspace", 100);
}

function resolveConnection(
  connections: readonly AttioConnection[],
  account: string | undefined,
): AttioConnection {
  if (!account) {
    if (connections.length === 1) return connections[0]!;
    throw new GoatActionInvalidParamsError(
      `Multiple Attio workspaces are connected; pass account as one of: ${connections
        .map((connection) => JSON.stringify(connection.selector))
        .join(", ")}.`,
    );
  }
  const wanted = account.toLowerCase();
  const match = connections.find((connection) => connection.selector.toLowerCase() === wanted);
  if (!match) {
    throw new GoatActionInvalidParamsError(
      `No connected Attio workspace matches ${JSON.stringify(account)}. Connected workspaces: ${connections
        .map((connection) => JSON.stringify(connection.selector))
        .join(", ")}.`,
    );
  }
  return match;
}

async function loadAttioCredential(
  userWorkosId: string,
  connection: AttioConnection,
): Promise<AttioCredential> {
  const credential = await loadGoatIntegrationCredential({
    userWorkosId,
    integrationId: connection.integrationId,
    provider: GOAT_ATTIO_PROVIDER,
    kind: GOAT_ATTIO_CREDENTIAL_KIND,
  });
  const payload = credential?.payload as GoatAttioApiKeyCredentialPayload | undefined;
  if (
    typeof payload?.apiKey !== "string" ||
    !payload.apiKey ||
    payload.workspaceId !== connection.workspaceId
  ) {
    throw new GoatActionAuthError(
      "auth_expired",
      "attio",
      `The Attio connection for ${connection.selector} has no usable API key; reconnect Attio in Settings → Integrations.`,
    );
  }

  const objectSlugById = new Map<string, AttioObjectSlug>();
  const availableObjects = new Set<AttioObjectSlug>();
  for (const [objectType, objectId] of Object.entries(payload.objectIdBySlug ?? {})) {
    const slug = GOAT_ATTIO_OBJECT_SLUGS[objectType as keyof typeof GOAT_ATTIO_OBJECT_SLUGS];
    if (isAttioObjectSlug(slug) && typeof objectId === "string" && objectId) {
      objectSlugById.set(objectId, slug);
      availableObjects.add(slug);
    }
  }
  if (availableObjects.size === 0) {
    throw new GoatActionAuthError(
      "auth_expired",
      "attio",
      `The Attio connection for ${connection.selector} has no usable standard objects; reconnect Attio in Settings → Integrations.`,
    );
  }
  return { apiKey: payload.apiKey, objectSlugById, availableObjects };
}

async function searchAttioRecords(input: {
  context: GoatActionExecuteContext;
  connection: AttioConnection;
  credential: AttioCredential;
  query: string;
  objects: AttioObjectSlug[];
  limit: number;
}) {
  return await callAttioRecordsApi({
    context: input.context,
    connection: input.connection,
    credential: input.credential,
    path: "/objects/records/search",
    method: "POST",
    body: {
      query: input.query,
      objects: input.objects,
      request_as: { type: "workspace" },
      limit: input.limit,
    },
  });
}

async function callAttioRecordsApi(input: {
  context: GoatActionExecuteContext;
  connection: AttioConnection;
  credential: AttioCredential;
  path: string;
  method?: string;
  body?: unknown;
}) {
  try {
    return await requestGoatAttioApi({
      apiKey: input.credential.apiKey,
      path: input.path,
      ...(input.method ? { method: input.method } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      signal: input.context.signal,
    });
  } catch (error) {
    if (input.context.signal.aborted) throw error;
    if (
      error instanceof GoatAttioApiRequestError &&
      (error.status === 401 || error.status === 403)
    ) {
      await markGoatIntegrationStatus({
        userWorkosId: input.context.userWorkosId,
        integrationId: input.connection.integrationId,
        provider: GOAT_ATTIO_PROVIDER,
        status: "needs_reauth",
        statusReason: "Attio rejected the saved API key.",
      }).catch(() => {});
      throw new GoatActionAuthError(
        "auth_expired",
        "attio",
        `Attio rejected the API key for ${input.connection.selector}; reconnect Attio in Settings → Integrations.`,
      );
    }
    if (error instanceof GoatAttioApiRequestError) {
      throw new Error(
        error.detail
          ? `Attio API request failed (${error.status}): ${error.detail}.`
          : `Attio API request failed (${error.status}).`,
      );
    }
    throw new Error("Attio could not be reached. Try again in a moment.");
  }
}

function assertKnownParams(params: Record<string, unknown>, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(params).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new GoatActionInvalidParamsError(
      `Unknown parameter${unknown.length === 1 ? "" : "s"}: ${unknown
        .map((key) => JSON.stringify(key))
        .join(", ")}.`,
    );
  }
}

function parseLimit(value: unknown) {
  if (value === undefined || value === null) return DEFAULT_SEARCH_RECORDS;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_SEARCH_RECORDS
  ) {
    throw new GoatActionInvalidParamsError(
      `"limit" must be an integer from 1 to ${MAX_SEARCH_RECORDS}.`,
    );
  }
  return value;
}

function parseObjects(
  value: unknown,
  availableObjects: ReadonlySet<AttioObjectSlug>,
): AttioObjectSlug[] {
  if (value === undefined || value === null) {
    return STANDARD_OBJECTS.filter((object) => availableObjects.has(object));
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > STANDARD_OBJECTS.length) {
    throw new GoatActionInvalidParamsError(
      '"objects" must be a non-empty array containing people, companies, or deals.',
    );
  }
  const objects: AttioObjectSlug[] = [];
  for (const entry of value) {
    if (!isAttioObjectSlug(entry)) {
      throw new GoatActionInvalidParamsError(
        'Each "objects" entry must be one of people, companies, or deals.',
      );
    }
    if (objects.includes(entry)) {
      throw new GoatActionInvalidParamsError('"objects" must not contain duplicates.');
    }
    if (!availableObjects.has(entry)) {
      throw new GoatActionInvalidParamsError(
        `The Attio ${entry} object is not available in this workspace. Available: ${[
          ...availableObjects,
        ].join(", ")}.`,
      );
    }
    objects.push(entry);
  }
  return objects;
}

function parseObject(value: string, availableObjects: ReadonlySet<AttioObjectSlug>) {
  if (!isAttioObjectSlug(value)) {
    throw new GoatActionInvalidParamsError('"object" must be one of people, companies, or deals.');
  }
  if (!availableObjects.has(value)) {
    throw new GoatActionInvalidParamsError(
      `The Attio ${value} object is not available in this workspace. Available: ${[
        ...availableObjects,
      ].join(", ")}.`,
    );
  }
  return value;
}

function attioRecordList(response: unknown, limit: number): AttioRecordInput[] {
  const data = asRecord(response)?.data;
  return Array.isArray(data)
    ? data.slice(0, limit).filter((entry): entry is AttioRecordInput => asRecord(entry) !== null)
    : [];
}

function compactAttioRecord(
  record: AttioRecordInput,
  objectSlugById: ReadonlyMap<string, AttioObjectSlug>,
  maxProperties: number,
) {
  const recordId = boundedIdentifier(record.id?.record_id, MAX_RECORD_ID_CHARS);
  const object =
    asAttioObjectSlug(record.object) ??
    asAttioObjectSlug(record.object_slug) ??
    objectSlugById.get(boundedIdentifier(record.id?.object_id, 200) ?? "");
  if (!recordId || !object) return null;

  const properties = Object.create(null) as Record<string, string>;
  const emails = compactStringList(record.email_addresses);
  const phones = compactStringList(record.phone_numbers);
  if (emails) properties.email_addresses = truncate(emails, MAX_PROPERTY_CHARS);
  if (phones) properties.phone_numbers = truncate(phones, MAX_PROPERTY_CHARS);
  const values = asRecord(record.values) ?? {};
  let inspectedProperties = 0;
  for (const rawSlug in values) {
    if (!Object.hasOwn(values, rawSlug)) continue;
    if (inspectedProperties >= maxProperties * 4) break;
    inspectedProperties += 1;
    if (Object.keys(properties).length >= maxProperties) break;
    const slug = rawSlug.trim();
    if (
      !/^[a-z0-9_-]{1,100}$/i.test(slug) ||
      slug === "__proto__" ||
      slug === "constructor" ||
      slug === "prototype" ||
      Object.hasOwn(properties, slug)
    ) {
      continue;
    }
    const rendered = renderAttioValues(values[rawSlug]);
    if (rendered) properties[slug] = truncate(rendered, MAX_PROPERTY_CHARS);
  }

  const title = truncate(
    properties.name ??
      properties.full_name ??
      boundedString(record.record_text, MAX_TITLE_CHARS) ??
      properties.email_addresses ??
      `${singularObjectName(object)} ${recordId}`,
    MAX_TITLE_CHARS,
  );
  const url = safeHttpsUrl(record.web_url);
  const createdAt = boundedString(record.created_at, 80);
  return {
    object,
    id: recordId,
    title,
    ...(url ? { url } : {}),
    ...(createdAt ? { createdAt } : {}),
    properties,
  };
}

function renderAttioValues(entries: unknown): string | null {
  if (!Array.isArray(entries)) return primitiveString(entries);
  const rendered = entries
    .slice(0, 10)
    .filter((entry): entry is Record<string, unknown> => asRecord(entry) !== null)
    .filter((entry) => entry.active_until == null)
    .map(renderAttioValue)
    .filter((value): value is string => Boolean(value))
    .map((value) => truncate(value, MAX_PROPERTY_CHARS));
  return rendered.length > 0 ? rendered.join("; ") : null;
}

function renderAttioValue(value: Record<string, unknown>): string | null {
  const type = typeof value.attribute_type === "string" ? value.attribute_type : "";
  if (type === "actor-reference" || type === "record-reference") return null;
  if (type === "interaction") {
    const timestamp = primitiveString(value.interacted_at);
    const interactionType = primitiveString(value.interaction_type);
    return timestamp ? `${timestamp}${interactionType ? ` (${interactionType})` : ""}` : null;
  }
  if (type === "personal-name") {
    const fullName = primitiveString(value.full_name);
    if (fullName) return fullName;
    return (
      [primitiveString(value.first_name), primitiveString(value.last_name)]
        .filter(Boolean)
        .join(" ") || null
    );
  }
  if (type === "email-address") return primitiveString(value.email_address);
  if (type === "phone-number") {
    return primitiveString(value.phone_number) ?? primitiveString(value.original_phone_number);
  }
  if (type === "domain") return primitiveString(value.domain);
  if (type === "select") return primitiveString(asRecord(value.option)?.title);
  if (type === "status") return primitiveString(asRecord(value.status)?.title);
  if (type === "currency") return primitiveString(value.currency_value);
  if (type === "location") {
    return (
      [primitiveString(value.locality), primitiveString(value.country_code)]
        .filter(Boolean)
        .join(", ") || null
    );
  }
  return (
    primitiveString(value.value) ??
    primitiveString(value.name) ??
    primitiveString(value.title) ??
    primitiveString(value.full_name)
  );
}

function compactStringList(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const entries = value
    .slice(0, 5)
    .map(primitiveString)
    .filter((entry): entry is string => Boolean(entry));
  return entries.length > 0 ? entries.join("; ") : null;
}

function primitiveString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

function boundedString(value: unknown, maxChars: number) {
  const string = primitiveString(value);
  return string ? truncate(string, maxChars) : null;
}

function boundedIdentifier(value: unknown, maxChars: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxChars ? normalized : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isAttioObjectSlug(value: unknown): value is AttioObjectSlug {
  return typeof value === "string" && (STANDARD_OBJECTS as readonly string[]).includes(value);
}

function asAttioObjectSlug(value: unknown): AttioObjectSlug | undefined {
  return isAttioObjectSlug(value) ? value : undefined;
}

function singularObjectName(object: AttioObjectSlug) {
  if (object === "people") return "Person";
  if (object === "companies") return "Company";
  return "Deal";
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "app.attio.com" &&
      !url.username &&
      !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return "…".slice(0, maxChars);
  return `${value.slice(0, maxChars - 1)}…`;
}
