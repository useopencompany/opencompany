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
import { jsonSchema, type ToolSet, tool } from "ai";
import { and, desc, eq } from "drizzle-orm";
import {
  GoatCapabilityAuthError,
  type GoatCapabilityDefinition,
  type GoatCapabilityOperation,
  type GoatCapabilityWorkerContext,
} from "@/lib/capabilities/types";
import { GOAT_ATTIO_API_BASE_URL } from "@/lib/integrations/attio";

const ATTIO_REQUEST_TIMEOUT_MS = 12_000;
const MAX_SEARCH_RECORDS = 25;
const MAX_NOTES = 25;
const MAX_PROPERTIES = 24;
const MAX_PROPERTY_CHARS = 500;
const MAX_NOTE_CONTENT_CHARS = 8_000;
const MAX_CREATE_NOTE_CHARS = 20_000;
const MAX_PEOPLE_PER_DEAL = 20;
const STANDARD_OBJECTS = ["people", "companies", "deals"] as const;

type AttioObjectSlug = (typeof STANDARD_OBJECTS)[number];
type AttioConnection = {
  integrationId: string;
  workspaceName: string | null;
  canCreateRecords: boolean;
  canCreateNotes: boolean;
};
type AttioRequestContext = {
  apiKey: string;
  connection: AttioConnection;
  userWorkosId: string;
  signal: AbortSignal;
  objectSlugById: ReadonlyMap<string, AttioObjectSlug>;
};
type AttioRecordInput = {
  id?: { object_id?: string; record_id?: string };
  object?: string;
  object_slug?: string;
  created_at?: string;
  web_url?: string;
  values?: Record<string, unknown>;
};
type AttioNoteInput = {
  id?: { note_id?: string } | string;
  note_id?: string;
  parent_object?: string;
  parent_record_id?: string;
  title?: string;
  content_plaintext?: string;
  content?: string;
  created_at?: string;
  web_url?: string;
};

export const attioCapability: GoatCapabilityDefinition = {
  id: "attio",
  workerModel: "openai/gpt-5.4-mini",
  async resolve(userWorkosId) {
    const connection = await loadAttioConnection(userWorkosId);
    if (!connection) return null;
    const canCreate = connection.canCreateRecords || connection.canCreateNotes;
    const workspaceName = connection.workspaceName
      ? truncate(connection.workspaceName.replace(/\s+/g, " ").trim(), 80)
      : "";
    const workspace = workspaceName ? " " + JSON.stringify(workspaceName) : "";
    const creationSupport = [
      connection.canCreateRecords ? "people, companies, and deals" : null,
      connection.canCreateNotes ? "markdown notes" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    const createLine = canCreate
      ? "CAN create one " +
        creationSupport +
        " per create call when the user explicitly requests it."
      : "CANNOT create records or notes until the Attio key is resaved with read-write scopes.";
    return {
      operations: canCreate ? ["read", "create"] : ["read"],
      indexLine:
        "attio — accesses the user's Attio workspace" +
        workspace +
        ". CAN search and retrieve standard people, companies, deals, and their notes. " +
        createLine +
        " CANNOT update, upsert, or delete records, use custom objects, or create tasks or list entries.",
      recipeLines: [
        "Use attio_search_records to resolve a person, company, or deal by name before fetching the exact record or attaching a relationship.",
        "When searching, include only the standard object slugs people, companies, and deals. Custom objects are unsupported.",
        "Use attio_list_notes with both object and recordId to list notes on one record, or omit both to list notes globally.",
        "If an Attio tool reports a missing scope or asks for reconnection, stop immediately and report that guidance; do not retry the call.",
        ...(connection.canCreateRecords
          ? [
              "Create a person, company, or deal only when this worker is in create mode and the request explicitly asks for that exact creation. Resolve related record ids with read tools first.",
            ]
          : []),
        ...(connection.canCreateNotes
          ? [
              "Create a markdown note only when this worker is in create mode and the request explicitly asks for the note. Resolve its parent record id first when needed.",
            ]
          : []),
        'Cite records as type "attio_record" with id "<object>:<record id>", and notes as type "attio_note" with their note id. Copy urls from tool entity fields when present.',
      ],
      createTools: (context, operation) => createAttioTools(context, connection, operation),
    };
  },
};

async function loadAttioConnection(userWorkosId: string): Promise<AttioConnection | null> {
  const [row] = await getDb()
    .select({
      id: goatIntegrations.id,
      status: goatIntegrations.status,
      connectionLabel: goatIntegrations.connectionLabel,
      scopes: goatIntegrations.scopes,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, GOAT_ATTIO_PROVIDER),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);
  if (!row || row.status !== "connected") return null;
  const scopes = Array.isArray(row.scopes) ? row.scopes : [];
  const canReadObjects = scopes.includes("object_configuration:read");
  const canReadRecords =
    scopes.includes("record_permission:read") || scopes.includes("record_permission:read-write");
  return {
    integrationId: row.id,
    workspaceName: row.connectionLabel,
    canCreateRecords: canReadObjects && scopes.includes("record_permission:read-write"),
    canCreateNotes: canReadObjects && canReadRecords && scopes.includes("note:read-write"),
  };
}

async function createAttioTools(
  context: GoatCapabilityWorkerContext,
  connection: AttioConnection,
  operation: GoatCapabilityOperation,
) {
  if (operation === "create" && !connection.canCreateRecords && !connection.canCreateNotes) {
    throw new Error("This Attio connection does not permit create operations.");
  }
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: context.userWorkosId,
    integrationId: connection.integrationId,
    provider: GOAT_ATTIO_PROVIDER,
    kind: GOAT_ATTIO_CREDENTIAL_KIND,
  });
  const payload = credential?.payload as GoatAttioApiKeyCredentialPayload | undefined;
  const apiKey = payload?.apiKey;
  if (typeof apiKey !== "string" || !apiKey) {
    throw new GoatCapabilityAuthError(
      "auth_expired",
      "The Attio connection has no usable API key; the user needs to reconnect Attio in Settings → Integrations.",
    );
  }
  const objectSlugById = new Map<string, AttioObjectSlug>();
  for (const [objectType, objectId] of Object.entries(payload.objectIdBySlug ?? {})) {
    const slug = GOAT_ATTIO_OBJECT_SLUGS[objectType as keyof typeof GOAT_ATTIO_OBJECT_SLUGS];
    if (slug && typeof objectId === "string") {
      objectSlugById.set(objectId, slug as AttioObjectSlug);
    }
  }
  const requestContext: AttioRequestContext = {
    apiKey,
    connection,
    userWorkosId: context.userWorkosId,
    signal: context.signal,
    objectSlugById,
  };
  const tools = createAttioReadTools(requestContext);
  if (operation === "create") Object.assign(tools, createAttioCreateTools(requestContext));
  return { tools };
}

function createAttioReadTools(context: AttioRequestContext): ToolSet {
  return {
    attio_search_records: tool({
      description:
        "Fuzzy-search Attio's standard people, companies, and deals. Returns compact records and attio_record entities.",
      inputSchema: jsonSchema<{
        query: string;
        objects?: AttioObjectSlug[];
        limit?: number;
      }>({
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500 },
          objects: {
            type: "array",
            items: { type: "string", enum: [...STANDARD_OBJECTS] },
            maxItems: STANDARD_OBJECTS.length,
          },
          limit: { type: "number", minimum: 1, maximum: MAX_SEARCH_RECORDS },
        },
        required: ["query"],
      }),
      execute: async (args) => {
        const query = requiredString(args.query, "query", 500);
        const objects = normalizeObjects(args.objects);
        const limit = clampCount(args.limit, 10, MAX_SEARCH_RECORDS);
        const response = await attioRequest(context, {
          path: "/objects/records/search",
          method: "POST",
          body: { query, objects, limit },
        });
        return {
          records: attioRecordList(response)
            .slice(0, limit)
            .map((record) => compactAttioRecord(record, undefined, context.objectSlugById)),
        };
      },
    }),
    attio_get_record: tool({
      description: "Get one standard Attio record by object slug and record id.",
      inputSchema: jsonSchema<{ object: AttioObjectSlug; recordId: string }>({
        type: "object",
        additionalProperties: false,
        properties: {
          object: { type: "string", enum: [...STANDARD_OBJECTS] },
          recordId: { type: "string", minLength: 1, maxLength: 200 },
        },
        required: ["object", "recordId"],
      }),
      execute: async (args) => {
        const object = requiredObject(args.object);
        const recordId = requiredString(args.recordId, "recordId", 200);
        const response = await attioRequest(context, {
          path: "/objects/" + object + "/records/" + encodeURIComponent(recordId),
        });
        const record = attioRecord(response);
        return {
          record: record
            ? compactAttioRecord(
                {
                  ...record,
                  id: { ...record.id, record_id: record.id?.record_id ?? recordId },
                },
                object,
                context.objectSlugById,
              )
            : null,
        };
      },
    }),
    attio_list_notes: tool({
      description:
        "List Attio notes globally, or for one record by passing both object and recordId.",
      inputSchema: jsonSchema<{
        object?: AttioObjectSlug;
        recordId?: string;
        limit?: number;
      }>({
        type: "object",
        additionalProperties: false,
        properties: {
          object: { type: "string", enum: [...STANDARD_OBJECTS] },
          recordId: { type: "string", minLength: 1, maxLength: 200 },
          limit: { type: "number", minimum: 1, maximum: MAX_NOTES },
        },
      }),
      execute: async (args) => {
        if (Boolean(args.object) !== Boolean(args.recordId)) {
          throw new Error("object and recordId must be provided together, or both omitted.");
        }
        const limit = clampCount(args.limit, 10, MAX_NOTES);
        const query = new URLSearchParams({ limit: String(limit) });
        if (args.object && args.recordId) {
          query.set("parent_object", requiredObject(args.object));
          query.set("parent_record_id", requiredString(args.recordId, "recordId", 200));
        }
        const response = await attioRequest(context, {
          path: "/notes?" + query.toString(),
        });
        return {
          notes: attioNoteList(response).slice(0, limit).map(compactAttioNote),
        };
      },
    }),
    attio_get_note: tool({
      description: "Get one Attio note by note id, including bounded plaintext content.",
      inputSchema: jsonSchema<{ noteId: string }>({
        type: "object",
        additionalProperties: false,
        properties: { noteId: { type: "string", minLength: 1, maxLength: 200 } },
        required: ["noteId"],
      }),
      execute: async (args) => {
        const noteId = requiredString(args.noteId, "noteId", 200);
        const response = await attioRequest(context, {
          path: "/notes/" + encodeURIComponent(noteId),
        });
        const note = attioNote(response);
        return {
          note: note
            ? compactAttioNote(attioNoteId(note) ? note : { ...note, id: { note_id: noteId } })
            : null,
        };
      },
    }),
  };
}

function createAttioCreateTools(context: AttioRequestContext): ToolSet {
  const guard = createSingleMutationGuard();
  const tools: ToolSet = {};
  if (context.connection.canCreateRecords) {
    tools.attio_create_person = tool({
      description:
        "Create one Attio person from typed common fields. Use only for the user's explicit creation request.",
      inputSchema: jsonSchema<{
        fullName: string;
        email?: string;
        jobTitle?: string;
        description?: string;
        companyRecordId?: string;
      }>({
        type: "object",
        additionalProperties: false,
        properties: {
          fullName: { type: "string", minLength: 1, maxLength: 200 },
          email: { type: "string", minLength: 3, maxLength: 320 },
          jobTitle: { type: "string", minLength: 1, maxLength: 300 },
          description: { type: "string", minLength: 1, maxLength: 4_000 },
          companyRecordId: { type: "string", minLength: 1, maxLength: 200 },
        },
        required: ["fullName"],
      }),
      execute: async (args) =>
        guard.run("attio_create_person", args, async () => {
          const values: Record<string, unknown> = {
            name: requiredString(args.fullName, "fullName", 200),
          };
          const email = optionalString(args.email, "email", 320);
          const jobTitle = optionalString(args.jobTitle, "jobTitle", 300);
          const description = optionalString(args.description, "description", 4_000);
          const companyRecordId = optionalString(args.companyRecordId, "companyRecordId", 200);
          if (email) values.email_addresses = [email];
          if (jobTitle) values.job_title = jobTitle;
          if (description) values.description = description;
          if (companyRecordId) {
            values.company = {
              target_object: "companies",
              target_record_id: companyRecordId,
            };
          }
          return await createRecord(context, "people", values);
        }),
    });
    tools.attio_create_company = tool({
      description:
        "Create one Attio company from typed common fields. Use only for the user's explicit creation request.",
      inputSchema: jsonSchema<{ name: string; domain?: string; description?: string }>({
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 300 },
          domain: { type: "string", minLength: 1, maxLength: 253 },
          description: { type: "string", minLength: 1, maxLength: 4_000 },
        },
        required: ["name"],
      }),
      execute: async (args) =>
        guard.run("attio_create_company", args, async () => {
          const values: Record<string, unknown> = {
            name: requiredString(args.name, "name", 300),
          };
          const domain = optionalString(args.domain, "domain", 253);
          const description = optionalString(args.description, "description", 4_000);
          if (domain) values.domains = [domain];
          if (description) values.description = description;
          return await createRecord(context, "companies", values);
        }),
    });
    tools.attio_create_deal = tool({
      description:
        "Create one Attio deal with optional typed relationships. Use only for the user's explicit creation request.",
      inputSchema: jsonSchema<{
        name: string;
        stage?: string;
        value?: number;
        companyRecordId?: string;
        personRecordIds?: string[];
      }>({
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 300 },
          stage: { type: "string", minLength: 1, maxLength: 200 },
          value: { type: "number", minimum: 0 },
          companyRecordId: { type: "string", minLength: 1, maxLength: 200 },
          personRecordIds: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 200 },
            maxItems: MAX_PEOPLE_PER_DEAL,
          },
        },
        required: ["name"],
      }),
      execute: async (args) =>
        guard.run("attio_create_deal", args, async () => {
          const values: Record<string, unknown> = {
            name: requiredString(args.name, "name", 300),
          };
          const stage = optionalString(args.stage, "stage", 200);
          const companyRecordId = optionalString(args.companyRecordId, "companyRecordId", 200);
          if (stage) values.stage = stage;
          if (args.value !== undefined) {
            if (typeof args.value !== "number" || !Number.isFinite(args.value) || args.value < 0) {
              throw new Error("value must be a finite non-negative number.");
            }
            values.value = args.value;
          }
          if (companyRecordId) {
            values.associated_company = {
              target_object: "companies",
              target_record_id: companyRecordId,
            };
          }
          if (args.personRecordIds !== undefined) {
            if (!Array.isArray(args.personRecordIds)) {
              throw new Error("personRecordIds must be an array.");
            }
            values.associated_people = args.personRecordIds
              .slice(0, MAX_PEOPLE_PER_DEAL)
              .map((recordId) => ({
                target_object: "people",
                target_record_id: requiredString(recordId, "personRecordId", 200),
              }));
          }
          return await createRecord(context, "deals", values);
        }),
    });
  }
  if (context.connection.canCreateNotes) {
    tools.attio_create_note = tool({
      description:
        "Create one markdown Attio note on a standard record. Use only for the user's explicit creation request.",
      inputSchema: jsonSchema<{
        object: AttioObjectSlug;
        recordId: string;
        title: string;
        content: string;
      }>({
        type: "object",
        additionalProperties: false,
        properties: {
          object: { type: "string", enum: [...STANDARD_OBJECTS] },
          recordId: { type: "string", minLength: 1, maxLength: 200 },
          title: { type: "string", minLength: 1, maxLength: 300 },
          content: { type: "string", minLength: 1, maxLength: MAX_CREATE_NOTE_CHARS },
        },
        required: ["object", "recordId", "title", "content"],
      }),
      execute: async (args) =>
        guard.run("attio_create_note", args, async () => {
          const response = await attioRequest(context, {
            path: "/notes",
            method: "POST",
            body: {
              data: {
                parent_object: requiredObject(args.object),
                parent_record_id: requiredString(args.recordId, "recordId", 200),
                title: requiredString(args.title, "title", 300),
                format: "markdown",
                content: requiredString(args.content, "content", MAX_CREATE_NOTE_CHARS),
              },
            },
          });
          const note = attioNote(response);
          if (!note || !attioNoteId(note)) {
            throw new Error("Attio note creation returned no note id.");
          }
          return { note: compactAttioNote(note) };
        }),
    });
  }
  return tools;
}

async function createRecord(
  context: AttioRequestContext,
  object: AttioObjectSlug,
  values: Record<string, unknown>,
) {
  const response = await attioRequest(context, {
    path: "/objects/" + object + "/records",
    method: "POST",
    body: { data: { values } },
  });
  const record = attioRecord(response);
  if (!record?.id?.record_id) throw new Error("Attio record creation returned no record id.");
  return { record: compactAttioRecord(record, object, context.objectSlugById) };
}

async function attioRequest(
  context: AttioRequestContext,
  input: { path: string; method?: "GET" | "POST"; body?: unknown },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(GOAT_ATTIO_API_BASE_URL + input.path, {
      method: input.method ?? "GET",
      headers: {
        Authorization: "Bearer " + context.apiKey,
        Accept: "application/json",
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(ATTIO_REQUEST_TIMEOUT_MS)]),
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
  } catch (error) {
    if (context.signal.aborted || isNamedError(error, "AbortError")) throw error;
    if (isNamedError(error, "TimeoutError")) {
      throw new Error("The Attio request timed out.");
    }
    throw new Error("Attio could not be reached. Try again in a moment.");
  }
  if (response.status === 401) {
    await markGoatIntegrationStatus({
      userWorkosId: context.userWorkosId,
      integrationId: context.connection.integrationId,
      provider: GOAT_ATTIO_PROVIDER,
      status: "needs_reauth",
      statusReason: "Attio rejected the saved API key.",
    }).catch(() => {});
    throw new GoatCapabilityAuthError(
      "auth_expired",
      "Attio rejected the saved API key; the user needs to reconnect Attio in Settings → Integrations.",
    );
  }
  if (response.status === 403) {
    throw new Error(
      "Attio denied this action because the API key is missing the required scope. Resave a key with object_configuration:read, record_permission:read-write, and note:read-write as needed.",
    );
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Attio returned a provider error (" + response.status + ").");
  if (response.status === 204) return null;
  return await response.json().catch(() => null);
}

function attioRecordList(response: unknown): AttioRecordInput[] {
  const data = asRecord(response)?.data;
  if (!Array.isArray(data)) return [];
  return data.filter((entry): entry is AttioRecordInput => {
    if (!isAttioRecordInput(entry)) return false;
    return typeof entry.id?.record_id === "string" && entry.id.record_id.length > 0;
  });
}

function attioRecord(response: unknown): AttioRecordInput | null {
  const data = asRecord(response)?.data;
  return isAttioRecordInput(data) ? data : null;
}

function attioNoteList(response: unknown): AttioNoteInput[] {
  const data = asRecord(response)?.data;
  if (!Array.isArray(data)) return [];
  return data.filter(
    (entry): entry is AttioNoteInput => isAttioNoteInput(entry) && Boolean(attioNoteId(entry)),
  );
}

function attioNote(response: unknown): AttioNoteInput | null {
  const data = asRecord(response)?.data;
  return isAttioNoteInput(data) ? data : null;
}

function attioNoteId(note: AttioNoteInput): string | null {
  const value = typeof note.id === "string" ? note.id : (note.id?.note_id ?? note.note_id);
  return typeof value === "string" && value ? value : null;
}

function isAttioRecordInput(value: unknown): value is AttioRecordInput {
  return asRecord(value) !== null;
}

function isAttioNoteInput(value: unknown): value is AttioNoteInput {
  return asRecord(value) !== null;
}

export function compactAttioRecord(
  record: AttioRecordInput,
  objectHint?: AttioObjectSlug,
  objectSlugById: ReadonlyMap<string, AttioObjectSlug> = new Map(),
) {
  const recordId = record.id?.record_id ?? "";
  const object =
    objectHint ??
    asObjectSlug(record.object) ??
    asObjectSlug(record.object_slug) ??
    objectSlugById.get(record.id?.object_id ?? "") ??
    "people";
  const properties: Record<string, string> = {};
  for (const [slug, entries] of Object.entries(record.values ?? {})) {
    if (Object.keys(properties).length >= MAX_PROPERTIES) break;
    const value = renderAttioValues(entries);
    if (value) properties[slug] = truncate(value, MAX_PROPERTY_CHARS);
  }
  const title =
    properties.name ??
    properties.full_name ??
    properties.email_addresses ??
    singularObjectName(object) + " " + (recordId || "record");
  const url = safeUrl(record.web_url);
  return {
    object,
    id: recordId,
    title,
    ...(url ? { url } : {}),
    ...(record.created_at ? { createdAt: record.created_at } : {}),
    properties,
    entity: {
      type: "attio_record",
      id: object + ":" + recordId,
      ...(url ? { url } : {}),
      title,
    },
  };
}

export function compactAttioNote(note: AttioNoteInput) {
  const noteId = attioNoteId(note) ?? "";
  const title =
    typeof note.title === "string" && note.title.trim() ? note.title.trim() : "Untitled note";
  const content =
    typeof note.content_plaintext === "string"
      ? note.content_plaintext
      : typeof note.content === "string"
        ? note.content
        : "";
  const url = safeUrl(note.web_url);
  return {
    id: noteId,
    title,
    ...(url ? { url } : {}),
    ...(note.parent_object ? { parentObject: note.parent_object } : {}),
    ...(note.parent_record_id ? { parentRecordId: note.parent_record_id } : {}),
    ...(note.created_at ? { createdAt: note.created_at } : {}),
    ...(content ? { content: truncate(content, MAX_NOTE_CONTENT_CHARS) } : {}),
    entity: {
      type: "attio_note",
      id: noteId,
      ...(url ? { url } : {}),
      title,
    },
  };
}

function renderAttioValues(entries: unknown): string | null {
  if (!Array.isArray(entries)) return primitiveString(entries);
  const rendered = entries
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
    )
    .filter((entry) => entry.active_until == null)
    .map(renderAttioValue)
    .filter((value): value is string => Boolean(value));
  return rendered.length > 0 ? rendered.join("; ") : null;
}

function renderAttioValue(value: Record<string, unknown>): string | null {
  const type = typeof value.attribute_type === "string" ? value.attribute_type : "";
  if (type === "interaction" || type === "actor-reference") return null;
  if (type === "personal-name") {
    return (
      primitiveString(value.full_name) ??
      [primitiveString(value.first_name), primitiveString(value.last_name)]
        .filter(Boolean)
        .join(" ") ??
      null
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
  if (type === "record-reference") return primitiveString(value.target_record_id);
  return (
    primitiveString(value.value) ??
    primitiveString(value.name) ??
    primitiveString(value.title) ??
    primitiveString(value.full_name)
  );
}

function createSingleMutationGuard() {
  let successful: { signature: string; output: unknown } | undefined;
  let mutationInFlight = false;
  return {
    async run<T>(toolName: string, args: unknown, mutate: () => Promise<T>): Promise<T> {
      const signature = toolName + ":" + stableStringify(args);
      if (successful?.signature === signature) return successful.output as T;
      if (successful) {
        throw new Error(
          "This worker already completed one Attio creation. Dispatch another capability call for an additional creation.",
        );
      }
      if (mutationInFlight) {
        throw new Error("Another Attio creation is already in progress in this worker.");
      }
      mutationInFlight = true;
      try {
        const output = await mutate();
        successful = { signature, output };
        return output;
      } finally {
        mutationInFlight = false;
      }
    },
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => JSON.stringify(key) + ":" + stableStringify(entry))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function normalizeObjects(value: unknown): AttioObjectSlug[] {
  if (!Array.isArray(value) || value.length === 0) return [...STANDARD_OBJECTS];
  return [...new Set(value.map(requiredObject))];
}

function requiredObject(value: unknown): AttioObjectSlug {
  if (typeof value === "string" && (STANDARD_OBJECTS as readonly string[]).includes(value)) {
    return value as AttioObjectSlug;
  }
  throw new Error("object must be one of people, companies, or deals.");
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(field + " must be a non-empty string.");
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(field + " must be at most " + maxLength + " characters.");
  }
  return normalized;
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, field, maxLength);
}

function clampCount(value: unknown, fallback: number, max: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(1, Math.floor(value)))
    : fallback;
}

function asObjectSlug(value: unknown): AttioObjectSlug | undefined {
  return typeof value === "string" && (STANDARD_OBJECTS as readonly string[]).includes(value)
    ? (value as AttioObjectSlug)
    : undefined;
}

function singularObjectName(object: AttioObjectSlug) {
  if (object === "people") return "Person";
  if (object === "companies") return "Company";
  return "Deal";
}

function primitiveString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : value.slice(0, Math.max(0, max - 1)) + "…";
}

function isNamedError(error: unknown, name: string) {
  return error instanceof Error && error.name === name;
}
