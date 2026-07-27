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
  effectiveCapabilityMode,
  type GoatCapabilityId,
  providerCapability,
} from "@/lib/actions/capabilities";
import {
  GoatActionAuthError,
  type GoatActionExecuteContext,
  GoatActionInvalidParamsError,
  GoatActionPermissionError,
  type GoatActionProviderCatalog,
  type ResolvedGoatAction,
  requiredStringParam,
} from "@/lib/actions/types";
import {
  GoatAttioApiRequestError,
  hasGoatAttioListConfigurationWriteScope,
  hasGoatAttioListReadScopes,
  hasGoatAttioListWriteScopes,
  hasGoatAttioRecordWriteScopes,
  requestGoatAttioApi,
} from "@/lib/integrations/attio";

const STANDARD_OBJECTS = ["people", "companies", "deals"] as const;
const MAX_SEARCH_RECORDS = 10;
const DEFAULT_SEARCH_RECORDS = 5;
const MAX_LISTS = 50;
const DEFAULT_LISTS = 25;
const MAX_LIST_ENTRIES = 20;
const DEFAULT_LIST_ENTRIES = 10;
const MAX_RECORD_ENTRIES = 50;
const DEFAULT_RECORD_ENTRIES = 25;
const MAX_LIST_OFFSET = 10_000;
const MAX_QUERY_CHARS = 256;
const MAX_LIST_REFERENCE_CHARS = 2_000;
const MAX_ATTRIBUTE_REFERENCE_CHARS = 200;
const MAX_RECORD_ID_CHARS = 200;
const MAX_ENTRY_ID_CHARS = 200;
const MAX_ATTRIBUTES = 30;
const MAX_ATTRIBUTE_OPTIONS = 25;
const MAX_FILTER_PROPERTIES = 12;
const MAX_SORTS = 3;
const MAX_WRITE_PROPERTIES = 20;
const MAX_WRITE_JSON_CHARS = 12_000;
const MAX_FILTER_JSON_CHARS = 6_000;
const MAX_JSON_DEPTH = 5;
const MAX_JSON_ARRAY_ITEMS = 50;
const MAX_JSON_OBJECT_PROPERTIES = 50;
const MAX_JSON_STRING_CHARS = 2_000;
const MAX_SEARCH_PROPERTIES = 8;
const MAX_DETAIL_PROPERTIES = 24;
const MAX_LIST_PROPERTIES = 12;
const MAX_PROPERTY_CHARS = 200;
const MAX_TITLE_CHARS = 200;
const MAX_TARGET_TIME_IN_STATUS_CHARS = 100;

const LIST_ATTRIBUTE_TYPES = ["status", "select", "text"] as const;

type AttioObjectSlug = (typeof STANDARD_OBJECTS)[number];
type AttioListAttributeType = (typeof LIST_ATTRIBUTE_TYPES)[number];

type AttioConnection = {
  integrationId: string;
  workspaceId: string;
  workspaceName: string | null;
  selector: string;
  scopes: string[];
  capabilityModes: unknown;
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

type AttioListEntryInput = {
  id?: { entry_id?: unknown };
  parent_record_id?: unknown;
  parent_object?: unknown;
  created_at?: unknown;
  entry_values?: unknown;
};

type AttioRecordEntryInput = {
  list_id?: unknown;
  list_api_slug?: unknown;
  entry_id?: unknown;
  created_at?: unknown;
};

type AttioAttributeInput = {
  id?: { attribute_id?: unknown };
  title?: unknown;
  description?: unknown;
  api_slug?: unknown;
  type?: unknown;
  is_system_attribute?: unknown;
  is_writable?: unknown;
  is_required?: unknown;
  is_unique?: unknown;
  is_multiselect?: unknown;
  is_archived?: unknown;
};

type AttioStatusInput = {
  id?: { status_id?: unknown };
  title?: unknown;
  is_archived?: unknown;
  celebration_enabled?: unknown;
  target_time_in_status?: unknown;
};

type AttioSelectOptionInput = {
  id?: { option_id?: unknown };
  title?: unknown;
  is_archived?: unknown;
};

export async function resolveAttioActions(
  userWorkosId: string,
): Promise<GoatActionProviderCatalog | null> {
  const connections = await loadAttioConnections(userWorkosId);
  if (connections.length === 0) return null;

  const readConnections = eligibleConnections(connections, "read");
  const writeConnections = eligibleConnections(connections, "write");
  const listReadConnections = readConnections.filter((connection) =>
    hasGoatAttioListReadScopes(connection.scopes),
  );
  // Reads remain backward-compatible with connections saved before scope
  // tracking, but mutations fail closed unless Attio explicitly reported the
  // required read-write scope.
  const recordWriteConnections = writeConnections.filter((connection) =>
    hasGoatAttioRecordWriteScopes(connection.scopes),
  );
  const listWriteConnections = writeConnections.filter((connection) =>
    hasGoatAttioListWriteScopes(connection.scopes),
  );
  const listConfigurationWriteConnections = writeConnections.filter((connection) =>
    hasGoatAttioListConfigurationWriteScope(connection.scopes),
  );
  if (
    readConnections.length === 0 &&
    recordWriteConnections.length === 0 &&
    listWriteConnections.length === 0 &&
    listConfigurationWriteConnections.length === 0
  ) {
    return null;
  }

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

  const actions: ResolvedGoatAction[] = [];

  if (readConnections.length > 0) {
    const multipleAccounts = readConnections.length > 1;
    const accountParam = attioAccountParam(readConnections, "read");
    actions.push({
      id: "attio.search_records",
      provider: "attio",
      capability: "read",
      ...permissionAnnotation("read", readConnections),
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
          readConnections,
          multipleAccounts ? requiredStringParam(params, "account") : undefined,
        );
        const limit = parseLimit(params.limit, {
          fallback: DEFAULT_SEARCH_RECORDS,
          max: MAX_SEARCH_RECORDS,
        });
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
    });

    actions.push({
      id: "attio.get_record",
      provider: "attio",
      capability: "read",
      ...permissionAnnotation("read", readConnections),
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
          readConnections,
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
        const response = await callAttioApi({
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
    });

    actions.push({
      id: "attio.list_record_attributes",
      provider: "attio",
      capability: "read",
      ...permissionAnnotation("read", readConnections),
      description:
        "List the fields available on an Attio people, companies, or deals object, including writable flags and valid status/select options. Use this before attio.update_record when the field slug or accepted value is unclear.",
      params: {
        type: "object",
        additionalProperties: false,
        required: multipleAccounts ? ["object", "account"] : ["object"],
        properties: {
          object: {
            type: "string",
            enum: [...STANDARD_OBJECTS],
            description: "The Attio record type whose fields should be described.",
          },
          ...accountParam,
        },
      },
      execute: async (params, context) => {
        assertKnownParams(params, multipleAccounts ? ["object", "account"] : ["object"]);
        const connection = resolveConnection(
          readConnections,
          multipleAccounts ? requiredStringParam(params, "account") : undefined,
        );
        const credential = await getCredential(context, connection);
        const object = parseObject(
          requiredStringParam(params, "object"),
          credential.availableObjects,
        );
        return await listAttioAttributes({
          context,
          connection,
          credential,
          target: "objects",
          identifier: object,
        });
      },
    });
  }

  if (listReadConnections.length > 0) {
    const multipleListAccounts = listReadConnections.length > 1;
    const listAccountParam = attioAccountParam(listReadConnections, "read");

    actions.push({
      id: "attio.list_lists",
      provider: "attio",
      capability: "read",
      ...permissionAnnotation("read", listReadConnections),
      description:
        "List the Attio lists/collections available in a workspace. Use this to resolve a human list name to the UUID or API slug accepted by attio.query_list and the list-entry actions.",
      params: {
        type: "object",
        additionalProperties: false,
        required: multipleListAccounts ? ["account"] : [],
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: MAX_QUERY_CHARS,
            description: "Optional case-insensitive text match against list names and API slugs.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_LISTS,
            description: `Maximum lists to return (default ${DEFAULT_LISTS}, max ${MAX_LISTS}).`,
          },
          offset: {
            type: "integer",
            minimum: 0,
            maximum: MAX_LIST_OFFSET,
            description: "Number of matching lists to skip (default 0).",
          },
          ...listAccountParam,
        },
      },
      execute: async (params, context) => {
        assertKnownParams(
          params,
          multipleListAccounts
            ? ["query", "limit", "offset", "account"]
            : ["query", "limit", "offset"],
        );
        const connection = resolveConnection(
          listReadConnections,
          multipleListAccounts ? requiredStringParam(params, "account") : undefined,
        );
        const query = optionalAttioStringParam(params, "query");
        if (query && query.length > MAX_QUERY_CHARS) {
          throw new GoatActionInvalidParamsError(
            `"query" must be at most ${MAX_QUERY_CHARS} characters.`,
          );
        }
        const limit = parseLimit(params.limit, { fallback: DEFAULT_LISTS, max: MAX_LISTS });
        const offset = parseOffset(params.offset);
        const credential = await getCredential(context, connection);
        const response = await callAttioApi({
          context,
          connection,
          credential,
          path: "/lists",
        });
        const normalizedQuery = query?.toLowerCase();
        const matches = attioListList(response).filter((list) => {
          if (!normalizedQuery) return true;
          return (
            list.name?.toLowerCase().includes(normalizedQuery) ||
            list.apiSlug?.toLowerCase().includes(normalizedQuery)
          );
        });
        const lists = matches.slice(offset, offset + limit);
        const hasMore = matches.length > offset + limit;
        return {
          workspace: connection.selector,
          lists,
          offset,
          limit,
          hasMore,
          ...(hasMore ? { nextOffset: offset + limit } : {}),
        };
      },
    });

    actions.push({
      id: "attio.list_list_attributes",
      provider: "attio",
      capability: "read",
      ...permissionAnnotation("read", listReadConnections),
      description:
        "List the fields available on an Attio list/collection entry, including writable flags and valid status/select options. Use this before attio.update_list_entry when the field slug or accepted value is unclear.",
      params: {
        type: "object",
        additionalProperties: false,
        required: multipleListAccounts ? ["list", "account"] : ["list"],
        properties: {
          list: {
            type: "string",
            minLength: 1,
            maxLength: MAX_LIST_REFERENCE_CHARS,
            description: "An Attio list UUID, API slug, or full collection/view URL.",
          },
          ...listAccountParam,
        },
      },
      execute: async (params, context) => {
        assertKnownParams(params, multipleListAccounts ? ["list", "account"] : ["list"]);
        const connection = resolveConnection(
          listReadConnections,
          multipleListAccounts ? requiredStringParam(params, "account") : undefined,
        );
        const reference = parseAttioListReference(requiredStringParam(params, "list"));
        const credential = await getCredential(context, connection);
        return await listAttioAttributes({
          context,
          connection,
          credential,
          target: "lists",
          identifier: reference.list,
        });
      },
    });

    actions.push({
      id: "attio.list_record_entries",
      provider: "attio",
      capability: "read",
      ...permissionAnnotation("read", listReadConnections),
      description:
        "List every Attio list/collection entry that a person, company, or deal belongs to. Returns list ids/slugs and entry ids; use it to locate the pipeline entry for attio.update_list_entry.",
      params: {
        type: "object",
        additionalProperties: false,
        required: multipleListAccounts
          ? ["object", "record_id", "account"]
          : ["object", "record_id"],
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
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_RECORD_ENTRIES,
            description: `Maximum memberships to return (default ${DEFAULT_RECORD_ENTRIES}, max ${MAX_RECORD_ENTRIES}).`,
          },
          offset: {
            type: "integer",
            minimum: 0,
            maximum: MAX_LIST_OFFSET,
            description: "Number of memberships to skip (default 0).",
          },
          ...listAccountParam,
        },
      },
      execute: async (params, context) => {
        assertKnownParams(
          params,
          multipleListAccounts
            ? ["object", "record_id", "limit", "offset", "account"]
            : ["object", "record_id", "limit", "offset"],
        );
        const connection = resolveConnection(
          listReadConnections,
          multipleListAccounts ? requiredStringParam(params, "account") : undefined,
        );
        const credential = await getCredential(context, connection);
        const object = parseObject(
          requiredStringParam(params, "object"),
          credential.availableObjects,
        );
        const recordId = parseBoundedId(params, "record_id", MAX_RECORD_ID_CHARS);
        const limit = parseLimit(params.limit, {
          fallback: DEFAULT_RECORD_ENTRIES,
          max: MAX_RECORD_ENTRIES,
        });
        const offset = parseOffset(params.offset);
        const response = await callAttioApi({
          context,
          connection,
          credential,
          path: `/objects/${encodeURIComponent(object)}/records/${encodeURIComponent(recordId)}/entries?limit=${limit}&offset=${offset}`,
        });
        const entries = attioRecordEntryList(response, limit);
        return {
          workspace: connection.selector,
          object,
          recordId,
          entries,
          offset,
          limit,
          hasMore: entries.length === limit,
          ...(entries.length === limit ? { nextOffset: offset + limit } : {}),
        };
      },
    });

    actions.push({
      id: "attio.query_list",
      provider: "attio",
      capability: "read",
      ...permissionAnnotation("read", listReadConnections),
      description:
        "Read entries from an Attio list, optionally using a saved view, bounded Attio filter, and field sorting. Returns list values plus hydrated parent CRM records and entry ids.",
      params: {
        type: "object",
        additionalProperties: false,
        required: multipleListAccounts ? ["list", "account"] : ["list"],
        properties: {
          list: {
            type: "string",
            minLength: 1,
            maxLength: MAX_LIST_REFERENCE_CHARS,
            description:
              "An Attio list UUID, API slug, or full app.attio.com collection URL. A /view/{uuid} suffix is applied automatically.",
          },
          view: {
            type: "string",
            minLength: 1,
            maxLength: MAX_LIST_REFERENCE_CHARS,
            description:
              "Optional saved-view UUID or full Attio collection URL. Omit when the list URL already contains /view/{uuid}.",
          },
          filter: {
            type: "object",
            description:
              'Optional Attio filter object. Simple equality example: {"status":"In Progress"}. Advanced Attio $and/$or/comparison/path filters are also accepted. Cannot be combined with a saved view.',
          },
          sorts: {
            type: "array",
            maxItems: MAX_SORTS,
            description: "Optional field sorts, evaluated in order.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["direction", "attribute"],
              properties: {
                direction: { type: "string", enum: ["asc", "desc"] },
                attribute: {
                  type: "string",
                  description: "List attribute slug or UUID.",
                },
                field: {
                  type: "string",
                  description: "Optional subfield for composite values.",
                },
              },
            },
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_LIST_ENTRIES,
            description: `Maximum entries to return (default ${DEFAULT_LIST_ENTRIES}, max ${MAX_LIST_ENTRIES}).`,
          },
          offset: {
            type: "integer",
            minimum: 0,
            maximum: MAX_LIST_OFFSET,
            description: "Number of matching entries to skip for pagination (default 0).",
          },
          ...listAccountParam,
        },
      },
      execute: async (params, context) => {
        assertKnownParams(
          params,
          multipleListAccounts
            ? ["list", "view", "filter", "sorts", "limit", "offset", "account"]
            : ["list", "view", "filter", "sorts", "limit", "offset"],
        );
        const reference = parseAttioListReference(
          requiredStringParam(params, "list"),
          optionalAttioStringParam(params, "view"),
        );
        const filter = parseAttioFilter(params.filter);
        if (reference.viewId && filter) {
          throw new GoatActionInvalidParamsError(
            '"filter" cannot be combined with a saved view; use either "view" or "filter".',
          );
        }
        const sorts = parseAttioSorts(params.sorts);
        const connection = resolveConnection(
          listReadConnections,
          multipleListAccounts ? requiredStringParam(params, "account") : undefined,
        );
        const limit = parseLimit(params.limit, {
          fallback: DEFAULT_LIST_ENTRIES,
          max: MAX_LIST_ENTRIES,
        });
        const offset = parseOffset(params.offset);
        const credential = await getCredential(context, connection);
        return await queryAttioList({
          context,
          connection,
          credential,
          list: reference.list,
          ...(reference.viewId ? { viewId: reference.viewId } : {}),
          ...(filter ? { filter } : {}),
          ...(sorts ? { sorts } : {}),
          limit,
          offset,
        });
      },
    });
  }

  if (recordWriteConnections.length > 0) {
    const multipleWriteAccounts = recordWriteConnections.length > 1;
    const writeAccountParam = attioAccountParam(recordWriteConnections, "update");
    actions.push({
      id: "attio.update_record",
      provider: "attio",
      capability: "write",
      ...permissionAnnotation("write", recordWriteConnections),
      description:
        "Update fields on an existing Attio person, company, or deal. This sets the supplied fields only and overwrites multiselect fields; use an empty array to clear a multiselect. Use only when the user explicitly asked to change the CRM record.",
      params: {
        type: "object",
        additionalProperties: false,
        required: multipleWriteAccounts
          ? ["object", "record_id", "values", "account"]
          : ["object", "record_id", "values"],
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
          values: {
            type: "object",
            minProperties: 1,
            maxProperties: MAX_WRITE_PROPERTIES,
            description:
              "Fields to set, keyed by attribute API slug or UUID. Values follow Attio's write format; status/select values may use their title strings.",
          },
          ...writeAccountParam,
        },
      },
      execute: async (params, context) => {
        assertKnownParams(
          params,
          multipleWriteAccounts
            ? ["object", "record_id", "values", "account"]
            : ["object", "record_id", "values"],
        );
        const connection = resolveConnection(
          recordWriteConnections,
          multipleWriteAccounts ? requiredStringParam(params, "account") : undefined,
        );
        const credential = await getCredential(context, connection);
        const object = parseObject(
          requiredStringParam(params, "object"),
          credential.availableObjects,
        );
        const recordId = parseBoundedId(params, "record_id", MAX_RECORD_ID_CHARS);
        const values = parseAttioWriteValues(params.values);
        await assertAttioWriteStillEnabled(context, connection, "record");
        const response = await callAttioApi({
          context,
          connection,
          credential,
          path: `/objects/${encodeURIComponent(object)}/records/${encodeURIComponent(recordId)}`,
          method: "PUT",
          body: { data: { values } },
        });
        const record = asRecord(asRecord(response)?.data) as AttioRecordInput | null;
        const compact = record
          ? compactAttioRecord(record, credential.objectSlugById, MAX_DETAIL_PROPERTIES)
          : null;
        if (!compact) {
          throw new Error("Attio returned an invalid updated record response.");
        }
        return { workspace: connection.selector, record: compact };
      },
    });
  }

  if (listConfigurationWriteConnections.length > 0) {
    const multipleWriteAccounts = listConfigurationWriteConnections.length > 1;
    const writeAccountParam = attioAccountParam(listConfigurationWriteConnections, "configure");

    actions.push({
      id: "attio.create_attribute",
      provider: "attio",
      capability: "write",
      ...permissionAnnotation("write", listConfigurationWriteConnections),
      description:
        "Create a status, select, or text field on an Attio list/collection. Use the returned attribute API slug or id with attio.create_status or attio.create_select_option, then write entry values by option title. Use only when the user explicitly asked to configure the list.",
      params: {
        type: "object",
        additionalProperties: false,
        required: multipleWriteAccounts
          ? ["list", "title", "api_slug", "type", "account"]
          : ["list", "title", "api_slug", "type"],
        properties: {
          list: {
            type: "string",
            minLength: 1,
            maxLength: MAX_LIST_REFERENCE_CHARS,
            description: "An Attio list UUID, API slug, or full collection/view URL.",
          },
          title: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TITLE_CHARS,
            description: 'The human-readable field title, for example "Stage".',
          },
          api_slug: {
            type: "string",
            minLength: 1,
            maxLength: MAX_ATTRIBUTE_REFERENCE_CHARS,
            pattern: "^[a-z0-9_-]+$",
            description:
              'A stable lowercase API slug used to write values, for example "stage". Must be unique on the list.',
          },
          type: {
            type: "string",
            enum: [...LIST_ATTRIBUTE_TYPES],
            description: "The list field type.",
          },
          description: {
            type: "string",
            minLength: 1,
            maxLength: MAX_PROPERTY_CHARS,
            description: "Optional explanation of what the field tracks.",
          },
          is_multiselect: {
            type: "boolean",
            description:
              "Whether text or select fields accept multiple values (default false). Status fields cannot be multiselect.",
          },
          ...writeAccountParam,
        },
      },
      execute: async (params, context) => {
        assertKnownParams(
          params,
          multipleWriteAccounts
            ? ["list", "title", "api_slug", "type", "description", "is_multiselect", "account"]
            : ["list", "title", "api_slug", "type", "description", "is_multiselect"],
        );
        const connection = resolveConnection(
          listConfigurationWriteConnections,
          multipleWriteAccounts ? requiredStringParam(params, "account") : undefined,
        );
        const reference = parseAttioListReference(requiredStringParam(params, "list"));
        const title = parseBoundedId(params, "title", MAX_TITLE_CHARS);
        const apiSlug = parseAttioApiSlug(params.api_slug);
        const type = parseAttioListAttributeType(params.type);
        const description = optionalAttioStringParam(params, "description");
        if (description && description.length > MAX_PROPERTY_CHARS) {
          throw new GoatActionInvalidParamsError(
            `"description" must be at most ${MAX_PROPERTY_CHARS} characters.`,
          );
        }
        const isMultiselect = optionalBooleanParam(params, "is_multiselect") ?? false;
        if (type === "status" && isMultiselect) {
          throw new GoatActionInvalidParamsError(
            '"is_multiselect" cannot be true for a status attribute.',
          );
        }
        const credential = await getCredential(context, connection);
        await assertAttioWriteStillEnabled(context, connection, "list_configuration");
        const response = await callAttioApi({
          context,
          connection,
          credential,
          path: `/lists/${encodeURIComponent(reference.list)}/attributes`,
          method: "POST",
          body: {
            data: {
              title,
              description: description ?? "",
              api_slug: apiSlug,
              type,
              is_required: false,
              is_unique: false,
              is_multiselect: isMultiselect,
              config: {},
            },
          },
        });
        const attribute = compactAttioAttribute(asRecord(response)?.data);
        if (!attribute) {
          throw new Error("Attio returned an invalid created attribute response.");
        }
        return {
          workspace: connection.selector,
          list: reference.list,
          attribute,
        };
      },
    });

    actions.push({
      id: "attio.create_status",
      provider: "attio",
      capability: "write",
      ...permissionAnnotation("write", listConfigurationWriteConnections),
      description:
        "Add one option to a status field on an Attio list/collection. Call once per stage, in the desired pipeline order. target_time_in_status is an optional ISO-8601 duration. Use only when the user explicitly asked to configure the pipeline.",
      params: {
        type: "object",
        additionalProperties: false,
        required: multipleWriteAccounts
          ? ["list", "attribute", "title", "account"]
          : ["list", "attribute", "title"],
        properties: {
          list: {
            type: "string",
            minLength: 1,
            maxLength: MAX_LIST_REFERENCE_CHARS,
            description: "An Attio list UUID, API slug, or full collection/view URL.",
          },
          attribute: {
            type: "string",
            minLength: 1,
            maxLength: MAX_ATTRIBUTE_REFERENCE_CHARS,
            description: "The status attribute API slug or UUID returned by create_attribute.",
          },
          title: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TITLE_CHARS,
            description: 'The status title, for example "Contacted".',
          },
          celebration_enabled: {
            type: "boolean",
            description:
              "Whether entering this status triggers Attio's celebration (default false).",
          },
          target_time_in_status: {
            type: "string",
            minLength: 2,
            maxLength: MAX_TARGET_TIME_IN_STATUS_CHARS,
            description: 'Optional ISO-8601 duration target, for example "P7D" or "PT24H".',
          },
          ...writeAccountParam,
        },
      },
      execute: async (params, context) => {
        assertKnownParams(
          params,
          multipleWriteAccounts
            ? [
                "list",
                "attribute",
                "title",
                "celebration_enabled",
                "target_time_in_status",
                "account",
              ]
            : ["list", "attribute", "title", "celebration_enabled", "target_time_in_status"],
        );
        const connection = resolveConnection(
          listConfigurationWriteConnections,
          multipleWriteAccounts ? requiredStringParam(params, "account") : undefined,
        );
        const reference = parseAttioListReference(requiredStringParam(params, "list"));
        const attribute = parseSafeAttioIdentifier(params.attribute, "attribute");
        const title = parseBoundedId(params, "title", MAX_TITLE_CHARS);
        const celebrationEnabled = optionalBooleanParam(params, "celebration_enabled") ?? false;
        const targetTimeInStatus = parseOptionalAttioDuration(params.target_time_in_status);
        const credential = await getCredential(context, connection);
        await assertAttioWriteStillEnabled(context, connection, "list_configuration");
        const response = await callAttioApi({
          context,
          connection,
          credential,
          path: `/lists/${encodeURIComponent(reference.list)}/attributes/${encodeURIComponent(attribute)}/statuses`,
          method: "POST",
          body: {
            data: {
              title,
              celebration_enabled: celebrationEnabled,
              ...(targetTimeInStatus ? { target_time_in_status: targetTimeInStatus } : {}),
            },
          },
        });
        const status = compactAttioStatus(asRecord(response)?.data);
        if (!status) {
          throw new Error("Attio returned an invalid created status response.");
        }
        return {
          workspace: connection.selector,
          list: reference.list,
          attribute,
          status,
        };
      },
    });

    actions.push({
      id: "attio.create_select_option",
      provider: "attio",
      capability: "write",
      ...permissionAnnotation("write", listConfigurationWriteConnections),
      description:
        "Add one option to a select field on an Attio list/collection. Call once per option, in the desired display order. Entry values can then be written by title. Use only when the user explicitly asked to configure the list.",
      params: {
        type: "object",
        additionalProperties: false,
        required: multipleWriteAccounts
          ? ["list", "attribute", "title", "account"]
          : ["list", "attribute", "title"],
        properties: {
          list: {
            type: "string",
            minLength: 1,
            maxLength: MAX_LIST_REFERENCE_CHARS,
            description: "An Attio list UUID, API slug, or full collection/view URL.",
          },
          attribute: {
            type: "string",
            minLength: 1,
            maxLength: MAX_ATTRIBUTE_REFERENCE_CHARS,
            description: "The select attribute API slug or UUID returned by create_attribute.",
          },
          title: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TITLE_CHARS,
            description: "The select option title.",
          },
          ...writeAccountParam,
        },
      },
      execute: async (params, context) => {
        assertKnownParams(
          params,
          multipleWriteAccounts
            ? ["list", "attribute", "title", "account"]
            : ["list", "attribute", "title"],
        );
        const connection = resolveConnection(
          listConfigurationWriteConnections,
          multipleWriteAccounts ? requiredStringParam(params, "account") : undefined,
        );
        const reference = parseAttioListReference(requiredStringParam(params, "list"));
        const attribute = parseSafeAttioIdentifier(params.attribute, "attribute");
        const title = parseBoundedId(params, "title", MAX_TITLE_CHARS);
        const credential = await getCredential(context, connection);
        await assertAttioWriteStillEnabled(context, connection, "list_configuration");
        const response = await callAttioApi({
          context,
          connection,
          credential,
          path: `/lists/${encodeURIComponent(reference.list)}/attributes/${encodeURIComponent(attribute)}/options`,
          method: "POST",
          body: { data: { title } },
        });
        const option = compactAttioSelectOption(asRecord(response)?.data);
        if (!option) {
          throw new Error("Attio returned an invalid created select option response.");
        }
        return {
          workspace: connection.selector,
          list: reference.list,
          attribute,
          option,
        };
      },
    });
  }

  if (listWriteConnections.length > 0) {
    const multipleWriteAccounts = listWriteConnections.length > 1;
    const writeAccountParam = attioAccountParam(listWriteConnections, "update");
    actions.push({
      id: "attio.add_record_to_list",
      provider: "attio",
      capability: "write",
      ...permissionAnnotation("write", listWriteConnections),
      description:
        "Add an existing Attio person, company, or deal to a list/collection. This is idempotent when the record has at most one existing entry in the list. Optional values set list fields such as stage, status, or owner. Use only when the user explicitly asked to add the record.",
      params: {
        type: "object",
        additionalProperties: false,
        required: multipleWriteAccounts
          ? ["list", "object", "record_id", "account"]
          : ["list", "object", "record_id"],
        properties: {
          list: {
            type: "string",
            minLength: 1,
            maxLength: MAX_LIST_REFERENCE_CHARS,
            description: "An Attio list UUID, API slug, or full collection/view URL.",
          },
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
          values: {
            type: "object",
            minProperties: 1,
            maxProperties: MAX_WRITE_PROPERTIES,
            description:
              "Optional initial list fields, keyed by attribute API slug or UUID. Values follow Attio's write format; status/select values may use their title strings.",
          },
          ...writeAccountParam,
        },
      },
      execute: async (params, context) => {
        assertKnownParams(
          params,
          multipleWriteAccounts
            ? ["list", "object", "record_id", "values", "account"]
            : ["list", "object", "record_id", "values"],
        );
        const connection = resolveConnection(
          listWriteConnections,
          multipleWriteAccounts ? requiredStringParam(params, "account") : undefined,
        );
        const reference = parseAttioListReference(requiredStringParam(params, "list"));
        const credential = await getCredential(context, connection);
        const object = parseObject(
          requiredStringParam(params, "object"),
          credential.availableObjects,
        );
        const recordId = parseBoundedId(params, "record_id", MAX_RECORD_ID_CHARS);
        const values =
          params.values === undefined || params.values === null
            ? {}
            : parseAttioWriteValues(params.values);
        await assertAttioWriteStillEnabled(context, connection, "list_entry");
        const response = await callAttioApi({
          context,
          connection,
          credential,
          path: `/lists/${encodeURIComponent(reference.list)}/entries`,
          method: "PUT",
          body: {
            data: {
              parent_record_id: recordId,
              parent_object: object,
              entry_values: values,
            },
          },
        });
        const entry = asRecord(asRecord(response)?.data) as AttioListEntryInput | null;
        const compact = entry ? compactAttioListEntry(entry, new Map()) : null;
        if (!compact) {
          throw new Error("Attio returned an invalid list membership response.");
        }
        return {
          workspace: connection.selector,
          list: reference.list,
          entry: compact,
        };
      },
    });

    actions.push({
      id: "attio.update_list_entry",
      provider: "attio",
      capability: "write",
      ...permissionAnnotation("write", listWriteConnections),
      description:
        "Update pipeline/list fields such as stage, status, or owner on one existing Attio list entry. This sets supplied fields only and overwrites multiselect fields; use the entry id returned by attio.query_list or attio.list_record_entries. Use only when the user explicitly asked for the change.",
      params: {
        type: "object",
        additionalProperties: false,
        required: multipleWriteAccounts
          ? ["list", "entry_id", "values", "account"]
          : ["list", "entry_id", "values"],
        properties: {
          list: {
            type: "string",
            minLength: 1,
            maxLength: MAX_LIST_REFERENCE_CHARS,
            description: "An Attio list UUID, API slug, or full collection/view URL.",
          },
          entry_id: {
            type: "string",
            minLength: 1,
            maxLength: MAX_ENTRY_ID_CHARS,
            description:
              "The list entry id returned by attio.query_list or attio.list_record_entries.",
          },
          values: {
            type: "object",
            minProperties: 1,
            maxProperties: MAX_WRITE_PROPERTIES,
            description:
              "List fields to set, keyed by attribute API slug or UUID. Values follow Attio's write format; status/select values may use their title strings.",
          },
          ...writeAccountParam,
        },
      },
      execute: async (params, context) => {
        assertKnownParams(
          params,
          multipleWriteAccounts
            ? ["list", "entry_id", "values", "account"]
            : ["list", "entry_id", "values"],
        );
        const connection = resolveConnection(
          listWriteConnections,
          multipleWriteAccounts ? requiredStringParam(params, "account") : undefined,
        );
        const reference = parseAttioListReference(requiredStringParam(params, "list"));
        const entryId = parseBoundedId(params, "entry_id", MAX_ENTRY_ID_CHARS);
        const values = parseAttioWriteValues(params.values);
        const credential = await getCredential(context, connection);
        await assertAttioWriteStillEnabled(context, connection, "list_entry");
        const response = await callAttioApi({
          context,
          connection,
          credential,
          path: `/lists/${encodeURIComponent(reference.list)}/entries/${encodeURIComponent(entryId)}`,
          method: "PUT",
          body: { data: { entry_values: values } },
        });
        const entry = asRecord(asRecord(response)?.data) as AttioListEntryInput | null;
        const compact = entry ? compactAttioListEntry(entry, new Map()) : null;
        if (!compact) {
          throw new Error("Attio returned an invalid updated list entry response.");
        }
        return {
          workspace: connection.selector,
          list: reference.list,
          entry: compact,
        };
      },
    });
  }

  const hasWrites = actions.some((action) => action.capability === "write");
  const hasLists = actions.some((action) => action.id.includes("list"));
  const labelConnections = uniqueConnections([
    ...readConnections,
    ...recordWriteConnections,
    ...listWriteConnections,
    ...listConfigurationWriteConnections,
  ]);
  return {
    id: "attio",
    label:
      labelConnections.length === 1
        ? `Attio (${labelConnections[0]!.selector})`
        : `Attio (${labelConnections.length} workspaces)`,
    description: hasWrites
      ? hasLists
        ? "Search and inspect CRM records and lists, configure pipeline fields and options, add records to lists, and update records or pipeline entries in Attio."
        : "Search, inspect, and update people, companies, and deals in Attio."
      : hasLists
        ? "Search and inspect CRM records and lists in Attio."
        : "Search and inspect people, companies, and deals in Attio.",
    actions,
  };
}

function eligibleConnections(
  connections: readonly AttioConnection[],
  capabilityId: GoatCapabilityId,
): AttioConnection[] {
  return connections.filter(
    (connection) =>
      effectiveCapabilityMode("attio", capabilityId, connection.capabilityModes) !== "off",
  );
}

function permissionAnnotation(
  capabilityId: GoatCapabilityId,
  connections: readonly AttioConnection[],
): Pick<ResolvedGoatAction, "permissionMode" | "permission"> {
  const askIntegrationIds = connections
    .filter(
      (connection) =>
        effectiveCapabilityMode("attio", capabilityId, connection.capabilityModes) === "ask",
    )
    .map((connection) => connection.integrationId);
  if (askIntegrationIds.length === 0) return { permissionMode: "on" };
  return {
    permissionMode: "ask",
    permission: {
      provider: "attio",
      capabilityId,
      label: providerCapability("attio", capabilityId)?.label ?? capabilityId,
      integrationIds: askIntegrationIds,
    },
  };
}

function uniqueConnections(connections: readonly AttioConnection[]): AttioConnection[] {
  return [
    ...new Map(connections.map((connection) => [connection.integrationId, connection])).values(),
  ];
}

async function loadAttioConnections(userWorkosId: string): Promise<AttioConnection[]> {
  const rows = await getDb()
    .select({
      integrationId: goatIntegrations.id,
      workspaceId: goatIntegrations.externalId,
      workspaceName: goatIntegrations.connectionLabel,
      scopes: goatIntegrations.scopes,
      status: goatIntegrations.status,
      capabilityModes: goatIntegrations.capabilityModes,
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
      scopes: row.scopes,
      capabilityModes: row.capabilityModes,
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

function attioAccountParam(connections: readonly AttioConnection[], verb: string) {
  return connections.length > 1
    ? {
        account: {
          type: "string" as const,
          enum: connections.map((connection) => connection.selector),
          description: `The connected Attio workspace to ${verb}.`,
        },
      }
    : {};
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
  return await callAttioApi({
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

async function callAttioApi(input: {
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
    return await rethrowAttioError(error, input);
  }
}

async function listAttioAttributes(input: {
  context: GoatActionExecuteContext;
  connection: AttioConnection;
  credential: AttioCredential;
  target: "objects" | "lists";
  identifier: string;
}) {
  const encodedIdentifier = encodeURIComponent(input.identifier);
  const response = await callAttioApi({
    context: input.context,
    connection: input.connection,
    credential: input.credential,
    path: `/${input.target}/${encodedIdentifier}/attributes`,
  });
  const source = asRecord(response)?.data;
  const compactAttributes = Array.isArray(source)
    ? source.flatMap((raw) => {
        const attribute = compactAttioAttribute(raw);
        return attribute && !attribute.isArchived ? [attribute] : [];
      })
    : [];
  const attributes = await Promise.all(
    compactAttributes
      .slice(0, MAX_ATTRIBUTES)
      .map((attribute) => hydrateAttioAttributeOptions(input, attribute)),
  );
  return {
    workspace: input.connection.selector,
    target: input.target,
    identifier: input.identifier,
    attributes,
    truncated: compactAttributes.length > MAX_ATTRIBUTES,
  };
}

async function hydrateAttioAttributeOptions(
  input: {
    context: GoatActionExecuteContext;
    connection: AttioConnection;
    credential: AttioCredential;
    target: "objects" | "lists";
    identifier: string;
  },
  attribute: NonNullable<ReturnType<typeof compactAttioAttribute>>,
) {
  const optionResource =
    attribute.type === "status" ? "statuses" : attribute.type === "select" ? "options" : null;
  if (!optionResource) return attribute;
  const response = await callAttioApi({
    context: input.context,
    connection: input.connection,
    credential: input.credential,
    path: `/${input.target}/${encodeURIComponent(input.identifier)}/attributes/${encodeURIComponent(attribute.apiSlug ?? attribute.id)}/${optionResource}`,
  });
  const options = compactAttioAttributeOptions(response);
  return {
    ...attribute,
    options: options.values,
    optionsTruncated: options.truncated,
  };
}

async function assertAttioWriteStillEnabled(
  context: GoatActionExecuteContext,
  connection: AttioConnection,
  resource: "record" | "list_entry" | "list_configuration",
) {
  const [row] = await getDb()
    .select({
      status: goatIntegrations.status,
      scopes: goatIntegrations.scopes,
      capabilityModes: goatIntegrations.capabilityModes,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, connection.integrationId),
        eq(goatIntegrations.userWorkosId, context.userWorkosId),
        eq(goatIntegrations.provider, GOAT_ATTIO_PROVIDER),
      ),
    )
    .limit(1);
  if (!row || row.status !== "connected") {
    throw new GoatActionPermissionError(
      "attio",
      `The Attio connection for ${connection.selector} changed before the update. Retry so Goat can use the current connection and permission.`,
    );
  }
  if (effectiveCapabilityMode("attio", "write", row.capabilityModes) === "off") {
    throw new GoatActionPermissionError(
      "attio",
      `Updating Attio is turned off for ${connection.selector}. It can be changed under Settings → Integrations.`,
    );
  }
  const hasWriteScope =
    resource === "record"
      ? hasGoatAttioRecordWriteScopes(row.scopes)
      : resource === "list_entry"
        ? hasGoatAttioListWriteScopes(row.scopes)
        : hasGoatAttioListConfigurationWriteScope(row.scopes);
  if (!hasWriteScope) {
    throw new GoatActionPermissionError(
      "attio",
      `The Attio API key for ${connection.selector} does not allow this update. Reconnect Attio with the read-write scopes shown in Settings → Integrations.`,
    );
  }
}

async function queryAttioList(input: {
  context: GoatActionExecuteContext;
  connection: AttioConnection;
  credential: AttioCredential;
  list: string;
  viewId?: string;
  filter?: Record<string, unknown>;
  sorts?: Array<{ direction: "asc" | "desc"; attribute: string; field?: string }>;
  limit: number;
  offset: number;
}) {
  const encodedList = encodeURIComponent(input.list);
  try {
    const [listResponse, entriesResponse] = await Promise.all([
      requestGoatAttioApi({
        apiKey: input.credential.apiKey,
        path: `/lists/${encodedList}`,
        signal: input.context.signal,
      }),
      requestGoatAttioApi({
        apiKey: input.credential.apiKey,
        path: `/lists/${encodedList}/entries/query`,
        method: "POST",
        body: {
          ...(input.viewId ? { filter_view_id: input.viewId } : {}),
          ...(input.filter ? { filter: input.filter } : {}),
          ...(input.sorts ? { sorts: input.sorts } : {}),
          limit: input.limit,
          offset: input.offset,
        },
        signal: input.context.signal,
      }),
    ]);
    const entries = attioListEntryList(entriesResponse, input.limit);
    const parentRecords = await fetchAttioListParentRecords({
      apiKey: input.credential.apiKey,
      signal: input.context.signal,
      entries,
    });
    return {
      workspace: input.connection.selector,
      list: compactAttioList(listResponse, input.list),
      ...(input.viewId ? { view: { id: input.viewId } } : {}),
      entries: entries.flatMap((entry) => {
        const compact = compactAttioListEntry(entry, parentRecords);
        return compact ? [compact] : [];
      }),
      offset: input.offset,
      limit: input.limit,
      hasMore: entries.length === input.limit,
      ...(entries.length === input.limit ? { nextOffset: input.offset + input.limit } : {}),
    };
  } catch (error) {
    return await rethrowAttioError(error, input);
  }
}

async function rethrowAttioError(
  error: unknown,
  input: { context: GoatActionExecuteContext; connection: AttioConnection },
): Promise<never> {
  if (input.context.signal.aborted) throw error;
  if (error instanceof GoatAttioApiRequestError && (error.status === 401 || error.status === 403)) {
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

function parseLimit(value: unknown, bounds: { fallback: number; max: number }) {
  if (value === undefined || value === null) return bounds.fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > bounds.max) {
    throw new GoatActionInvalidParamsError(`"limit" must be an integer from 1 to ${bounds.max}.`);
  }
  return value;
}

function parseOffset(value: unknown) {
  if (value === undefined || value === null) return 0;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_LIST_OFFSET
  ) {
    throw new GoatActionInvalidParamsError(
      `"offset" must be an integer from 0 to ${MAX_LIST_OFFSET}.`,
    );
  }
  return value;
}

function parseBoundedId(params: Record<string, unknown>, key: string, maxChars: number): string {
  const value = requiredStringParam(params, key);
  if (value.length > maxChars) {
    throw new GoatActionInvalidParamsError(`"${key}" must be at most ${maxChars} characters.`);
  }
  return value;
}

function optionalAttioStringParam(params: Record<string, unknown>, key: string) {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new GoatActionInvalidParamsError(`"${key}" must be a non-empty string.`);
  }
  return value.trim();
}

function optionalBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new GoatActionInvalidParamsError(`"${key}" must be a boolean.`);
  }
  return value;
}

function parseAttioApiSlug(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9_-]{1,200}$/.test(value.trim()) ||
    ["__proto__", "constructor", "prototype"].includes(value.trim())
  ) {
    throw new GoatActionInvalidParamsError(
      '"api_slug" must be a lowercase Attio API slug containing only letters, numbers, underscores, or hyphens.',
    );
  }
  return value.trim();
}

function parseAttioListAttributeType(value: unknown): AttioListAttributeType {
  if (typeof value !== "string" || !(LIST_ATTRIBUTE_TYPES as readonly string[]).includes(value)) {
    throw new GoatActionInvalidParamsError('"type" must be one of status, select, or text.');
  }
  return value as AttioListAttributeType;
}

function parseOptionalAttioDuration(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new GoatActionInvalidParamsError(
      '"target_time_in_status" must be an ISO-8601 duration string.',
    );
  }
  const normalized = value.trim();
  const isoDuration =
    /^P(?=\d|T\d)(?:(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?=\d)(?:\d+(?:[.,]\d+)?H)?(?:\d+(?:[.,]\d+)?M)?(?:\d+(?:[.,]\d+)?S)?)?)$/;
  if (
    !normalized ||
    normalized.length > MAX_TARGET_TIME_IN_STATUS_CHARS ||
    !isoDuration.test(normalized)
  ) {
    throw new GoatActionInvalidParamsError(
      '"target_time_in_status" must be a valid ISO-8601 duration such as "P7D" or "PT24H".',
    );
  }
  return normalized;
}

function parseAttioFilter(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  const filter = asRecord(value);
  if (!filter || Object.keys(filter).length === 0) {
    throw new GoatActionInvalidParamsError('"filter" must be a non-empty object.');
  }
  if (Object.keys(filter).length > MAX_FILTER_PROPERTIES) {
    throw new GoatActionInvalidParamsError(
      `"filter" allows at most ${MAX_FILTER_PROPERTIES} top-level properties.`,
    );
  }
  const normalized = normalizeAttioJson(filter, "filter", 0);
  assertAttioJsonSize(normalized, "filter", MAX_FILTER_JSON_CHARS);
  return normalized as Record<string, unknown>;
}

function parseAttioSorts(
  value: unknown,
): Array<{ direction: "asc" | "desc"; attribute: string; field?: string }> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_SORTS) {
    throw new GoatActionInvalidParamsError(
      `"sorts" must be an array of at most ${MAX_SORTS} sorts.`,
    );
  }
  if (value.length === 0) return undefined;
  return value.map((raw, index) => {
    const sort = asRecord(raw);
    if (!sort) {
      throw new GoatActionInvalidParamsError(`"sorts[${index}]" must be an object.`);
    }
    assertKnownParams(sort, ["direction", "attribute", "field"]);
    if (sort.direction !== "asc" && sort.direction !== "desc") {
      throw new GoatActionInvalidParamsError(
        `"sorts[${index}].direction" must be "asc" or "desc".`,
      );
    }
    const attribute = parseSafeAttioIdentifier(sort.attribute, `sorts[${index}].attribute`);
    const field =
      sort.field === undefined || sort.field === null
        ? undefined
        : parseSafeAttioIdentifier(sort.field, `sorts[${index}].field`);
    return {
      direction: sort.direction,
      attribute,
      ...(field ? { field } : {}),
    };
  });
}

function parseAttioWriteValues(value: unknown): Record<string, unknown> {
  const values = asRecord(value);
  if (!values || Object.keys(values).length === 0) {
    throw new GoatActionInvalidParamsError('"values" must be a non-empty object.');
  }
  if (Object.keys(values).length > MAX_WRITE_PROPERTIES) {
    throw new GoatActionInvalidParamsError(
      `"values" allows at most ${MAX_WRITE_PROPERTIES} fields per update.`,
    );
  }
  for (const key of Object.keys(values)) {
    if (!safeAttioApiIdentifier(key)) {
      throw new GoatActionInvalidParamsError(
        `"values" key ${JSON.stringify(key)} must be an Attio attribute slug or UUID.`,
      );
    }
  }
  const normalized = normalizeAttioJson(values, "values", 0);
  assertAttioJsonSize(normalized, "values", MAX_WRITE_JSON_CHARS);
  return normalized as Record<string, unknown>;
}

function normalizeAttioJson(value: unknown, path: string, depth: number): unknown {
  if (depth > MAX_JSON_DEPTH) {
    throw new GoatActionInvalidParamsError(
      `"${path}" is nested too deeply (maximum depth ${MAX_JSON_DEPTH}).`,
    );
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new GoatActionInvalidParamsError(`"${path}" must contain only finite numbers.`);
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_CHARS) {
      throw new GoatActionInvalidParamsError(
        `"${path}" strings must be at most ${MAX_JSON_STRING_CHARS} characters.`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) {
      throw new GoatActionInvalidParamsError(
        `"${path}" arrays allow at most ${MAX_JSON_ARRAY_ITEMS} items.`,
      );
    }
    return value.map((entry, index) => normalizeAttioJson(entry, `${path}[${index}]`, depth + 1));
  }
  const record = asRecord(value);
  if (!record) {
    throw new GoatActionInvalidParamsError(
      `"${path}" must contain only JSON strings, numbers, booleans, nulls, arrays, and objects.`,
    );
  }
  const keys = Object.keys(record);
  if (keys.length > MAX_JSON_OBJECT_PROPERTIES) {
    throw new GoatActionInvalidParamsError(
      `"${path}" objects allow at most ${MAX_JSON_OBJECT_PROPERTIES} properties.`,
    );
  }
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (
      !key ||
      key.length > 200 ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    ) {
      throw new GoatActionInvalidParamsError(`"${path}" contains an invalid property name.`);
    }
    normalized[key] = normalizeAttioJson(record[key], `${path}.${key}`, depth + 1);
  }
  return normalized;
}

function assertAttioJsonSize(value: unknown, key: string, maxChars: number) {
  const serialized = JSON.stringify(value);
  if (serialized.length > maxChars) {
    throw new GoatActionInvalidParamsError(`"${key}" must be at most ${maxChars} JSON characters.`);
  }
}

function parseSafeAttioIdentifier(value: unknown, path: string): string {
  const identifier = safeAttioApiIdentifier(value);
  if (!identifier) {
    throw new GoatActionInvalidParamsError(
      `"${path}" must be an Attio attribute slug, field, or UUID.`,
    );
  }
  return identifier;
}

function parseAttioListReference(listInput: string, viewInput?: string) {
  if (listInput.length > MAX_LIST_REFERENCE_CHARS) {
    throw new GoatActionInvalidParamsError(
      `"list" must be at most ${MAX_LIST_REFERENCE_CHARS} characters.`,
    );
  }
  if (viewInput && viewInput.length > MAX_LIST_REFERENCE_CHARS) {
    throw new GoatActionInvalidParamsError(
      `"view" must be at most ${MAX_LIST_REFERENCE_CHARS} characters.`,
    );
  }

  const listUrl = parseAttioCollectionUrl(listInput);
  const list = listUrl?.list ?? parseAttioListIdentifier(listInput);
  const explicitViewUrl = viewInput ? parseAttioCollectionUrl(viewInput) : null;
  const explicitView = viewInput
    ? (explicitViewUrl?.viewId ?? parseAttioViewIdentifier(viewInput))
    : undefined;
  if (explicitViewUrl && explicitViewUrl.list !== list) {
    throw new GoatActionInvalidParamsError(
      'The "view" URL must belong to the list supplied in "list".',
    );
  }
  if (listUrl?.viewId && explicitView && listUrl.viewId !== explicitView) {
    throw new GoatActionInvalidParamsError(
      'The saved view in "list" does not match the explicit "view".',
    );
  }
  return { list, viewId: explicitView ?? listUrl?.viewId };
}

function parseAttioCollectionUrl(value: string): { list: string; viewId?: string } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "app.attio.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new GoatActionInvalidParamsError(
      "Attio collection URLs must be secure app.attio.com URLs without query parameters.",
    );
  }
  const match = url.pathname.match(
    /^\/[a-z0-9_-]+\/collection\/([a-z0-9_-]+)(?:\/view\/([a-z0-9-]+))?\/?$/i,
  );
  if (!match) {
    throw new GoatActionInvalidParamsError(
      'Attio collection URLs must contain "/collection/{list}" and may end with "/view/{view}".',
    );
  }
  return {
    list: parseAttioListIdentifier(match[1] ?? ""),
    ...(match[2] ? { viewId: parseAttioViewIdentifier(match[2]) } : {}),
  };
}

function parseAttioListIdentifier(value: string) {
  const normalized = value.trim();
  if (!/^[a-z0-9_-]{1,200}$/i.test(normalized)) {
    throw new GoatActionInvalidParamsError(
      '"list" must be an Attio list UUID, API slug, or collection URL.',
    );
  }
  return normalized;
}

function parseAttioViewIdentifier(value: string) {
  const normalized = value.trim();
  if (!isUuid(normalized)) {
    throw new GoatActionInvalidParamsError(
      '"view" must be an Attio saved-view UUID or collection URL.',
    );
  }
  return normalized;
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

function attioListEntryList(response: unknown, limit: number): AttioListEntryInput[] {
  const data = asRecord(response)?.data;
  return Array.isArray(data)
    ? data.slice(0, limit).filter((entry): entry is AttioListEntryInput => asRecord(entry) !== null)
    : [];
}

function attioListList(response: unknown) {
  const data = asRecord(response)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    const compact = compactAttioListData(entry);
    return compact ? [compact] : [];
  });
}

function attioRecordEntryList(response: unknown, limit: number) {
  const data = asRecord(response)?.data;
  if (!Array.isArray(data)) return [];
  return data.slice(0, limit).flatMap((raw) => {
    const entry = asRecord(raw) as AttioRecordEntryInput | null;
    if (!entry) return [];
    const listId = boundedIdentifier(entry.list_id, 200);
    const listApiSlug = safeAttioApiIdentifier(entry.list_api_slug);
    const entryId = boundedIdentifier(entry.entry_id, MAX_ENTRY_ID_CHARS);
    if (!listId || !entryId) return [];
    const createdAt = boundedString(entry.created_at, 80);
    return [
      {
        listId,
        ...(listApiSlug ? { listApiSlug } : {}),
        entryId,
        ...(createdAt ? { createdAt } : {}),
      },
    ];
  });
}

function compactAttioAttribute(value: unknown) {
  const attribute = asRecord(value) as AttioAttributeInput | null;
  if (!attribute) return null;
  const id = boundedIdentifier(attribute.id?.attribute_id, 200);
  const apiSlug = safeAttioApiIdentifier(attribute.api_slug);
  const type = safeAttioApiIdentifier(attribute.type);
  const title = boundedString(attribute.title, MAX_TITLE_CHARS);
  if (!id || !type || !title) return null;
  const description = boundedString(attribute.description, MAX_PROPERTY_CHARS);
  return {
    id,
    ...(apiSlug ? { apiSlug } : {}),
    title,
    type,
    ...(description ? { description } : {}),
    isSystem: attribute.is_system_attribute === true,
    isWritable: attribute.is_writable === true,
    isRequired: attribute.is_required === true,
    isUnique: attribute.is_unique === true,
    isMultiselect: attribute.is_multiselect === true,
    isArchived: attribute.is_archived === true,
  };
}

function compactAttioAttributeOptions(response: unknown) {
  const data = asRecord(response)?.data;
  if (!Array.isArray(data)) return { values: [], truncated: false };
  const values = data.slice(0, MAX_ATTRIBUTE_OPTIONS).flatMap((raw) => {
    const option = asRecord(raw);
    if (!option || option.is_archived === true) return [];
    const ids = asRecord(option.id);
    const id = boundedIdentifier(ids?.status_id, 200) ?? boundedIdentifier(ids?.option_id, 200);
    const title = boundedString(option.title, MAX_TITLE_CHARS);
    return id && title ? [{ id, title }] : [];
  });
  return { values, truncated: data.length > MAX_ATTRIBUTE_OPTIONS };
}

function compactAttioStatus(value: unknown) {
  const status = asRecord(value) as AttioStatusInput | null;
  if (!status) return null;
  const id = boundedIdentifier(status.id?.status_id, MAX_ATTRIBUTE_REFERENCE_CHARS);
  const title = boundedString(status.title, MAX_TITLE_CHARS);
  if (!id || !title) return null;
  const targetTimeInStatus = boundedString(
    status.target_time_in_status,
    MAX_TARGET_TIME_IN_STATUS_CHARS,
  );
  return {
    id,
    title,
    isArchived: status.is_archived === true,
    celebrationEnabled: status.celebration_enabled === true,
    ...(targetTimeInStatus ? { targetTimeInStatus } : {}),
  };
}

function compactAttioSelectOption(value: unknown) {
  const option = asRecord(value) as AttioSelectOptionInput | null;
  if (!option) return null;
  const id = boundedIdentifier(option.id?.option_id, MAX_ATTRIBUTE_REFERENCE_CHARS);
  const title = boundedString(option.title, MAX_TITLE_CHARS);
  if (!id || !title) return null;
  return {
    id,
    title,
    isArchived: option.is_archived === true,
  };
}

async function fetchAttioListParentRecords(input: {
  apiKey: string;
  signal: AbortSignal;
  entries: readonly AttioListEntryInput[];
}) {
  const recordIdsByObject = new Map<string, Set<string>>();
  for (const entry of input.entries) {
    const object = safeAttioApiIdentifier(entry.parent_object);
    const recordId = boundedIdentifier(entry.parent_record_id, 200);
    if (!object || !recordId) continue;
    const recordIds = recordIdsByObject.get(object) ?? new Set<string>();
    recordIds.add(recordId);
    recordIdsByObject.set(object, recordIds);
  }

  const parentRecords = new Map<string, NonNullable<ReturnType<typeof compactAttioParentRecord>>>();
  await Promise.all(
    [...recordIdsByObject].map(async ([object, recordIdSet]) => {
      const recordIds = [...recordIdSet];
      const response = await requestGoatAttioApi({
        apiKey: input.apiKey,
        path: `/objects/${encodeURIComponent(object)}/records/query`,
        method: "POST",
        body: {
          filter: { record_id: { $in: recordIds } },
          limit: recordIds.length,
        },
        signal: input.signal,
      });
      for (const record of attioRecordList(response, recordIds.length)) {
        const compact = compactAttioParentRecord(record, object);
        if (compact) parentRecords.set(attioParentRecordKey(object, compact.id), compact);
      }
    }),
  );
  return parentRecords;
}

function compactAttioList(response: unknown, fallbackIdentifier: string) {
  return (
    compactAttioListData(asRecord(response)?.data) ?? {
      id: fallbackIdentifier,
    }
  );
}

function compactAttioListData(value: unknown) {
  const data = asRecord(value);
  if (!data) return null;
  const id = boundedIdentifier(asRecord(data.id)?.list_id, 200);
  if (!id) return null;
  const name = boundedString(data.name, MAX_TITLE_CHARS);
  const apiSlug = safeAttioApiIdentifier(data.api_slug);
  const parentObjects = Array.isArray(data.parent_object)
    ? data.parent_object
        .slice(0, 10)
        .map(safeAttioApiIdentifier)
        .filter((value): value is string => Boolean(value))
    : [];
  return {
    id,
    ...(apiSlug ? { apiSlug } : {}),
    ...(name ? { name } : {}),
    ...(parentObjects.length > 0 ? { parentObjects } : {}),
  };
}

function compactAttioListEntry(
  entry: AttioListEntryInput,
  parentRecords: ReadonlyMap<string, NonNullable<ReturnType<typeof compactAttioParentRecord>>>,
) {
  const id = boundedIdentifier(entry.id?.entry_id, 200);
  const parentObject = safeAttioApiIdentifier(entry.parent_object);
  const parentRecordId = boundedIdentifier(entry.parent_record_id, 200);
  if (!id || !parentObject || !parentRecordId) return null;
  const hydrated = parentRecords.get(attioParentRecordKey(parentObject, parentRecordId));
  const createdAt = boundedString(entry.created_at, 80);
  return {
    id,
    parent: hydrated ?? { object: parentObject, id: parentRecordId },
    ...(createdAt ? { createdAt } : {}),
    values: compactAttioPropertyBag(entry.entry_values, MAX_LIST_PROPERTIES),
  };
}

function compactAttioParentRecord(record: AttioRecordInput, object: string) {
  const recordId = boundedIdentifier(record.id?.record_id, 200);
  if (!recordId) return null;
  const properties = compactAttioRecordProperties(record);
  const title = truncate(
    properties.name ??
      properties.full_name ??
      boundedString(record.record_text, MAX_TITLE_CHARS) ??
      properties.email_addresses ??
      `${humanizeAttioObject(object)} ${recordId}`,
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

function attioParentRecordKey(object: string, recordId: string) {
  return `${object}\u0000${recordId}`;
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

  const properties = compactAttioRecordProperties(record, maxProperties);
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

function compactAttioRecordProperties(
  record: AttioRecordInput,
  maxProperties = MAX_SEARCH_PROPERTIES,
) {
  const properties = Object.create(null) as Record<string, string>;
  const emails = compactStringList(record.email_addresses);
  const phones = compactStringList(record.phone_numbers);
  if (emails) properties.email_addresses = truncate(emails, MAX_PROPERTY_CHARS);
  if (phones) properties.phone_numbers = truncate(phones, MAX_PROPERTY_CHARS);
  return compactAttioPropertyBag(record.values, maxProperties, properties);
}

function compactAttioPropertyBag(
  input: unknown,
  maxProperties: number,
  properties = Object.create(null) as Record<string, string>,
) {
  const values = asRecord(input) ?? {};
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
  return properties;
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

function safeAttioApiIdentifier(value: unknown) {
  const identifier = boundedIdentifier(value, 200);
  if (
    !identifier ||
    !/^[a-z0-9_-]+$/i.test(identifier) ||
    identifier === "__proto__" ||
    identifier === "constructor" ||
    identifier === "prototype"
  ) {
    return null;
  }
  return identifier;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

function humanizeAttioObject(object: string) {
  const singular = object.endsWith("ies")
    ? `${object.slice(0, -3)}y`
    : object.endsWith("s")
      ? object.slice(0, -1)
      : object;
  return singular
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
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
