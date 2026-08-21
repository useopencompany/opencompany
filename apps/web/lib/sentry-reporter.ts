import { type LogFields, setExceptionReporter } from "@opencompany/observability";
import * as Sentry from "@sentry/nextjs";

export function installSentryExceptionReporter() {
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
