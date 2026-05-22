import { isObservabilityEnabled, setExceptionReporter } from "@opencompany/observability";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const dsn =
    process.env.BETTER_STACK_ERRORS_DSN?.trim() ||
    process.env.NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN?.trim();
  if (!isObservabilityEnabled() || !dsn) return;

  const Sentry = await import("@sentry/nextjs");
  Sentry.init({
    dsn,
    environment: process.env.OBSERVABILITY_ENV ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    release:
      process.env.OBSERVABILITY_RELEASE ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.RENDER_GIT_COMMIT,
    tracesSampleRate: 0,
  });

  setExceptionReporter({
    captureException(error, fields) {
      Sentry.withScope((scope) => {
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
