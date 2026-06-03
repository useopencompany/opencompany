import type { DenialSource, PermissionGroup } from "@opencompany/agent-runtime";

export type ToolStartMetadata = {
  toolCallId: string;
  name: string;
  input: unknown;
};

// The verdict the gate attaches when releasing a tool call. "allow" runs the real
// tool body; "deny" makes execute() short-circuit with a permission_denied result;
// "suspend" makes execute() return a discarded no-op (no body, no persisted result)
// because the run is being torn down to wait for an approval decision.
export type ToolStartVerdict = {
  decision: "allow" | "deny" | "suspend";
  providerKey: string;
  group: PermissionGroup;
  source?: DenialSource;
};

const DEFAULT_VERDICT: ToolStartVerdict = {
  decision: "allow",
  providerKey: "system",
  group: "read",
};

export type ToolStartCoordinator = {
  record: (metadata: ToolStartMetadata) => void;
  read: (toolCallId: string) => ToolStartMetadata | undefined;
  markStarted: (toolCallId: string, verdict?: ToolStartVerdict) => void;
  // Release every parked (and future) tool call with a "suspend" verdict so their
  // execute() callbacks return a discarded no-op. Called when the run unwinds at an
  // "ask" gate: sibling tool calls of the same step that haven't been released yet must
  // not hang awaiting a decision that won't come from this run.
  suspend: () => void;
  waitForStarted: (toolCallId: string, signal?: AbortSignal) => Promise<ToolStartVerdict>;
};

const SUSPEND_VERDICT: ToolStartVerdict = {
  decision: "suspend",
  providerKey: "system",
  group: "read",
};

export function createToolStartCoordinator(): ToolStartCoordinator {
  const metadataByCallId = new Map<string, ToolStartMetadata>();
  const startedCallIds = new Set<string>();
  const verdictByCallId = new Map<string, ToolStartVerdict>();
  const waitersByCallId = new Map<string, Set<(verdict: ToolStartVerdict) => void>>();
  let suspended = false;

  return {
    record(metadata) {
      metadataByCallId.set(metadata.toolCallId, metadata);
    },
    read(toolCallId) {
      return metadataByCallId.get(toolCallId);
    },
    markStarted(toolCallId, verdict = DEFAULT_VERDICT) {
      if (startedCallIds.has(toolCallId)) return;
      startedCallIds.add(toolCallId);
      verdictByCallId.set(toolCallId, verdict);
      const waiters = waitersByCallId.get(toolCallId);
      if (!waiters) return;
      waitersByCallId.delete(toolCallId);
      for (const resolve of waiters) resolve(verdict);
    },
    suspend() {
      if (suspended) return;
      suspended = true;
      for (const [toolCallId, waiters] of waitersByCallId) {
        verdictByCallId.set(toolCallId, SUSPEND_VERDICT);
        startedCallIds.add(toolCallId);
        for (const resolve of waiters) resolve(SUSPEND_VERDICT);
      }
      waitersByCallId.clear();
    },
    waitForStarted(toolCallId, signal) {
      if (startedCallIds.has(toolCallId)) {
        return Promise.resolve(verdictByCallId.get(toolCallId) ?? DEFAULT_VERDICT);
      }
      // A call whose execute() parks after suspend() was already called (a sibling whose
      // input streamed in late) must also resolve to the no-op suspend verdict.
      if (suspended) return Promise.resolve(SUSPEND_VERDICT);
      if (signal?.aborted) return Promise.reject(new Error("Run aborted."));

      return new Promise<ToolStartVerdict>((resolve, reject) => {
        const waiters =
          waitersByCallId.get(toolCallId) ?? new Set<(verdict: ToolStartVerdict) => void>();
        waitersByCallId.set(toolCallId, waiters);

        const cleanup = () => {
          waiters.delete(resolveStarted);
          if (waiters.size === 0) waitersByCallId.delete(toolCallId);
          signal?.removeEventListener("abort", abort);
        };
        const resolveStarted = (verdict: ToolStartVerdict) => {
          cleanup();
          resolve(verdict);
        };
        const abort = () => {
          cleanup();
          reject(new Error("Run aborted."));
        };

        waiters.add(resolveStarted);
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
}
