import { createMCPClient, type OAuthClientProvider } from "@ai-sdk/mcp";
import type { JSONSchema7, ToolExecutionOptions, ToolSet } from "ai";
import Ajv, { type AnySchema } from "ajv";
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
} from "@/lib/actions/types";
import {
  GOAT_LATITUDE_MCP_ENDPOINT_URL,
  getGoatLatitudeIntegrationState,
  loadGoatLatitudeMcpWorkerConnection,
} from "@/lib/integrations/latitude-mcp";

type LatitudeToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
  };
};

const latitudeSchemaValidator = new Ajv({ allErrors: true, strict: false });

export async function resolveLatitudeActions(
  userWorkosId: string,
): Promise<GoatActionProviderCatalog | null> {
  const state = await getGoatLatitudeIntegrationState(userWorkosId);
  const integrationId = state.integrationId;
  if (!state.connected || !integrationId) return null;

  const readEnabled = effectiveCapabilityMode("latitude", "read", state.capabilityModes) !== "off";
  const writeEnabled =
    effectiveCapabilityMode("latitude", "write", state.capabilityModes) !== "off";
  if (!readEnabled && !writeEnabled) return null;

  const connection = await loadGoatLatitudeMcpWorkerConnection({
    userWorkosId,
    onAuthorizationRequired: () => {
      throw latitudeAuthError();
    },
  });
  if (!connection.ok) return null;

  const client = await createLatitudeClient(connection.authProvider);
  let definitions: LatitudeToolDefinition[];
  try {
    const result = await client.listTools({
      options: { signal: AbortSignal.timeout(10_000) },
    });
    definitions = result.tools as LatitudeToolDefinition[];
  } finally {
    await client.close().catch(() => {});
  }

  const actions: ResolvedGoatAction[] = definitions.flatMap((definition) => {
    const capability = latitudeToolCapability(definition);
    if ((capability === "read" && !readEnabled) || (capability === "write" && !writeEnabled)) {
      return [];
    }
    return [
      {
        id: `latitude.${definition.name}`,
        provider: "latitude",
        capability,
        ...permissionAnnotation(capability, {
          integrationId,
          capabilityModes: state.capabilityModes,
        }),
        description:
          definition.description?.trim() ||
          `Run the ${definition.name} tool in the connected Latitude organization.`,
        params: latitudeInputSchema(definition.inputSchema),
        execute: (params, context) =>
          executeLatitudeAction({
            remoteName: definition.name,
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
    id: "latitude",
    label: "Latitude organization",
    description:
      "Inspect and manage Latitude projects, traces, annotations, signals, datasets, evaluations, and related workspace resources.",
    actions,
  };
}

function permissionAnnotation(
  capabilityId: GoatCapabilityId,
  state: { integrationId: string; capabilityModes: unknown },
): Pick<ResolvedGoatAction, "permissionMode" | "permission"> {
  if (effectiveCapabilityMode("latitude", capabilityId, state.capabilityModes) !== "ask") {
    return { permissionMode: "on" };
  }
  return {
    permissionMode: "ask",
    permission: {
      provider: "latitude",
      capabilityId,
      label: providerCapability("latitude", capabilityId)?.label ?? capabilityId,
      integrationIds: [state.integrationId],
    },
  };
}

async function executeLatitudeAction(input: {
  remoteName: string;
  expectedCapability: GoatCapabilityId;
  expectedIntegrationId: string;
  params: Record<string, unknown>;
  context: GoatActionExecuteContext;
}) {
  const state = await getGoatLatitudeIntegrationState(input.context.userWorkosId);
  if (!state.connected || !state.integrationId) throw latitudeAuthError();
  if (state.integrationId !== input.expectedIntegrationId) {
    throw new GoatActionPermissionError(
      "latitude",
      "The Latitude connection changed before this action could run. Retry so Goat can use the current connection and permission.",
    );
  }
  if (
    effectiveCapabilityMode("latitude", input.expectedCapability, state.capabilityModes) === "off"
  ) {
    throw new GoatActionPermissionError(
      "latitude",
      `${input.expectedCapability === "read" ? "Reading from" : "Writing to"} Latitude is turned off. It can be changed under Settings → Integrations.`,
    );
  }

  const connection = await loadGoatLatitudeMcpWorkerConnection({
    userWorkosId: input.context.userWorkosId,
    onAuthorizationRequired: () => {
      throw latitudeAuthError();
    },
  });
  if (!connection.ok) throw latitudeAuthError();
  if (connection.integrationId !== input.expectedIntegrationId) {
    throw new GoatActionPermissionError(
      "latitude",
      "The Latitude connection changed before this action could run. Retry so Goat can use the current connection and permission.",
    );
  }

  const client = await createLatitudeClient(connection.authProvider);
  try {
    const definitions = await client.listTools({ options: { signal: input.context.signal } });
    const currentDefinition = (definitions.tools as LatitudeToolDefinition[]).find(
      (definition) => definition.name === input.remoteName,
    );
    if (!currentDefinition) {
      throw new Error(
        `Latitude no longer exposes the "${input.remoteName}" tool; refresh the action catalog and try again.`,
      );
    }
    if (
      input.expectedCapability === "read" &&
      latitudeToolCapability(currentDefinition) !== "read"
    ) {
      throw new GoatActionPermissionError(
        "latitude",
        `Latitude changed the "${input.remoteName}" tool from read-only. Retry so Goat can request confirmation with the current permission.`,
      );
    }

    const validate = latitudeSchemaValidator.compile(
      latitudeInputSchema(currentDefinition.inputSchema) as AnySchema,
    );
    if (!validate(input.params)) {
      throw new GoatActionInvalidParamsError(
        `The parameters for "${input.remoteName}" do not match Latitude's current schema.`,
      );
    }

    const rawTools = client.toolsFromDefinitions(definitions) as ToolSet;
    const remote = rawTools[input.remoteName] as
      | { execute?: (value: unknown, options: ToolExecutionOptions) => Promise<unknown> }
      | undefined;
    const execute = remote?.execute?.bind(remote);
    if (!execute) {
      throw new Error(
        `Latitude no longer exposes the "${input.remoteName}" tool; refresh the action catalog and try again.`,
      );
    }
    const result = await execute(input.params, {
      toolCallId: `goat-action-latitude-${input.remoteName}`,
      messages: [],
      abortSignal: input.context.signal,
    });
    return unwrapLatitudeMcpResult(result);
  } finally {
    await client.close().catch(() => {});
  }
}

function createLatitudeClient(authProvider: OAuthClientProvider) {
  return createMCPClient({
    clientName: "opencompany-goat-actions",
    version: "0.1.0",
    transport: {
      type: "http" as const,
      url: GOAT_LATITUDE_MCP_ENDPOINT_URL,
      authProvider,
    },
  });
}

function latitudeToolCapability(definition: LatitudeToolDefinition): GoatCapabilityId {
  // MCP annotations are advisory. Unknown tools default to write/Ask so a
  // newly added Latitude mutation can never run without user confirmation.
  return definition.annotations?.readOnlyHint === true ? "read" : "write";
}

function latitudeInputSchema(
  value: Record<string, unknown>,
): JSONSchema7 & Record<string, unknown> {
  return {
    ...value,
    type: "object",
    properties: isRecord(value.properties) ? value.properties : {},
  } as JSONSchema7 & Record<string, unknown>;
}

function latitudeAuthError() {
  return new GoatActionAuthError(
    "auth_expired",
    "latitude",
    "The Latitude connection needs reauthorization; reconnect Latitude in Settings → Integrations.",
  );
}

function unwrapLatitudeMcpResult(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) return result;
  const texts = result.content
    .filter((entry): entry is { type: string; text: string } =>
      Boolean(isRecord(entry) && entry.type === "text" && typeof entry.text === "string"),
    )
    .map((entry) => entry.text);
  const joined = texts.join("\n");
  if (result.isError === true) {
    throw new Error(joined || "Latitude returned an error for this action.");
  }
  if (texts.length === 0) return result;
  try {
    return JSON.parse(joined) as unknown;
  } catch {
    return joined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
