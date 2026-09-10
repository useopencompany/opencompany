import {
  ACTION_DESCRIPTION_PREVIEW_LENGTH,
  ACTION_MAX_CALLS_PER_TURN,
  ACTION_MAX_PROVIDER_FAILURES_PER_TURN,
  type ActionDescriptor,
  type ActionGatewayRequest,
  type ActionGatewayResponse,
  type ActionSummary,
  DESCRIBE_ACTIONS_INPUT_ERROR,
  isDescribeActionsInput,
} from "@opencompany/agent-runtime";
import type { ActionSourceDescriptor } from "./types";

export type ActionServiceCatalog = {
  sources: readonly ActionSourceDescriptor[];
  actions: readonly {
    id: string;
    source: string;
    description: string;
    params: unknown;
    permissionMode?: "on" | "ask";
  }[];
};

export type ActionInvocationClaim =
  | { ok: true; callCount: number; duplicate: boolean }
  | { ok: false; reason: "list_required" | "call_budget" };

export type ActionTurnGovernance = {
  recordSourceDiscovery: (sourceId: string) => Promise<void>;
  claimInvocation: (input: {
    sourceId: string;
    invocationId: string;
    maxCalls: number;
  }) => Promise<ActionInvocationClaim>;
  hasDiscoveredSource?: (sourceId: string) => boolean;
  acquireProviderAttempt?: (action: string, signal?: AbortSignal) => Promise<boolean>;
  completeProviderAttempt?: (action: string, outcome: "success" | "failure" | "neutral") => void;
};

export async function serveActionRequest(input: {
  request: ActionGatewayRequest;
  catalog: ActionServiceCatalog;
  governance: ActionTurnGovernance;
  execute: (input: {
    action: string;
    params: Record<string, unknown>;
    invocationId: string;
  }) => Promise<ActionGatewayResponse>;
  legacyDiscovery?: boolean;
  maxCalls?: number;
  signal?: AbortSignal;
}): Promise<ActionGatewayResponse> {
  const request = input.request;
  if (request.operation === "list") {
    const sourceId = request.source;
    if (!sourceId) {
      return {
        ok: true,
        sources: input.catalog.sources.map(({ id, kind, label, description }) => ({
          id,
          kind: kind ?? "integration",
          label,
          description,
        })),
      };
    }

    const source = input.catalog.sources.find((entry) => entry.id === sourceId);
    if (!source) {
      return {
        ok: false,
        error: {
          code: "unknown_source",
          message: `Unknown source ${JSON.stringify(sourceId)}. Use an exact id returned by list_actions.`,
          availableSources: input.catalog.sources.map((entry) => entry.id),
        },
      };
    }
    await input.governance.recordSourceDiscovery(source.id);
    return {
      ok: true,
      source: {
        id: source.id,
        kind: source.kind ?? "integration",
        label: source.label,
        description: source.description,
      },
      actions: input.catalog.actions
        .filter((action) => action.source === source.id)
        .map((action) =>
          input.legacyDiscovery ? actionDescriptor(action) : summarizeAction(action),
        ),
    };
  }

  if (request.operation === "describe") {
    if (input.legacyDiscovery) {
      return {
        ok: false,
        error: {
          code: "invalid_params",
          message:
            "describe_actions requires host tool contract v5. Use list_actions for this contract.",
        },
      };
    }
    // Validate before deduplication: oversized batches must never be silently accepted.
    if (!isDescribeActionsInput({ actions: request.actions })) {
      return {
        ok: false,
        error: {
          code: "invalid_params",
          message: DESCRIBE_ACTIONS_INPUT_ERROR,
        },
      };
    }
    const actions: ActionDescriptor[] = [];
    const not_found: string[] = [];
    const sources = new Set<string>();
    for (const id of new Set(request.actions)) {
      const action = input.catalog.actions.find((entry) => entry.id === id);
      if (!action) not_found.push(id);
      else {
        actions.push(actionDescriptor(action));
        sources.add(action.source);
      }
    }
    for (const source of sources) await input.governance.recordSourceDiscovery(source);
    return { ok: true, actions, not_found };
  }

  const actionId = request.action;
  const action = input.catalog.actions.find((entry) => entry.id === actionId);
  if (!action) {
    return {
      ok: false,
      action: actionId,
      error: {
        code: "invalid_params",
        message: `"${actionId}" is not an available action. Call list_actions with the relevant source id for the current catalog.`,
      },
    };
  }

  const maxCalls = input.maxCalls ?? ACTION_MAX_CALLS_PER_TURN;
  const claim = await input.governance.claimInvocation({
    sourceId: action.source,
    invocationId: request.invocationId,
    maxCalls,
  });
  if (!claim.ok) {
    return {
      ok: false,
      action: action.id,
      error:
        claim.reason === "list_required"
          ? {
              code: "invalid_params",
              source: action.source,
              message: input.legacyDiscovery
                ? `Call list_actions with source ${JSON.stringify(action.source)} in this chat turn before using ${JSON.stringify(action.id)}.`
                : `List source ${JSON.stringify(action.source)} with list_actions or describe the action with describe_actions before using ${JSON.stringify(action.id)}.`,
            }
          : {
              code: "call_budget",
              source: action.source,
              message: `This turn has reached its limit of ${maxCalls} action calls.`,
            },
    };
  }
  if (claim.duplicate) {
    return {
      ok: false,
      action: action.id,
      error: {
        code: "duplicate_invocation",
        source: action.source,
        message:
          "This action invocation or identical write was already admitted in this turn, so the service did not dispatch it again. Preserve its earlier result. If the outcome is uncertain, read the provider state before proposing another change; do not retry the same write with a new call id.",
      },
    };
  }

  if (
    input.governance.acquireProviderAttempt &&
    !(await input.governance.acquireProviderAttempt(action.id, input.signal))
  ) {
    return {
      ok: false,
      action: action.id,
      error: {
        code: "provider_error",
        source: action.source,
        message: `opencompany stopped further attempts of ${JSON.stringify(action.id)} after repeated failures in this turn. This limit is enforced by opencompany; use the earlier errors to explain the cause. Do not call it again now; summarize any results already available and explain what remains unverified.`,
      },
    };
  }

  let outcome: "success" | "failure" | "neutral" = "neutral";
  try {
    const response = await input.execute({
      action: action.id,
      params: request.params,
      invocationId: request.invocationId,
    });
    if (response.ok) {
      outcome = "success";
    } else if (
      (response.error.code === "provider_error" || response.error.code === "timeout") &&
      !isRetrySafeProviderFlake(response.error.message)
    ) {
      outcome = "failure";
    }
    return response;
  } finally {
    input.governance.completeProviderAttempt?.(action.id, outcome);
  }
}

function actionDescriptor(action: ActionDescriptor): ActionDescriptor {
  return {
    id: action.id,
    source: action.source,
    description: action.description,
    params: action.params,
    ...(action.permissionMode ? { permissionMode: action.permissionMode } : {}),
  };
}

export function summarizeAction(action: ActionDescriptor): ActionSummary {
  const description = action.description.replace(/\s+/gu, " ").trim();
  return {
    id: action.id,
    source: action.source,
    description:
      description.length <= ACTION_DESCRIPTION_PREVIEW_LENGTH
        ? description
        : `${description.slice(0, ACTION_DESCRIPTION_PREVIEW_LENGTH - 1).trimEnd()}…`,
    ...(action.permissionMode ? { permissionMode: action.permissionMode } : {}),
  };
}

export function createInMemoryActionTurnGovernance(
  input: { prelistedSourceIds?: readonly string[]; maxProviderFailures?: number } = {},
): ActionTurnGovernance {
  const discoveredSourceIds = new Set(input.prelistedSourceIds ?? []);
  const invocationIds = new Set<string>();
  let callCount = 0;
  const providerRetryGate = createProviderRetryGate(
    input.maxProviderFailures ?? ACTION_MAX_PROVIDER_FAILURES_PER_TURN,
  );

  return {
    async recordSourceDiscovery(sourceId) {
      discoveredSourceIds.add(sourceId);
    },
    async claimInvocation({ sourceId, invocationId, maxCalls }) {
      if (!discoveredSourceIds.has(sourceId)) {
        return { ok: false, reason: "list_required" };
      }
      if (invocationIds.has(invocationId)) {
        return { ok: true, callCount, duplicate: true };
      }
      if (callCount >= maxCalls) {
        return { ok: false, reason: "call_budget" };
      }
      invocationIds.add(invocationId);
      callCount += 1;
      return { ok: true, callCount, duplicate: false };
    },
    hasDiscoveredSource(sourceId) {
      return discoveredSourceIds.has(sourceId);
    },
    acquireProviderAttempt: providerRetryGate.acquire,
    completeProviderAttempt: providerRetryGate.complete,
  };
}

function createProviderRetryGate(maxFailures: number) {
  const failureCounts = new Map<string, number>();
  const callsInFlight = new Map<string, number>();
  const stateSignals = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  function waitForStateChange(action: string, signal?: AbortSignal) {
    const existing = stateSignals.get(action);
    let statePromise = existing?.promise;
    if (!statePromise) {
      let resolve!: () => void;
      statePromise = new Promise<void>((release) => {
        resolve = release;
      });
      stateSignals.set(action, { promise: statePromise, resolve });
    }
    if (!signal) return statePromise;
    if (signal.aborted) return Promise.reject(actionAbortReason(signal));
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(actionAbortReason(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      void statePromise.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  function notifyStateChange(action: string) {
    const stateSignal = stateSignals.get(action);
    if (!stateSignal) return;
    stateSignals.delete(action);
    stateSignal.resolve();
  }

  return {
    async acquire(action: string, signal?: AbortSignal) {
      while (true) {
        if (signal?.aborted) throw actionAbortReason(signal);
        const failures = failureCounts.get(action) ?? 0;
        if (failures >= maxFailures) return false;
        const inFlight = callsInFlight.get(action) ?? 0;
        if (failures + inFlight < maxFailures) {
          callsInFlight.set(action, inFlight + 1);
          return true;
        }
        await waitForStateChange(action, signal);
      }
    },
    complete(action: string, outcome: "success" | "failure" | "neutral") {
      if (outcome === "success") failureCounts.delete(action);
      else if (outcome === "failure") {
        failureCounts.set(action, (failureCounts.get(action) ?? 0) + 1);
      }
      const remaining = (callsInFlight.get(action) ?? 1) - 1;
      if (remaining > 0) callsInFlight.set(action, remaining);
      else callsInFlight.delete(action);
      notifyStateChange(action);
    },
  };
}

function actionAbortReason(signal: AbortSignal) {
  return signal.reason ?? new DOMException("Action execution was aborted.", "AbortError");
}

function isRetrySafeProviderFlake(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("final cost is settling") ||
    normalized.includes("cost is settling") ||
    normalized.includes("still settling")
  );
}
