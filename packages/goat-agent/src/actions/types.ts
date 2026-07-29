import type { GoatManagedCapabilitySource } from "@opencompany/db/goat-schema";
import type { JSONSchema7 } from "ai";
import type { GoatCapabilityId } from "./capabilities";

export type GoatActionProviderId =
  | "slack"
  | "gmail"
  | "google_calendar"
  | "google_drive"
  | "linear"
  | "attio"
  | "github"
  | "stripe"
  | "latitude";

export type GoatActionSourceId = GoatActionProviderId | GoatManagedCapabilitySource;

export type GoatActionErrorCode =
  | "not_connected"
  | "auth_expired"
  | "invalid_params"
  | "provider_error"
  | "timeout"
  | "call_budget"
  | "approval_required"
  | "insufficient_credits"
  | "disabled"
  | "not_permitted"
  | "internal";

// What discovery (list_actions) exposes for one action. The params schema is
// documentation for the model; each action's execute is the enforcement.
export type GoatActionDescriptor = {
  id: string;
  provider: GoatActionSourceId;
  // Which human-readable permission capability this action belongs to (see
  // lib/actions/capabilities.ts). Every action must declare itself.
  capability: GoatCapabilityId;
  description: string;
  params: JSONSchema7;
};

export type GoatActionProviderDescriptor = {
  id: GoatActionProviderId;
  label: string;
  description: string;
};

export type GoatActionSourceDescriptor = {
  id: GoatActionSourceId;
  kind?: "integration" | "managed";
  label: string;
  description: string;
};

export type GoatCapabilityTurnState = {
  quotedTotalUsdMicros: number;
  admittedToolCallIds: string[];
  quotesByToolCallId: Map<string, GoatCapabilityQuote>;
  asyncRunsStarted: number;
};

export type GoatCapabilityQuote = {
  inputHash: string;
  quoteProviderCostUsdMicros: number;
  quotePlatformFeeUsdMicros: number;
  quoteTotalCostUsdMicros: number;
  decision: "auto" | "approval_required";
  runId?: string;
};

export type GoatActionExecuteContext = {
  userWorkosId: string;
  workspaceId?: string;
  chatSessionId?: string;
  toolCallId?: string;
  capabilityTurnState?: GoatCapabilityTurnState;
  signal: AbortSignal;
  currentDate: Date;
  userTimezone: string;
};

export type ResolvedGoatAction = GoatActionDescriptor & {
  timeoutMs?: number;
  // Internal-only larger result allowance for deliberately bounded actions
  // such as a validated full transcript. The executor still applies its hard cap.
  maxResultChars?: number;
  // Computed at resolve time from the connection's stored capability modes.
  // "off" never appears here — off actions are excluded from the catalog
  // entirely, so the model never sees them.
  permissionMode: "on" | "ask";
  // Present when permissionMode is "ask": what the in-chat confirm UI shows
  // and which connections an "always allow" decision flips to "on".
  permission?: {
    provider: GoatActionProviderId;
    capabilityId: GoatCapabilityId;
    label: string;
    integrationIds: string[];
  };
  execute: (params: Record<string, unknown>, context: GoatActionExecuteContext) => Promise<unknown>;
};

export type GoatActionProviderCatalog = GoatActionProviderDescriptor & {
  actions: ResolvedGoatAction[];
};

export type GoatResolvedActionCatalog = {
  // Kept as `providers` internally for compatibility with existing integration
  // resolvers. The chat-facing contract exposes these as sources.
  providers: GoatActionSourceDescriptor[];
  actions: ResolvedGoatAction[];
};

export type GoatActionApprovalView = {
  runId: string;
  source: GoatManagedCapabilitySource;
  action: string;
  maxCostUsdMicros: number;
  expiresAt: string;
  status: "awaiting_approval";
};

// Thrown when a stored connection cannot authenticate; the executor maps it to
// a structured error result carrying the reconnect hint.
export class GoatActionAuthError extends Error {
  readonly code: Extract<GoatActionErrorCode, "not_connected" | "auth_expired">;
  readonly provider: GoatActionProviderId;

  constructor(
    code: Extract<GoatActionErrorCode, "not_connected" | "auth_expired">,
    provider: GoatActionProviderId,
    message: string,
  ) {
    super(message);
    this.name = "GoatActionAuthError";
    this.code = code;
    this.provider = provider;
  }
}

// Thrown when a write executes against a connection whose capability was
// turned off after the catalog was resolved (settings flip mid-turn, or a
// multi-account call routed to an off account).
export class GoatActionPermissionError extends Error {
  readonly provider: GoatActionProviderId;

  constructor(provider: GoatActionProviderId, message: string) {
    super(message);
    this.name = "GoatActionPermissionError";
    this.provider = provider;
  }
}

// Thrown by action param validators so the executor can tell bad model input
// apart from provider failures.
export class GoatActionInvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoatActionInvalidParamsError";
  }
}

export class GoatActionExecutionError extends Error {
  readonly code: Extract<
    GoatActionErrorCode,
    | "provider_error"
    | "insufficient_credits"
    | "disabled"
    | "call_budget"
    | "timeout"
    | "approval_required"
  >;

  constructor(code: GoatActionExecutionError["code"], message: string) {
    super(message);
    this.name = "GoatActionExecutionError";
    this.code = code;
  }
}

export function requiredStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new GoatActionInvalidParamsError(`"${key}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

export function optionalStringParam(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new GoatActionInvalidParamsError(`"${key}" must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function optionalNumberParam(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GoatActionInvalidParamsError(`"${key}" must be a number.`);
  }
  return value;
}

export function clampCount(value: number | undefined, fallback: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

export function truncateText(value: string | undefined, maxChars: number) {
  if (value === undefined) return undefined;
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}
