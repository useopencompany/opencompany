export type WorkerStopOptions = {
  signal?: AbortSignal;
};

export type PollingWorkerContext = {
  signal: AbortSignal;
  stopping: () => boolean;
};

export function createPollingWorker(input: {
  pollIntervalMs: number;
  poll: (context: PollingWorkerContext) => Promise<boolean | void>;
  onError: (error: unknown) => void;
  drain?: (signal: AbortSignal) => Promise<void>;
}) {
  const workAbort = new AbortController();
  let stopping = false;
  let pendingWake = true;
  let wake: (() => void) | null = null;
  let polling = false;
  let stopPromise: Promise<void> | null = null;

  const notify = () => {
    if (wake) wake();
    else pendingWake = true;
  };

  const waitForPollOrWake = () => {
    if (pendingWake) {
      pendingWake = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, input.pollIntervalMs);
      timer.unref?.();
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  };

  const context: PollingWorkerContext = {
    signal: workAbort.signal,
    stopping: () => stopping,
  };
  const loop = (async () => {
    while (!stopping) {
      await waitForPollOrWake();
      if (stopping) break;
      let repollImmediately = false;
      polling = true;
      try {
        repollImmediately = (await input.poll(context)) === true;
      } catch (error) {
        if (!workAbort.signal.aborted) input.onError(error);
      } finally {
        polling = false;
      }
      if (repollImmediately) pendingWake = true;
    }
  })();

  return {
    notify,
    activeCount: () => (polling ? 1 : 0),
    stop: (options: WorkerStopOptions = {}) => {
      if (stopPromise) return stopPromise;
      stopping = true;
      notify();
      const abortWork = () => workAbort.abort(options.signal?.reason);
      if (options.signal?.aborted) abortWork();
      else options.signal?.addEventListener("abort", abortWork, { once: true });
      stopPromise = (async () => {
        try {
          await loop;
          await input.drain?.(workAbort.signal);
        } finally {
          options.signal?.removeEventListener("abort", abortWork);
        }
      })();
      return stopPromise;
    },
  };
}
