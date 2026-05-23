import { initClientAnalytics } from "@opencompany/analytics/client";
import { isObservabilityEnabled, setExceptionReporter } from "@opencompany/observability";
import * as Sentry from "@sentry/nextjs";

initClientAnalytics();

const dsn = process.env.NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN?.trim();

if (isObservabilityEnabled() && dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_OBSERVABILITY_ENV ?? process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_OBSERVABILITY_RELEASE,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
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
