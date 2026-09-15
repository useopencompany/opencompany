import * as Sentry from "@sentry/bun";
import {
  createLogger,
  errorToLogFields,
  isObservabilityEnabled,
  type LogFields,
  setExceptionReporter,
} from ".";

const logger = createLogger({ service: "opencompany-observability", runtime: "bun" });
const SENTRY_PROCESS_ERROR_INTEGRATIONS = new Set(["OnUncaughtException", "OnUnhandledRejection"]);

export type BunExceptionReporterInput = {
  /** Reported as the Sentry `server_name` and a `service` tag so one Better Stack application can be filtered per runtime. */
  serviceName: string;
  dsn?: string | undefined;
  environment?: string | undefined;
  release?: string | undefined;
  /** Disable Sentry's global process handlers when the service owns reporting and exit behavior. */
  applicationOwnsProcessErrors?: boolean | undefined;
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
    beforeSend(event, hint) {
      return sanitizeErrorEvent(event, hint.originalException);
    },
    ...(input.applicationOwnsProcessErrors
      ? {
          integrations: (integrations) =>
            integrations.filter(
              (integration) => !SENTRY_PROCESS_ERROR_INTEGRATIONS.has(integration.name),
            ),
        }
      : {}),
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

function sanitizeErrorEvent(event: Sentry.ErrorEvent, error: unknown): Sentry.ErrorEvent {
  if (error === undefined) return event;

  const serialized = errorToLogFields(error).error;
  const errorContext = isRecord(serialized)
    ? serialized
    : { value: serialized === undefined ? "Unknown error" : serialized };
  const message =
    typeof errorContext.message === "string"
      ? errorContext.message
      : typeof errorContext.value === "string"
        ? errorContext.value
        : "Captured exception";
  const type = typeof errorContext.name === "string" ? errorContext.name : "Error";
  const sourceException = event.exception?.values?.find((value) => value.stacktrace);
  const stacktrace = sourceException?.stacktrace
    ? {
        ...sourceException.stacktrace,
        frames: (sourceException.stacktrace.frames ?? []).map(({ vars: _vars, ...frame }) => frame),
      }
    : undefined;

  // Sentry's linked-errors and object serializers can copy raw causes, SQL, and bound parameters
  // into exception chains or `extra`. Replace those fields with the repository's safe projection.
  const { extra: _extra, message: _rawMessage, ...safeEvent } = event;
  return {
    ...safeEvent,
    exception: {
      values: [
        {
          type,
          value: message,
          ...(stacktrace ? { stacktrace } : {}),
          ...(sourceException?.mechanism ? { mechanism: sourceException.mechanism } : {}),
        },
      ],
    },
    contexts: {
      ...event.contexts,
      opencompany_error: errorContext,
    },
  };
}

function isRecord(value: unknown): value is LogFields {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
