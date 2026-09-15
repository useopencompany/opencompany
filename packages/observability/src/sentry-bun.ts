import * as Sentry from "@sentry/bun";
import { createLogger, isObservabilityEnabled, type LogFields, setExceptionReporter } from ".";

const logger = createLogger({ service: "opencompany-observability", runtime: "bun" });

export type BunExceptionReporterInput = {
  /** Reported as the Sentry `server_name` and a `service` tag so one Better Stack application can be filtered per runtime. */
  serviceName: string;
  dsn?: string | undefined;
  environment?: string | undefined;
  release?: string | undefined;
};

/**
 * Routes `captureException` from `@opencompany/observability` to Better Stack through the
 * Sentry-compatible Bun SDK. Without a DSN the package keeps its local structured-log fallback,
 * which only reaches platform logs; that silent mode is logged once at boot so it is visible.
 */
export function installBunExceptionReporter(input: BunExceptionReporterInput): boolean {
  if (!isObservabilityEnabled()) return false;

  const dsn = (input.dsn ?? process.env.BETTER_STACK_ERRORS_DSN)?.trim();
  if (!dsn) {
    logger.warn("Remote error reporting is disabled because BETTER_STACK_ERRORS_DSN is not set", {
      event: "opencompany.error_reporting_disabled",
      service: input.serviceName,
    });
    return false;
  }

  Sentry.init({
    dsn,
    environment:
      input.environment ?? process.env.OBSERVABILITY_ENV ?? process.env.NODE_ENV ?? "development",
    release:
      input.release ??
      process.env.OBSERVABILITY_RELEASE ??
      process.env.RENDER_GIT_COMMIT ??
      process.env.VERCEL_GIT_COMMIT_SHA,
    serverName: input.serviceName,
    initialScope: { tags: { service: input.serviceName } },
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });

  setExceptionReporter({
    captureException(error, fields) {
      Sentry.withScope((scope) => {
        applyFields(scope, fields);
        Sentry.captureException(error);
      });
    },
    flush() {
      return Sentry.flush(2_000);
    },
  });
  return true;
}

function applyFields(scope: Sentry.Scope, fields: LogFields) {
  if (typeof fields.user_id === "string" && fields.user_id) {
    scope.setUser({ id: fields.user_id });
  }
  scope.setContext("opencompany", fields);
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      scope.setTag(key, String(value));
    }
  }
}
