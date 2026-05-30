import "./load-env";
import {
  flushObservability,
  isObservabilityEnabled,
  setExceptionReporter,
} from "@opencompany/observability";
import { flushBraintrust } from "@opencompany/observability/braintrust";
import * as Sentry from "@sentry/bun";
import { assertRunnerDbConfig, closeDb } from "./db";
import { loadEnv } from "./env";
import { startRunnerJobWorker } from "./jobs";
import { createServer } from "./server";

initializeExceptionReporting();

const env = loadEnv();
assertRunnerDbConfig();
const server = createServer(env);
const jobWorker = startRunnerJobWorker(env);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // Stop accepting work and drain in-flight jobs/requests first, then close the
    // DB pool so no checked-out connection is cut mid-query, then flush telemetry.
    void Promise.allSettled([jobWorker.stop(), server.close()])
      .then(() => Promise.allSettled([closeDb()]))
      .then(() => Promise.allSettled([flushObservability(), flushBraintrust()]))
      .finally(() => process.exit(0));
  });
}

await server.listen({ host: "0.0.0.0", port: env.port });

function initializeExceptionReporting() {
  const dsn = process.env.BETTER_STACK_ERRORS_DSN?.trim();
  if (!isObservabilityEnabled() || !dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.OBSERVABILITY_ENV ?? process.env.NODE_ENV ?? "development",
    release:
      process.env.OBSERVABILITY_RELEASE ??
      process.env.RENDER_GIT_COMMIT ??
      process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
  });

  setExceptionReporter({
    captureException(error, fields) {
      Sentry.withScope((scope) => {
        if (typeof fields.user_id === "string" && fields.user_id) {
          scope.setUser({ id: fields.user_id });
        }
        scope.setContext("opencompany", fields);
        for (const [key, value] of Object.entries(fields)) {
          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            scope.setTag(key, String(value));
          }
        }
        Sentry.captureException(error);
      });
    },
    flush() {
      return Sentry.flush();
    },
  });
}
