import type { EngineRuntimeStatus } from "@opencompany/protocol";

export type EngineSandboxState =
  | { kind: "pending" }
  | { kind: "resolved"; status: EngineRuntimeStatus | null }
  | { kind: "unavailable"; lastKnownStatus: EngineRuntimeStatus | null };

export const PENDING_ENGINE_SANDBOX_STATE: EngineSandboxState = { kind: "pending" };

export function resolvedEngineSandboxState(status: EngineRuntimeStatus | null): EngineSandboxState {
  return { kind: "resolved", status };
}

export function unavailableEngineSandboxState(previous: EngineSandboxState): EngineSandboxState {
  return {
    kind: "unavailable",
    lastKnownStatus: currentEngineSandboxStatus(previous),
  };
}

export function currentEngineSandboxStatus(state: EngineSandboxState): EngineRuntimeStatus | null {
  if (state.kind === "resolved") return state.status;
  if (state.kind === "unavailable") return state.lastKnownStatus;
  return null;
}
