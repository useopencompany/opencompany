import { describe, expect, it, vi } from "vitest";
import { createPollingWorker } from "./polling-worker";

describe("createPollingWorker", () => {
  it("preserves an early wake and stops claiming before drain", async () => {
    vi.useFakeTimers();
    const polls: AbortSignal[] = [];
    const worker = createPollingWorker({
      pollIntervalMs: 10_000,
      poll: async ({ signal }) => {
        polls.push(signal);
      },
      onError: vi.fn(),
    });

    await vi.waitFor(() => expect(polls).toHaveLength(1));
    worker.notify();
    await vi.waitFor(() => expect(polls).toHaveLength(2));
    await worker.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(polls).toHaveLength(2);
    vi.useRealTimers();
  });

  it("aborts in-flight work only when the shutdown deadline signal fires", async () => {
    const shutdown = new AbortController();
    const state: { workSignal?: AbortSignal; finishPoll?: () => void } = {};
    const worker = createPollingWorker({
      pollIntervalMs: 10_000,
      poll: ({ signal }) => {
        state.workSignal = signal;
        return new Promise<void>((resolve) => {
          state.finishPoll = resolve;
        });
      },
      onError: vi.fn(),
    });
    await vi.waitFor(() => expect(state.workSignal).toBeDefined());

    const stopped = worker.stop({ signal: shutdown.signal });
    expect(state.workSignal?.aborted).toBe(false);
    shutdown.abort(new Error("drain deadline exceeded"));
    expect(state.workSignal?.aborted).toBe(true);
    state.finishPoll?.();
    await stopped;
  });
});
