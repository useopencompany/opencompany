import type { PermissionGroup } from "@opencompany/agent-runtime";

// Providers wired into the main-chat integration tools beta. Slack is planned
// but ships after its OAuth scope expansion; keep the union tight so pointer
// parsing rejects anything not implemented.
export type IntegrationProviderId = "linear" | "github";

export type IntegrationToolPointer = `tool://${IntegrationProviderId}/${string}`;
export type IntegrationProviderPointer = `integration://${IntegrationProviderId}`;

// Side-effect classes reuse the shared provider permission taxonomy. The beta
// exposes read tools only; the class is still recorded per tool so the write
// phase can gate on it without reshaping the registry.
export type IntegrationToolSideEffect = Extract<
  PermissionGroup,
  "read" | "post" | "modify" | "admin"
>;

export type IntegrationToolFieldType = "string" | "number" | "boolean" | "object" | "array";

// One field of a typed compact signature. The spike showed type-less compact
// signatures cause recoverable-but-wasteful invalid calls, so every field
// carries its primitive type and requiredness.
export type IntegrationToolField = {
  name: string;
  type: IntegrationToolFieldType;
  required?: boolean;
  description?: string;
  enumValues?: readonly string[];
};

export type IntegrationToolCard = {
  pointer: IntegrationToolPointer;
  provider: IntegrationProviderId;
  name: string;
  summary: string;
  sideEffect: IntegrationToolSideEffect;
  // Level 1 tools are surfaced in the dispatcher description when their
  // provider activates; the rest stay reachable via search/inspect.
  level1: boolean;
  fields: readonly IntegrationToolField[];
  // Strict tools own their full schema (GitHub adapter): unknown arguments are
  // rejected. Non-strict tools (Linear MCP) have curated partial signatures and
  // pass extra arguments through to the provider, which validates them.
  strict: boolean;
};

// A connected integration as the model sees it: label, capability summary, and
// a lossless pointer. Never credentials or account identifiers.
export type ConnectedIntegration = {
  provider: IntegrationProviderId;
  label: string;
  summary: string;
  pointer: IntegrationProviderPointer;
};

export type IntegrationToolCardView = {
  pointer: string;
  signature: string;
  summary: string;
  sideEffect: IntegrationToolSideEffect;
};

// Model-facing inputs/outputs of the three fixed dispatcher tools. Declared
// here (not in the dispatcher) so the client-shared chat-ui types can import
// them without pulling in dispatcher logic.
export type SearchIntegrationToolsInput = { query: string };

export type SearchIntegrationToolsOutput =
  | { ok: true; tools: IntegrationToolCardView[] }
  | { ok: false; error: string };

export type InspectIntegrationToolInput = { pointer: string };

export type InspectIntegrationToolOutput =
  | {
      ok: true;
      pointer: string;
      provider: IntegrationProviderId;
      description: string;
      sideEffect: IntegrationToolSideEffect;
      inputSchema: unknown;
      conventions: string[];
    }
  | {
      ok: true;
      pointer: string;
      provider: IntegrationProviderId;
      description: string;
      tools: IntegrationToolCardView[];
    }
  | { ok: false; error: string; availableTools?: IntegrationToolCardView[] };

export type CallIntegrationToolInput = {
  pointer: string;
  arguments?: Record<string, unknown>;
};

export type CallIntegrationToolOutput =
  | { ok: true; pointer: string; result: unknown; truncated?: boolean }
  | {
      ok: false;
      pointer?: string;
      error: string;
      validationErrors?: string[];
      // Recoverable errors include the compact signature (and available
      // pointers when relevant) so the model can correct the call in-turn.
      signature?: string;
      availableTools?: IntegrationToolCardView[];
    };

export function integrationProviderPointer(
  provider: IntegrationProviderId,
): IntegrationProviderPointer {
  return `integration://${provider}`;
}

export function isIntegrationProviderId(value: unknown): value is IntegrationProviderId {
  return value === "linear" || value === "github";
}

// Parses "tool://provider/name" and "integration://provider" pointers. Returns
// null for anything malformed so callers can respond with a recoverable error
// instead of guessing.
export function parseIntegrationPointer(
  value: unknown,
):
  | { kind: "tool"; provider: IntegrationProviderId; tool: string }
  | { kind: "provider"; provider: IntegrationProviderId }
  | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();

  const toolMatch = /^tool:\/\/([a-z0-9_-]+)\/([a-z0-9_-]+)$/i.exec(trimmed);
  if (toolMatch?.[1] && toolMatch[2]) {
    const provider = toolMatch[1].toLowerCase();
    if (!isIntegrationProviderId(provider)) return null;
    return { kind: "tool", provider, tool: toolMatch[2].toLowerCase() };
  }

  const providerMatch = /^integration:\/\/([a-z0-9_-]+)$/i.exec(trimmed);
  if (providerMatch?.[1]) {
    const provider = providerMatch[1].toLowerCase();
    if (!isIntegrationProviderId(provider)) return null;
    return { kind: "provider", provider };
  }

  return null;
}

// Renders a typed compact signature like:
//   list_issues(repository: string, state?: "open" | "closed" | "all")
export function formatCompactSignature(card: Pick<IntegrationToolCard, "name" | "fields">) {
  const fields = card.fields
    .map((field) => {
      const type = field.enumValues?.length
        ? field.enumValues.map((entry) => JSON.stringify(entry)).join(" | ")
        : field.type;
      return `${field.name}${field.required ? "" : "?"}: ${type}`;
    })
    .join(", ");
  return `${card.name}(${fields})`;
}

export function toIntegrationToolCardView(card: IntegrationToolCard): IntegrationToolCardView {
  return {
    pointer: card.pointer,
    signature: formatCompactSignature(card),
    summary: card.summary,
    sideEffect: card.sideEffect,
  };
}
