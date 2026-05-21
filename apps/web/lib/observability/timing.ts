type TimingMetadata = Record<string, string | number | boolean | null | undefined>;

export type TimingTrace = {
  id: string;
  name: string;
  startedAt: number;
  enabled: boolean;
  metadata?: TimingMetadata;
};

export function startTimingTrace(name: string, metadata?: TimingMetadata): TimingTrace {
  const trace: TimingTrace = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    startedAt: performance.now(),
    enabled: process.env.OPENCOMPANY_TIMING === "1",
    ...(metadata ? { metadata } : {}),
  };

  if (trace.enabled) {
    logTiming("start", trace, 0, metadata);
  }

  return trace;
}

export async function timeAsync<T>(
  trace: TimingTrace | undefined,
  step: string,
  run: () => Promise<T>,
  metadata?: TimingMetadata,
): Promise<T> {
  if (!trace?.enabled) return run();

  const startedAt = performance.now();
  try {
    const result = await run();
    logTiming(step, trace, performance.now() - startedAt, metadata);
    return result;
  } catch (error) {
    logTiming(step, trace, performance.now() - startedAt, {
      ...metadata,
      error: error instanceof Error ? error.message : "unknown error",
    });
    throw error;
  }
}

export function endTimingTrace(trace: TimingTrace | undefined, metadata?: TimingMetadata) {
  if (!trace?.enabled) return;
  logTiming("total", trace, performance.now() - trace.startedAt, metadata);
}

function logTiming(
  step: string,
  trace: TimingTrace,
  durationMs: number,
  metadata?: TimingMetadata,
) {
  const fields = {
    event: "opencompany.timing",
    traceId: trace.id,
    trace: trace.name,
    step,
    durationMs: Math.round(durationMs),
    ...cleanMetadata(trace.metadata),
    ...cleanMetadata(metadata),
  };

  console.info(JSON.stringify(fields));
}

function cleanMetadata(metadata?: TimingMetadata) {
  if (!metadata) return {};

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}
