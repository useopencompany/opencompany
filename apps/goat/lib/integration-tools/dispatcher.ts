import { boundIntegrationToolResult } from "./bounded";
import {
  findIntegrationToolDefinition,
  INTEGRATION_PROVIDER_LABELS,
  integrationToolDefinitionsForProviders,
  toIntegrationToolDefinitionView,
} from "./registry";
import type {
  CallIntegrationToolInput,
  CallIntegrationToolOutput,
  IntegrationToolDefinition,
  IntegrationToolProvider,
  SearchIntegrationToolsInput,
  SearchIntegrationToolsOutput,
} from "./types";
import { providerFromToolName } from "./types";

const MAX_SEARCH_RESULTS = 12;

// Provider executors are injected by the route so this module stays pure and
// unit-testable. Each executor re-resolves credentials and access on every
// call — the request-time catalog is a hint for the model, never an
// authorization boundary.
export type IntegrationToolExecutor = (input: {
  tool: IntegrationToolDefinition;
  args: Record<string, unknown>;
}) => Promise<unknown>;

export type IntegrationToolDispatcher = {
  providers: IntegrationToolProvider[];
  search: (input: SearchIntegrationToolsInput) => SearchIntegrationToolsOutput;
  call: (input: CallIntegrationToolInput) => Promise<CallIntegrationToolOutput>;
};

export function createIntegrationToolDispatcher(input: {
  connectedProviders: readonly IntegrationToolProvider[];
  executors: Partial<Record<IntegrationToolProvider, IntegrationToolExecutor>>;
}): IntegrationToolDispatcher {
  const providers = input.connectedProviders.filter(
    (provider) => input.executors[provider] !== undefined,
  );

  const availableToolNames = (provider?: IntegrationToolProvider | null) =>
    integrationToolDefinitionsForProviders(
      provider && providers.includes(provider) ? [provider] : providers,
    ).map((definition) => definition.name);

  return {
    providers,
    search: ({ query }) => {
      if (providers.length === 0) {
        return { ok: false, error: "No integrations are connected." };
      }
      const definitions = integrationToolDefinitionsForProviders(providers);
      const ranked = rankToolDefinitions(definitions, query);
      if (ranked.length === 0) {
        return {
          ok: true,
          tools: [],
          guidance: `No matching tools. Connected providers: ${providers.join(", ")}. Search with a provider name to list everything it offers.`,
        };
      }
      return { ok: true, tools: ranked.map(toIntegrationToolDefinitionView) };
    },
    call: async ({ tool: toolName, arguments: rawArgs }) => {
      const name = typeof toolName === "string" ? toolName.trim() : "";
      const definition = name ? findIntegrationToolDefinition(name) : null;
      if (!definition) {
        return {
          ok: false,
          ...(name ? { tool: name } : {}),
          error: `Unknown integration tool ${JSON.stringify(name)}. Use a tool name returned by search_integration_tools.`,
          availableTools: availableToolNames(name ? providerFromToolName(name) : null),
        };
      }
      if (!providers.includes(definition.provider)) {
        return {
          ok: false,
          tool: definition.name,
          error: `${INTEGRATION_PROVIDER_LABELS[definition.provider]} is not connected for this user, so its tools are unavailable.`,
          availableTools: availableToolNames(null),
        };
      }
      const executor = input.executors[definition.provider];
      if (!executor) {
        return {
          ok: false,
          tool: definition.name,
          error: `${INTEGRATION_PROVIDER_LABELS[definition.provider]} tools are unavailable right now.`,
        };
      }

      const args = isRecord(rawArgs) ? rawArgs : {};
      const validationErrors = validateIntegrationToolArguments(definition, args);
      if (validationErrors.length > 0) {
        return {
          ok: false,
          tool: definition.name,
          error: "Invalid arguments. Fix the listed problems and call again.",
          validationErrors,
        };
      }

      try {
        const raw = await executor({ tool: definition, args });
        const bounded = boundIntegrationToolResult(raw);
        return {
          ok: true,
          tool: definition.name,
          result: bounded.result,
          ...(bounded.truncated ? { truncated: true } : {}),
        };
      } catch (error) {
        return {
          ok: false,
          tool: definition.name,
          error: describeIntegrationError(error),
        };
      }
    },
  };
}

export function validateIntegrationToolArguments(
  definition: IntegrationToolDefinition,
  args: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const { properties, required } = definition.inputSchema;

  for (const name of required ?? []) {
    if (args[name] === undefined || args[name] === null) {
      errors.push(`Missing required argument "${name}".`);
    }
  }

  for (const [name, value] of Object.entries(args)) {
    const property = properties[name];
    if (!property) {
      errors.push(`Unknown argument "${name}".`);
      continue;
    }
    if (value === undefined || value === null) continue;
    if (!matchesPropertyType(value, property.type)) {
      errors.push(`Argument "${name}" must be of type ${property.type}.`);
      continue;
    }
    if (property.enum?.length && !property.enum.includes(String(value))) {
      errors.push(`Argument "${name}" must be one of: ${property.enum.join(", ")}.`);
    }
  }

  return errors;
}

function matchesPropertyType(value: unknown, type: "string" | "number" | "boolean") {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
  }
}

function rankToolDefinitions(definitions: readonly IntegrationToolDefinition[], query: string) {
  const tokens = (query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
  if (tokens.length === 0) return definitions.slice(0, MAX_SEARCH_RESULTS);

  return definitions
    .map((definition) => {
      const providerLabel = INTEGRATION_PROVIDER_LABELS[definition.provider].toLowerCase();
      const name = definition.name.replace(/_/g, " ").toLowerCase();
      const description = definition.description.toLowerCase();
      const score = tokens.reduce((sum, token) => {
        if (definition.provider === token || providerLabel === token) return sum + 3;
        if (name.includes(token)) return sum + 2;
        if (definition.keywords.includes(token)) return sum + 2;
        if (description.includes(token)) return sum + 1;
        return sum;
      }, 0);
      return { definition, score };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.definition.name.localeCompare(right.definition.name),
    )
    .slice(0, MAX_SEARCH_RESULTS)
    .map((entry) => entry.definition);
}

// Provider error strings can embed whole API response bodies; keep them
// recoverable but bounded.
function describeIntegrationError(error: unknown) {
  const message = error instanceof Error && error.message ? error.message : "";
  if (!message) return "The integration call failed.";
  return message.length > 600 ? `${message.slice(0, 600)}… [truncated]` : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
