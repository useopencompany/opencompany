import {
  createLogger,
  endTimingTrace as endSharedTimingTrace,
  type LogFields,
  startTimingTrace as startSharedTimingTrace,
  type TimingTrace,
  timeAsync,
} from "@opencompany/observability";

export { type TimingTrace, timeAsync };

const timingLogger = createLogger({ service: "opencompany-web", runtime: "server" });

export function startTimingTrace(name: string, metadata?: LogFields): TimingTrace {
  return startSharedTimingTrace(name, metadata, { logger: timingLogger });
}

export function endTimingTrace(trace: TimingTrace | undefined, metadata?: LogFields) {
  endSharedTimingTrace(trace, metadata);
}
