import { createMCPClient, type OAuthClientProvider } from "@ai-sdk/mcp";
import type { JSONSchema7, ToolExecutionOptions, ToolSet } from "ai";
import Ajv, { type AnySchema } from "ajv";
import {
  GOAT_NEON_MCP_ENDPOINT_URL,
  getGoatNeonIntegrationState,
  loadGoatNeonMcpWorkerConnection,
} from "../integrations/neon-mcp";
import { effectiveCapabilityMode, type GoatCapabilityId, providerCapability } from "./capabilities";
import {
  GOAT_ACTION_EFFECTS_READ,
  GoatActionAuthError,
  type GoatActionExecuteContext,
  GoatActionInvalidParamsError,
  GoatActionPermissionError,
  type GoatActionProviderCatalog,
  type ResolvedGoatAction,
} from "./types";

type NeonToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    destructiveHint?: boolean;
  };
};

// Intentionally excludes get_connection_string, every transaction/migration
// tool, branch mutations, broad search/fetch, and all future Neon tools until
// they are reviewed here.
const NEON_ACTION_CAPABILITIES = {
  list_projects: "read",
  list_organizations: "read",
  list_shared_projects: "read",
  describe_project: "read",
  describe_branch: "read",
  get_database_tables: "read",
  describe_table_schema: "read",
  run_sql: "query",
} as const satisfies Record<string, GoatCapabilityId>;

type NeonActionToolName = keyof typeof NEON_ACTION_CAPABILITIES;

const MAX_NEON_SQL_CHARS = 12_000;
const NEON_ACTION_TIMEOUT_MS = 15_000;
const NEON_POSTGRES_URI_PATTERN = /postgres(?:ql)?:\/\/[^\s"'<>]+/gi;
const NEON_SENSITIVE_RESULT_KEY_PATTERN =
  /^(?:password|passwd|secret|token|(?:access|refresh|auth|bearer)_?token|api_?key|private_?key|connection_?(?:string|uri|url)|database_?(?:uri|url)|dsn)$/i;
const NEON_UNSAFE_SQL_FUNCTION_PATTERN =
  /\b(?:pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_log_backend_memory_contexts|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_sleep|set_config|dblink_connect|dblink_exec|lo_import|lo_export|pg_advisory_lock|pg_advisory_xact_lock)\s*\(/i;

const neonSchemaValidator = new Ajv({ allErrors: true, strict: false });

export async function resolveNeonActions(
  userWorkosId: string,
): Promise<GoatActionProviderCatalog | null> {
  const state = await getGoatNeonIntegrationState(userWorkosId);
  const integrationId = state.integrationId;
  if (!state.connected || !integrationId) return null;

  const readEnabled = effectiveCapabilityMode("neon", "read", state.capabilityModes) !== "off";
  const queryEnabled = effectiveCapabilityMode("neon", "query", state.capabilityModes) !== "off";
  if (!readEnabled && !queryEnabled) return null;

  const connection = await loadGoatNeonMcpWorkerConnection({
    userWorkosId,
    onAuthorizationRequired: () => {
      throw neonAuthError();
    },
  });
  if (!connection.ok) return null;

  const client = await createNeonClient(connection.authProvider);
  let definitions: NeonToolDefinition[];
  try {
    const result = await client.listTools({
      options: { signal: AbortSignal.timeout(10_000) },
    });
    definitions = result.tools as NeonToolDefinition[];
  } finally {
    await client.close().catch(() => {});
  }

  const actions: ResolvedGoatAction[] = definitions.flatMap((definition) => {
    if (!isNeonActionToolName(definition.name)) return [];
    const remoteName = definition.name;
    const capability = NEON_ACTION_CAPABILITIES[remoteName];
    if ((capability === "read" && !readEnabled) || (capability === "query" && !queryEnabled)) {
      return [];
    }
    if (!hasSupportedNeonSafetyContract(definition)) return [];

    return [
      {
        id: `neon.${remoteName}`,
        provider: "neon",
        capability,
        effects: GOAT_ACTION_EFFECTS_READ,
        ...permissionAnnotation(capability, {
          integrationId,
          capabilityModes: state.capabilityModes,
        }),
        description: actionDescription(remoteName, definition.description),
        params: neonInputSchema(definition.inputSchema),
        timeoutMs: NEON_ACTION_TIMEOUT_MS,
        execute: (params, context) =>
          executeNeonAction({
            remoteName,
            expectedCapability: capability,
            expectedIntegrationId: integrationId,
            params,
            context,
          }),
      },
    ];
  });
  if (actions.length === 0) return null;

  return {
    id: "neon",
    label: "Neon (read-only)",
    description:
      "Inspect Neon projects, branches, tables, and schemas, and run explicitly permitted read-only SQL. Connection strings and mutations are never exposed.",
    actions,
  };
}

function permissionAnnotation(
  capabilityId: GoatCapabilityId,
  state: { integrationId: string; capabilityModes: unknown },
): Pick<ResolvedGoatAction, "permissionMode" | "permission"> {
  if (effectiveCapabilityMode("neon", capabilityId, state.capabilityModes) !== "ask") {
    return { permissionMode: "on" };
  }
  return {
    permissionMode: "ask",
    permission: {
      provider: "neon",
      capabilityId,
      label: providerCapability("neon", capabilityId)?.label ?? capabilityId,
      integrationIds: [state.integrationId],
    },
  };
}

async function executeNeonAction(input: {
  remoteName: NeonActionToolName;
  expectedCapability: GoatCapabilityId;
  expectedIntegrationId: string;
  params: Record<string, unknown>;
  context: GoatActionExecuteContext;
}) {
  const state = await getGoatNeonIntegrationState(input.context.userWorkosId);
  if (!state.connected || !state.integrationId) throw neonAuthError();
  if (state.integrationId !== input.expectedIntegrationId) {
    throw new GoatActionPermissionError(
      "neon",
      "The Neon connection changed before this action could run. Retry so Goat can use the current connection and permission.",
    );
  }
  if (effectiveCapabilityMode("neon", input.expectedCapability, state.capabilityModes) === "off") {
    throw new GoatActionPermissionError(
      "neon",
      `${input.expectedCapability === "query" ? "Querying Neon databases" : "Inspecting Neon structure"} is turned off. It can be changed under Settings → Integrations.`,
    );
  }

  const connection = await loadGoatNeonMcpWorkerConnection({
    userWorkosId: input.context.userWorkosId,
    onAuthorizationRequired: () => {
      throw neonAuthError();
    },
  });
  if (!connection.ok) throw neonAuthError();
  if (connection.integrationId !== input.expectedIntegrationId) {
    throw new GoatActionPermissionError(
      "neon",
      "The Neon connection changed before this action could run. Retry so Goat can use the current connection and permission.",
    );
  }

  const client = await createNeonClient(connection.authProvider);
  try {
    const definitions = await client.listTools({ options: { signal: input.context.signal } });
    const currentDefinition = (definitions.tools as NeonToolDefinition[]).find(
      (definition) => definition.name === input.remoteName,
    );
    if (!currentDefinition || !isNeonActionToolName(currentDefinition.name)) {
      throw new Error(
        `Neon no longer exposes the reviewed "${input.remoteName}" tool; refresh the action catalog and try again.`,
      );
    }
    if (
      !hasSupportedNeonSafetyContract(currentDefinition) ||
      NEON_ACTION_CAPABILITIES[currentDefinition.name] !== input.expectedCapability
    ) {
      throw new GoatActionPermissionError(
        "neon",
        `Neon changed the safety contract for "${input.remoteName}", so Goat will not run it.`,
      );
    }

    const validate = neonSchemaValidator.compile(
      neonInputSchema(currentDefinition.inputSchema) as AnySchema,
    );
    if (!validate(input.params)) {
      throw new GoatActionInvalidParamsError(
        `The parameters for "${input.remoteName}" do not match Neon's current schema.`,
      );
    }
    if (input.remoteName === "run_sql") validateNeonReadOnlySql(input.params.sql);

    const rawTools = client.toolsFromDefinitions(definitions) as ToolSet;
    const remote = rawTools[input.remoteName] as
      | { execute?: (value: unknown, options: ToolExecutionOptions) => Promise<unknown> }
      | undefined;
    const execute = remote?.execute?.bind(remote);
    if (!execute) {
      throw new Error(
        `Neon no longer exposes the reviewed "${input.remoteName}" tool; refresh the action catalog and try again.`,
      );
    }
    const result = await execute(input.params, {
      toolCallId: `goat-action-neon-${input.remoteName}`,
      messages: [],
      abortSignal: input.context.signal,
    });
    return {
      untrustedProviderData: true,
      payload: redactNeonSecrets(unwrapNeonMcpResult(result)),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

function createNeonClient(authProvider: OAuthClientProvider) {
  return createMCPClient({
    clientName: "opencompany-goat-actions",
    version: "0.1.0",
    transport: {
      type: "http" as const,
      url: GOAT_NEON_MCP_ENDPOINT_URL,
      authProvider,
    },
  });
}

function validateNeonReadOnlySql(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new GoatActionInvalidParamsError('"sql" is required and must be a non-empty string.');
  }
  if (value.length > MAX_NEON_SQL_CHARS) {
    throw new GoatActionInvalidParamsError(
      `"sql" must be ${MAX_NEON_SQL_CHARS.toLocaleString("en-US")} characters or fewer.`,
    );
  }
  const firstKeyword = firstSqlKeyword(value);
  if (firstKeyword !== "select" && firstKeyword !== "with" && firstKeyword !== "show") {
    throw new GoatActionInvalidParamsError(
      '"sql" must begin with SELECT, WITH, or SHOW. Neon also enforces a read-only transaction.',
    );
  }
  if (NEON_UNSAFE_SQL_FUNCTION_PATTERN.test(value)) {
    throw new GoatActionInvalidParamsError(
      '"sql" calls an administrative or side-effecting Postgres function that Goat does not permit.',
    );
  }
}

function firstSqlKeyword(sql: string): string | null {
  let remaining = sql.trimStart();
  while (remaining) {
    if (remaining.startsWith("--")) {
      const newline = remaining.indexOf("\n");
      if (newline === -1) return null;
      remaining = remaining.slice(newline + 1).trimStart();
      continue;
    }
    if (remaining.startsWith("/*")) {
      const end = remaining.indexOf("*/", 2);
      if (end === -1) return null;
      remaining = remaining.slice(end + 2).trimStart();
      continue;
    }
    return remaining.match(/^[a-z]+/i)?.[0]?.toLowerCase() ?? null;
  }
  return null;
}

function actionDescription(name: NeonActionToolName, remoteDescription?: string) {
  if (name === "run_sql") {
    return "Run one read-only SQL query against a selected Neon project, branch, and database. Use a narrow SELECT, WITH, or SHOW statement and add LIMIT when returning rows. The provider executes it in a read-only transaction; Goat blocks administrative functions, never exposes connection strings, and truncates oversized results.";
  }
  return (
    remoteDescription?.trim() ||
    `Inspect ${name.replaceAll("_", " ")} in the connected Neon account without changing it.`
  );
}

function isNeonActionToolName(name: string): name is NeonActionToolName {
  return Object.hasOwn(NEON_ACTION_CAPABILITIES, name);
}

function hasSupportedNeonSafetyContract(definition: NeonToolDefinition) {
  if (definition.annotations?.destructiveHint !== true) return true;

  // Neon gives run_sql a destructive hint because the same tool can mutate
  // databases in full-access mode. This integration always pins the hosted
  // server to readonly=true, where Neon exposes run_sql for read queries only;
  // validateNeonReadOnlySql adds a second local guard before execution.
  return (
    definition.name === "run_sql" &&
    new URL(GOAT_NEON_MCP_ENDPOINT_URL).searchParams.get("readonly") === "true"
  );
}

function neonInputSchema(value: Record<string, unknown>): JSONSchema7 & Record<string, unknown> {
  return {
    ...value,
    type: "object",
    properties: isRecord(value.properties) ? value.properties : {},
  } as JSONSchema7 & Record<string, unknown>;
}

function neonAuthError() {
  return new GoatActionAuthError(
    "auth_expired",
    "neon",
    "The Neon connection needs reauthorization; reconnect Neon in Settings → Integrations.",
  );
}

function unwrapNeonMcpResult(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) return result;
  const texts = result.content
    .filter((entry): entry is { type: string; text: string } =>
      Boolean(isRecord(entry) && entry.type === "text" && typeof entry.text === "string"),
    )
    .map((entry) => entry.text);
  const joined = texts.join("\n");
  if (result.isError === true) {
    throw new Error(
      redactNeonConnectionStrings(joined) || "Neon returned an error for this action.",
    );
  }
  if (texts.length === 0) return result;
  try {
    return JSON.parse(joined) as unknown;
  } catch {
    return joined;
  }
}

function redactNeonSecrets(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[truncated nested value]";
  if (typeof value === "string") return redactNeonConnectionStrings(value);
  if (Array.isArray(value)) return value.map((entry) => redactNeonSecrets(entry, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      NEON_SENSITIVE_RESULT_KEY_PATTERN.test(key)
        ? "[redacted by OpenCompany]"
        : redactNeonSecrets(entry, depth + 1),
    ]),
  );
}

function redactNeonConnectionStrings(value: string) {
  return value.replace(NEON_POSTGRES_URI_PATTERN, "[redacted PostgreSQL connection string]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
