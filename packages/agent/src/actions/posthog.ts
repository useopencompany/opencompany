import { createMCPClient, type OAuthClientProvider } from "@ai-sdk/mcp";
import type { JSONSchema7, ToolExecutionOptions, ToolSet } from "ai";
import Ajv, { type AnySchema } from "ajv";
import {
  getPostHogIntegrationState,
  loadPostHogMcpWorkerConnection,
  POSTHOG_MCP_ENDPOINT_URL,
} from "../integrations/posthog-mcp";
import { type CapabilityId, effectiveCapabilityMode, providerCapability } from "./capabilities";
import {
  ACTION_EFFECTS_READ,
  ACTION_EFFECTS_WRITE,
  ActionAuthError,
  type ActionExecuteContext,
  ActionInvalidParamsError,
  ActionPermissionError,
  type ActionProviderCatalog,
  type ResolvedAction,
} from "./types";

type PostHogToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
};

const POSTHOG_ACTION_CAPABILITIES = {
  "dashboards-get-all": "read",
  "dashboard-get": "read",
  "dashboard-insights-run": "read",
  "insights-list": "read",
  "insight-get": "read",
  "insight-query": "read",
  "read-data-schema": "read",
  "query-trends": "read",
  "query-funnel": "read",
  "query-retention": "read",
  "query-paths": "read",
  "query-stickiness": "read",
  "query-lifecycle": "read",
  "insight-create": "write",
} as const satisfies Record<string, CapabilityId>;

type PostHogActionToolName = keyof typeof POSTHOG_ACTION_CAPABILITIES;

const posthogSchemaValidator = new Ajv({ allErrors: true, strict: false });

export async function resolvePostHogActions(
  userWorkosId: string,
): Promise<ActionProviderCatalog | null> {
  const state = await getPostHogIntegrationState(userWorkosId);
  const integrationId = state.integrationId;
  if (!state.connected || !integrationId) return null;

  const readEnabled = effectiveCapabilityMode("posthog", "read", state.capabilityModes) !== "off";
  const writeEnabled = effectiveCapabilityMode("posthog", "write", state.capabilityModes) !== "off";
  if (!readEnabled && !writeEnabled) return null;

  const connection = await loadPostHogMcpWorkerConnection({
    userWorkosId,
    onAuthorizationRequired: () => {
      throw posthogAuthError();
    },
  });
  if (!connection.ok) return null;

  const client = await createPostHogClient(connection.authProvider);
  let definitions: PostHogToolDefinition[];
  try {
    const result = await client.listTools({
      options: { signal: AbortSignal.timeout(10_000) },
    });
    definitions = result.tools as PostHogToolDefinition[];
  } finally {
    await client.close().catch(() => {});
  }

  const actions: ResolvedAction[] = definitions.flatMap((definition) => {
    if (!isPostHogActionToolName(definition.name)) return [];
    const remoteName = definition.name;
    const capability = POSTHOG_ACTION_CAPABILITIES[remoteName];
    if ((capability === "read" && !readEnabled) || (capability === "write" && !writeEnabled)) {
      return [];
    }
    return [
      {
        id: `posthog.${remoteName}`,
        provider: "posthog",
        capability,
        effects: capability === "read" ? ACTION_EFFECTS_READ : ACTION_EFFECTS_WRITE,
        ...permissionAnnotation(capability, {
          integrationId,
          capabilityModes: state.capabilityModes,
        }),
        description: definition.description?.trim() || fallbackDescription(remoteName, capability),
        params: posthogInputSchema(definition.inputSchema),
        execute: (params, context) =>
          executePostHogAction({
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
    id: "posthog",
    label: "PostHog product analytics",
    description:
      readEnabled && writeEnabled
        ? "Explore product data and dashboards, run analytics queries, and create saved insights."
        : readEnabled
          ? "Explore product data and dashboards and run analytics queries."
          : "Create saved product insights in PostHog.",
    actions,
  };
}

function permissionAnnotation(
  capabilityId: CapabilityId,
  state: { integrationId: string; capabilityModes: unknown },
): Pick<ResolvedAction, "permissionMode" | "permission"> {
  if (effectiveCapabilityMode("posthog", capabilityId, state.capabilityModes) !== "ask") {
    return { permissionMode: "on" };
  }
  return {
    permissionMode: "ask",
    permission: {
      provider: "posthog",
      capabilityId,
      label: providerCapability("posthog", capabilityId)?.label ?? capabilityId,
      integrationIds: [state.integrationId],
    },
  };
}

async function executePostHogAction(input: {
  remoteName: PostHogActionToolName;
  expectedCapability: CapabilityId;
  expectedIntegrationId: string;
  params: Record<string, unknown>;
  context: ActionExecuteContext;
}) {
  const state = await getPostHogIntegrationState(input.context.userWorkosId);
  if (!state.connected || !state.integrationId) throw posthogAuthError();
  if (state.integrationId !== input.expectedIntegrationId) {
    throw new ActionPermissionError(
      "posthog",
      "The PostHog connection changed before this action could run. Retry so opencompany can use the current connection and permission.",
    );
  }
  if (
    effectiveCapabilityMode("posthog", input.expectedCapability, state.capabilityModes) === "off"
  ) {
    throw new ActionPermissionError(
      "posthog",
      `${input.expectedCapability === "read" ? "Reading from" : "Creating insights in"} PostHog is turned off. It can be changed under Settings → Integrations.`,
    );
  }

  const connection = await loadPostHogMcpWorkerConnection({
    userWorkosId: input.context.userWorkosId,
    onAuthorizationRequired: () => {
      throw posthogAuthError();
    },
  });
  if (!connection.ok) throw posthogAuthError();
  if (connection.integrationId !== input.expectedIntegrationId) {
    throw new ActionPermissionError(
      "posthog",
      "The PostHog connection changed before this action could run. Retry so opencompany can use the current connection and permission.",
    );
  }

  const client = await createPostHogClient(connection.authProvider);
  try {
    const definitions = await client.listTools({ options: { signal: input.context.signal } });
    const currentDefinition = (definitions.tools as PostHogToolDefinition[]).find(
      (definition) => definition.name === input.remoteName,
    );
    if (!currentDefinition) {
      throw new Error(
        `PostHog no longer exposes the "${input.remoteName}" tool; refresh the action catalog and try again.`,
      );
    }
    if (
      input.expectedCapability === "read" &&
      currentDefinition.annotations?.readOnlyHint !== true
    ) {
      throw new ActionPermissionError(
        "posthog",
        `PostHog changed the "${input.remoteName}" tool from read-only. Retry so opencompany can request confirmation with the current permission.`,
      );
    }
    if (currentDefinition.annotations?.destructiveHint === true) {
      throw new ActionPermissionError(
        "posthog",
        `PostHog marked the "${input.remoteName}" tool as destructive, so opencompany will not run it.`,
      );
    }

    const validate = posthogSchemaValidator.compile(
      posthogInputSchema(currentDefinition.inputSchema) as AnySchema,
    );
    if (!validate(input.params)) {
      throw new ActionInvalidParamsError(
        `The parameters for "${input.remoteName}" do not match PostHog's current schema.`,
      );
    }

    const rawTools = client.toolsFromDefinitions(definitions) as ToolSet;
    const remote = rawTools[input.remoteName] as
      | {
          execute?: (
            value: unknown,
            options: ToolExecutionOptions<Record<string, unknown>>,
          ) => Promise<unknown>;
        }
      | undefined;
    const execute = remote?.execute?.bind(remote);
    if (!execute) {
      throw new Error(
        `PostHog no longer exposes the "${input.remoteName}" tool; refresh the action catalog and try again.`,
      );
    }
    const result = await execute(input.params, {
      toolCallId: `goat-action-posthog-${input.remoteName}`,
      messages: [],
      abortSignal: input.context.signal,
      context: {},
    });
    return unwrapPostHogMcpResult(result);
  } finally {
    await client.close().catch(() => {});
  }
}

function createPostHogClient(authProvider: OAuthClientProvider) {
  return createMCPClient({
    clientName: "opencompany-goat-actions",
    version: "0.1.0",
    transport: {
      type: "http" as const,
      url: POSTHOG_MCP_ENDPOINT_URL,
      authProvider,
    },
  });
}

function isPostHogActionToolName(name: string): name is PostHogActionToolName {
  return Object.hasOwn(POSTHOG_ACTION_CAPABILITIES, name);
}

function posthogInputSchema(value: Record<string, unknown>): JSONSchema7 & Record<string, unknown> {
  return {
    ...value,
    type: "object",
    properties: isRecord(value.properties) ? value.properties : {},
  } as JSONSchema7 & Record<string, unknown>;
}

function fallbackDescription(name: PostHogActionToolName, capability: CapabilityId) {
  return `${capability === "read" ? "Run" : "Create"} ${name.replaceAll("-", " ")} in the connected PostHog project.`;
}

function posthogAuthError() {
  return new ActionAuthError(
    "auth_expired",
    "posthog",
    "The PostHog connection needs reauthorization; reconnect PostHog in Settings → Integrations.",
  );
}

function unwrapPostHogMcpResult(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) return result;
  const texts = result.content
    .filter((entry): entry is { type: string; text: string } =>
      Boolean(isRecord(entry) && entry.type === "text" && typeof entry.text === "string"),
    )
    .map((entry) => entry.text);
  const joined = texts.join("\n");
  if (result.isError === true) {
    throw new Error(joined || "PostHog returned an error for this action.");
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
