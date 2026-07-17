import { boundIntegrationToolResult } from "./bounded";
import {
  connectedIntegrationForProvider,
  findIntegrationToolCard,
  integrationToolCardsForProviders,
  level1IntegrationToolCards,
} from "./registry";
import type {
  CallIntegrationToolOutput,
  ConnectedIntegration,
  InspectIntegrationToolOutput,
  IntegrationProviderId,
  IntegrationToolCard,
  IntegrationToolCardView,
  SearchIntegrationToolsOutput,
} from "./types";
import {
  formatCompactSignature,
  parseIntegrationPointer,
  toIntegrationToolCardView,
} from "./types";

const MAX_SEARCH_RESULTS = 8;

// Provider executors are injected by the route so this module stays pure and
// unit-testable. Each executor re-resolves connection state, ownership, and
// resource access on every call — the request-time catalog is a hint for the
// model, never an authorization boundary.
export type IntegrationProviderExecutor = {
  execute: (input: {
    tool: IntegrationToolCard;
    args: Record<string, unknown>;
  }) => Promise<unknown>;
  // Full Level 2 detail for one tool: live schema for MCP-backed providers,
  // registry schema plus live constraints (like the repo allowlist) otherwise.
  inspect: (input: { tool: IntegrationToolCard }) => Promise<{
    inputSchema: unknown;
    conventions: string[];
  }>;
};

export type IntegrationToolDispatcher = {
  connectedIntegrations: ConnectedIntegration[];
  activatedProviders: IntegrationProviderId[];
  level1CardsText: string;
  search: (input: { query: string }) => SearchIntegrationToolsOutput;
  inspect: (input: { pointer: string }) => Promise<InspectIntegrationToolOutput>;
  call: (input: {
    pointer: string;
    arguments?: Record<string, unknown>;
  }) => Promise<CallIntegrationToolOutput>;
};

export function createIntegrationToolDispatcher(input: {
  connectedProviders: readonly IntegrationProviderId[];
  activatedProviders: readonly IntegrationProviderId[];
  executors: Partial<Record<IntegrationProviderId, IntegrationProviderExecutor>>;
}): IntegrationToolDispatcher {
  const connectedProviders = input.connectedProviders.filter(
    (provider) => input.executors[provider] !== undefined,
  );
  const activatedProviders = input.activatedProviders.filter((provider) =>
    connectedProviders.includes(provider),
  );
  const level1Cards = level1IntegrationToolCards(activatedProviders);

  const resolveCard = (
    pointer: string,
  ):
    | { ok: true; kind: "tool"; card: IntegrationToolCard; executor: IntegrationProviderExecutor }
    | { ok: true; kind: "provider"; provider: IntegrationProviderId }
    | { ok: false; error: string; availableTools?: IntegrationToolCardView[] } => {
    const parsed = parseIntegrationPointer(pointer);
    if (!parsed) {
      return {
        ok: false,
        error: `Invalid pointer ${JSON.stringify(pointer)}. Use tool://provider/name or integration://provider. Call search_integration_tools to list valid pointers.`,
      };
    }
    if (!connectedProviders.includes(parsed.provider)) {
      return {
        ok: false,
        error: `${parsed.provider} is not connected for this user or workspace, so its tools are unavailable.`,
      };
    }
    if (parsed.kind === "provider")
      return { ok: true, kind: "provider", provider: parsed.provider };

    const card = findIntegrationToolCard(parsed.provider, parsed.tool);
    const executor = input.executors[parsed.provider];
    if (!card || !executor) {
      return {
        ok: false,
        error: `Unknown tool pointer ${JSON.stringify(pointer)}.`,
        availableTools: integrationToolCardsForProviders([parsed.provider]).map(
          toIntegrationToolCardView,
        ),
      };
    }
    return { ok: true, kind: "tool", card, executor };
  };

  return {
    connectedIntegrations: connectedProviders.map(connectedIntegrationForProvider),
    activatedProviders,
    level1CardsText: formatLevel1CardsText(level1Cards),
    search: ({ query }) => {
      if (connectedProviders.length === 0) {
        return { ok: false, error: "No integrations are connected." };
      }
      const cards = integrationToolCardsForProviders(connectedProviders);
      return { ok: true, tools: rankToolCards(cards, query).map(toIntegrationToolCardView) };
    },
    inspect: async ({ pointer }) => {
      const resolved = resolveCard(pointer);
      if (!resolved.ok) return resolved;

      if (resolved.kind === "provider") {
        const integration = connectedIntegrationForProvider(resolved.provider);
        return {
          ok: true,
          pointer: integration.pointer,
          provider: resolved.provider,
          description: `${integration.label} — ${integration.summary}.`,
          tools: integrationToolCardsForProviders([resolved.provider]).map(
            toIntegrationToolCardView,
          ),
        };
      }

      try {
        const detail = await resolved.executor.inspect({ tool: resolved.card });
        return {
          ok: true,
          pointer: resolved.card.pointer,
          provider: resolved.card.provider,
          description: resolved.card.summary,
          sideEffect: resolved.card.sideEffect,
          inputSchema: detail.inputSchema,
          conventions: detail.conventions,
        };
      } catch (error) {
        return { ok: false, error: describeIntegrationError(error) };
      }
    },
    call: async ({ pointer, arguments: rawArgs }) => {
      const resolved = resolveCard(pointer);
      if (!resolved.ok) return resolved;
      if (resolved.kind === "provider") {
        return {
          ok: false,
          pointer,
          error: `integration:// pointers cannot be called. Call a tool:// pointer, for example ${
            integrationToolCardsForProviders([resolved.provider])[0]?.pointer ?? "tool://…"
          }.`,
          availableTools: integrationToolCardsForProviders([resolved.provider]).map(
            toIntegrationToolCardView,
          ),
        };
      }

      const { card, executor } = resolved;
      // The beta is read-only. Registry cards are all reads today; this guard
      // keeps a future registry write from leaking past the approval work.
      if (card.sideEffect !== "read") {
        return {
          ok: false,
          pointer: card.pointer,
          error: `${card.name} performs a ${card.sideEffect} action, which is not yet available in chat.`,
        };
      }

      const args = isRecord(rawArgs) ? rawArgs : {};
      const validationErrors = validateIntegrationToolArguments(card, args);
      if (validationErrors.length > 0) {
        return {
          ok: false,
          pointer: card.pointer,
          error: "Invalid arguments. Fix the listed problems and call again.",
          validationErrors,
          signature: formatCompactSignature(card),
        };
      }

      try {
        const raw = await executor.execute({ tool: card, args });
        const bounded = boundIntegrationToolResult(raw);
        return {
          ok: true,
          pointer: card.pointer,
          result: bounded.result,
          ...(bounded.truncated ? { truncated: true } : {}),
        };
      } catch (error) {
        return {
          ok: false,
          pointer: card.pointer,
          error: describeIntegrationError(error),
          signature: formatCompactSignature(card),
        };
      }
    },
  };
}

export function validateIntegrationToolArguments(
  card: IntegrationToolCard,
  args: Record<string, unknown>,
): string[] {
  const errors: string[] = [];

  for (const field of card.fields) {
    const value = args[field.name];
    if (value === undefined || value === null) {
      if (field.required) errors.push(`Missing required argument "${field.name}".`);
      continue;
    }
    if (!matchesFieldType(value, field.type)) {
      errors.push(`Argument "${field.name}" must be of type ${field.type}.`);
      continue;
    }
    if (field.enumValues?.length && !field.enumValues.includes(String(value))) {
      errors.push(`Argument "${field.name}" must be one of: ${field.enumValues.join(", ")}.`);
    }
  }

  // Strict tools own their full schema; unknown arguments are mistakes. MCP
  // tools have curated partial signatures, so extras pass through.
  if (card.strict) {
    const known = new Set(card.fields.map((field) => field.name));
    for (const key of Object.keys(args)) {
      if (!known.has(key)) errors.push(`Unknown argument "${key}".`);
    }
  }

  return errors;
}

function matchesFieldType(value: unknown, type: IntegrationToolCard["fields"][number]["type"]) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
  }
}

function rankToolCards(cards: readonly IntegrationToolCard[], query: string) {
  const tokens = (query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
  if (tokens.length === 0) return cards.slice(0, MAX_SEARCH_RESULTS);

  return cards
    .map((card) => {
      const haystack =
        `${card.provider} ${card.name.replace(/_/g, " ")} ${card.summary}`.toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      return { card, score };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.card.pointer.localeCompare(right.card.pointer),
    )
    .slice(0, MAX_SEARCH_RESULTS)
    .map((entry) => entry.card);
}

function formatLevel1CardsText(cards: readonly IntegrationToolCard[]) {
  if (cards.length === 0) return "";
  return cards
    .map(
      (card) =>
        `- ${card.pointer} — ${formatCompactSignature(card)} [${card.sideEffect}]: ${card.summary}`,
    )
    .join("\n");
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
