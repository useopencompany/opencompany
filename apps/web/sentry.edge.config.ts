import { isObservabilityEnabled } from "@opencompany/observability";
import * as Sentry from "@sentry/nextjs";
import { installSentryExceptionReporter } from "@/lib/sentry-reporter";

const dsn = process.env.BETTER_STACK_ERRORS_DSN?.trim();

if (isObservabilityEnabled() && dsn) {
  Sentry.init({
    dsn,
    environment: process.env.OBSERVABILITY_ENV ?? process.env.VERCEL_ENV ?? "development",
    release:
      process.env.OBSERVABILITY_RELEASE ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.RELEASE_SHA,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
  installSentryExceptionReporter();
}
