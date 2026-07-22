import type { JSONSchema7 } from "ai";

export type GoatActionProviderId = "slack" | "gmail" | "google_drive" | "linear";

export type GoatActionErrorCode =
  | "not_connected"
  | "auth_expired"
  | "invalid_params"
  | "provider_error"
  | "timeout"
  | "call_budget"
  | "internal";

// What discovery (list_actions) exposes for one action. The params schema is
// documentation for the model; each action's execute is the enforcement.
export type GoatActionDescriptor = {
  id: string;
  provider: GoatActionProviderId;
  description: string;
  params: JSONSchema7;
};

export type GoatActionProviderDescriptor = {
  id: GoatActionProviderId;
  label: string;
  description: string;
};

export type GoatActionExecuteContext = {
  userWorkosId: string;
  signal: AbortSignal;
  currentDate: Date;
};

export type ResolvedGoatAction = GoatActionDescriptor & {
  execute: (params: Record<string, unknown>, context: GoatActionExecuteContext) => Promise<unknown>;
};

export type GoatActionProviderCatalog = GoatActionProviderDescriptor & {
  actions: ResolvedGoatAction[];
};

export type GoatResolvedActionCatalog = {
  providers: GoatActionProviderDescriptor[];
  actions: ResolvedGoatAction[];
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

// Thrown by action param validators so the executor can tell bad model input
// apart from provider failures.
export class GoatActionInvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoatActionInvalidParamsError";
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
