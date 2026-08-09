export const GOAT_CHAT_FIRST_CHUNK_TIMEOUT_MS = 45_000;
export const GOAT_CHAT_STEP_TIMEOUT_MS = 180_000;
export const GOAT_CHAT_TOTAL_TIMEOUT_MS = 10 * 60_000;

export type GoatChatGenerationTimeout = {
  phase: "first_chunk" | "step" | "total";
  stepNumber?: number;
};

type GoatChatGenerationWatchdogInput = {
  abortSignal: AbortSignal;
  firstChunkTimeoutMs?: number;
  totalTimeoutMs?: number;
  onFirstChunk?: (event: { stepNumber: number; durationMs: number }) => void;
  onTimeout?: (timeout: GoatChatGenerationTimeout) => void;
};

/**
 * Adds progress-aware deadlines to a multi-step chat generation.
 *
 * A step's first-chunk timer is cleared as soon as the provider produces model
 * output, before any client-side tool runs. This keeps slow but bounded tools
 * from being mistaken for an unresponsive model.
 */
export function createGoatChatGenerationWatchdog(input: GoatChatGenerationWatchdogInput) {
  const timeoutController = new AbortController();
  const signal = AbortSignal.any([input.abortSignal, timeoutController.signal]);
  const firstChunkTimeoutMs = input.firstChunkTimeoutMs ?? GOAT_CHAT_FIRST_CHUNK_TIMEOUT_MS;
  const totalTimeoutMs = input.totalTimeoutMs ?? GOAT_CHAT_TOTAL_TIMEOUT_MS;
  let firstChunkTimer: ReturnType<typeof setTimeout> | null = null;
  let firstChunkStartedAt = 0;
  let activeStepNumber: number | undefined;
  let timedOut: GoatChatGenerationTimeout | null = null;
  let finished = false;

  const clearFirstChunkTimer = () => {
    if (firstChunkTimer !== null) clearTimeout(firstChunkTimer);
    firstChunkTimer = null;
  };
  const emitTimeout = (timeout: GoatChatGenerationTimeout, abort: boolean) => {
    if (finished || timedOut) return timedOut;
    timedOut = timeout;
    clearFirstChunkTimer();
    clearTimeout(totalTimer);
    input.onTimeout?.(timeout);
    if (abort) {
      timeoutController.abort(
        new DOMException("The chat model stopped responding.", "TimeoutError"),
      );
    }
    return timedOut;
  };
  const totalTimer = setTimeout(
    () =>
      emitTimeout(
        {
          phase: "total",
          ...(activeStepNumber !== undefined ? { stepNumber: activeStepNumber } : {}),
        },
        true,
      ),
    totalTimeoutMs,
  );

  return {
    signal,
    get timeout() {
      return timedOut;
    },
    get activeStepNumber() {
      return activeStepNumber;
    },
    startStep(stepNumber: number) {
      if (finished || timedOut) return;
      clearFirstChunkTimer();
      activeStepNumber = stepNumber;
      firstChunkStartedAt = Date.now();
      firstChunkTimer = setTimeout(
        () => emitTimeout({ phase: "first_chunk", stepNumber }, true),
        firstChunkTimeoutMs,
      );
    },
    noteChunk() {
      if (!firstChunkTimer || activeStepNumber === undefined) return;
      clearFirstChunkTimer();
      input.onFirstChunk?.({
        stepNumber: activeStepNumber,
        durationMs: Math.max(0, Date.now() - firstChunkStartedAt),
      });
    },
    finishStep(stepNumber: number) {
      if (stepNumber !== activeStepNumber) return;
      clearFirstChunkTimer();
    },
    markStepTimeout() {
      return emitTimeout(
        {
          phase: "step",
          ...(activeStepNumber !== undefined ? { stepNumber: activeStepNumber } : {}),
        },
        false,
      );
    },
    finish() {
      if (finished) return;
      finished = true;
      clearFirstChunkTimer();
      clearTimeout(totalTimer);
    },
  };
}
