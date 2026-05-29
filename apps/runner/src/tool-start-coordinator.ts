export type ToolStartMetadata = {
  toolCallId: string;
  name: string;
  input: unknown;
};

export type ToolStartCoordinator = {
  record: (metadata: ToolStartMetadata) => void;
  read: (toolCallId: string) => ToolStartMetadata | undefined;
  markStarted: (toolCallId: string) => void;
  waitForStarted: (toolCallId: string, signal?: AbortSignal) => Promise<void>;
};

export function createToolStartCoordinator(): ToolStartCoordinator {
  const metadataByCallId = new Map<string, ToolStartMetadata>();
  const startedCallIds = new Set<string>();
  const waitersByCallId = new Map<string, Set<() => void>>();

  return {
    record(metadata) {
      metadataByCallId.set(metadata.toolCallId, metadata);
    },
    read(toolCallId) {
      return metadataByCallId.get(toolCallId);
    },
    markStarted(toolCallId) {
      if (startedCallIds.has(toolCallId)) return;
      startedCallIds.add(toolCallId);
      const waiters = waitersByCallId.get(toolCallId);
      if (!waiters) return;
      waitersByCallId.delete(toolCallId);
      for (const resolve of waiters) resolve();
    },
    waitForStarted(toolCallId, signal) {
      if (startedCallIds.has(toolCallId)) return Promise.resolve();
      if (signal?.aborted) return Promise.reject(new Error("Run aborted."));

      return new Promise<void>((resolve, reject) => {
        const waiters = waitersByCallId.get(toolCallId) ?? new Set<() => void>();
        waitersByCallId.set(toolCallId, waiters);

        const cleanup = () => {
          waiters.delete(resolveStarted);
          if (waiters.size === 0) waitersByCallId.delete(toolCallId);
          signal?.removeEventListener("abort", abort);
        };
        const resolveStarted = () => {
          cleanup();
          resolve();
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
