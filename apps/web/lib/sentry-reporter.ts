import { type LogFields, setExceptionReporter } from "@opencompany/observability";
import * as Sentry from "@sentry/nextjs";

type SentryEvent = Parameters<NonNullable<Parameters<typeof Sentry.init>[0]["beforeSend"]>>[0];
type SentryBreadcrumb = Parameters<
  NonNullable<Parameters<typeof Sentry.init>[0]["beforeBreadcrumb"]>
>[0];

export function scrubSentryEvent(event: SentryEvent): SentryEvent {
  if (event.request) {
    const { method, url } = event.request;
    event.request = {
      ...(method ? { method } : {}),
      ...(url ? { url: url.split(/[?#]/, 1)[0] } : {}),
    };
  }

  const userId = event.user?.id;
  event.user = {
    ...(userId ? { id: userId } : {}),
    // Better Stack replaces null with the ingest connection IP; an explicit zero address remains
    // anonymous and also prevents Sentry's post-beforeSend {{auto}} inference.
    ip_address: "0.0.0.0",
  };

  return event;
}

export function scrubSentryBreadcrumb(breadcrumb: SentryBreadcrumb): SentryBreadcrumb | null {
  return breadcrumb.category === "console" ? null : breadcrumb;
}

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
