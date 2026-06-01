import type { PermissionGroup } from "@opencompany/agent-runtime";

export type ToolStartMetadata = {
  toolCallId: string;
  name: string;
  input: unknown;
};

// The verdict the gate attaches when releasing a tool call. "allow" runs the real
// tool body; "deny" makes execute() short-circuit with a permission_denied result.
export type ToolStartVerdict = {
  decision: "allow" | "deny";
  providerKey: string;
  group: PermissionGroup;
  source?: "policy" | "user" | "timeout";
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
  waitForStarted: (toolCallId: string, signal?: AbortSignal) => Promise<ToolStartVerdict>;
};

export function createToolStartCoordinator(): ToolStartCoordinator {
  const metadataByCallId = new Map<string, ToolStartMetadata>();
  const startedCallIds = new Set<string>();
  const verdictByCallId = new Map<string, ToolStartVerdict>();
  const waitersByCallId = new Map<string, Set<(verdict: ToolStartVerdict) => void>>();

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
    waitForStarted(toolCallId, signal) {
      if (startedCallIds.has(toolCallId)) {
        return Promise.resolve(verdictByCallId.get(toolCallId) ?? DEFAULT_VERDICT);
      }
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
