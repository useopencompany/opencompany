import { isObservabilityEnabled } from "@opencompany/observability";
import * as Sentry from "@sentry/nextjs";
import { installSentryExceptionReporter } from "@/lib/sentry-reporter";

const dsn = process.env.NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN?.trim();

if (isObservabilityEnabled() && dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_OBSERVABILITY_ENV ?? "development",
    release: process.env.NEXT_PUBLIC_OBSERVABILITY_RELEASE,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
  installSentryExceptionReporter();
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
