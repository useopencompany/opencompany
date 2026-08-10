import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoatChatGenerationWatchdog } from "./chat-generation-timeout";

describe("createGoatChatGenerationWatchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts when a model step does not produce its first chunk", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const watchdog = createGoatChatGenerationWatchdog({
      abortSignal: new AbortController().signal,
      firstChunkTimeoutMs: 45_000,
      totalTimeoutMs: 600_000,
      onTimeout,
    });

    watchdog.startStep(3);
    await vi.advanceTimersByTimeAsync(45_000);

    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.timeout).toEqual({ phase: "first_chunk", stepNumber: 3 });
    expect(onTimeout).toHaveBeenCalledWith({ phase: "first_chunk", stepNumber: 3 });
  });

  it("does not count time spent in a tool after the model produces a chunk", async () => {
    vi.useFakeTimers();
    const watchdog = createGoatChatGenerationWatchdog({
      abortSignal: new AbortController().signal,
      firstChunkTimeoutMs: 45_000,
      totalTimeoutMs: 600_000,
    });

    watchdog.startStep(0);
    await vi.advanceTimersByTimeAsync(5_000);
    watchdog.noteChunk();
    await vi.advanceTimersByTimeAsync(125_000);

    expect(watchdog.signal.aborted).toBe(false);
    watchdog.finish();
  });

  it("rearms the first-chunk deadline for later model steps", async () => {
    vi.useFakeTimers();
    const watchdog = createGoatChatGenerationWatchdog({
      abortSignal: new AbortController().signal,
      firstChunkTimeoutMs: 45_000,
      totalTimeoutMs: 600_000,
    });

    watchdog.startStep(0);
    watchdog.noteChunk();
    await vi.advanceTimersByTimeAsync(125_000);
    watchdog.startStep(1);
    await vi.advanceTimersByTimeAsync(45_000);

    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.timeout).toEqual({ phase: "first_chunk", stepNumber: 1 });
  });

  it("caps the total generation time even when steps keep making progress", async () => {
    vi.useFakeTimers();
    const watchdog = createGoatChatGenerationWatchdog({
      abortSignal: new AbortController().signal,
      firstChunkTimeoutMs: 45_000,
      totalTimeoutMs: 600_000,
    });

    for (let stepNumber = 0; stepNumber < 6; stepNumber += 1) {
      watchdog.startStep(stepNumber);
      watchdog.noteChunk();
      await vi.advanceTimersByTimeAsync(100_000);
    }

    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.timeout).toEqual({ phase: "total", stepNumber: 5 });
  });

  it("preserves explicit aborts without classifying them as timeouts", () => {
    vi.useFakeTimers();
    const stopController = new AbortController();
    const watchdog = createGoatChatGenerationWatchdog({
      abortSignal: stopController.signal,
      firstChunkTimeoutMs: 45_000,
      totalTimeoutMs: 600_000,
    });

    watchdog.startStep(0);
    stopController.abort();

    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.timeout).toBeNull();
    watchdog.finish();
  });
});
