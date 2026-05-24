import {
  captureException,
  createLogger,
  isObservabilityEnabled,
  setExceptionReporter,
} from "@opencompany/observability";
import type { Instrumentation } from "next";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const requestId =
    readHeader(request.headers, "x-vercel-id") ?? readHeader(request.headers, "x-request-id");

  captureException(error, {
    event: "opencompany.next_request_error",
    next_route_path: context.routePath,
    next_route_type: context.routeType,
    next_router_kind: context.routerKind,
    next_render_source: context.renderSource,
    next_revalidate_reason: context.revalidateReason,
    request_path: request.path,
    request_method: request.method,
    request_id: requestId,
  });
};

export async function register() {
  const nextRuntime = process.env.NEXT_RUNTIME ?? "unknown";
  const serverDsn = process.env.BETTER_STACK_ERRORS_DSN?.trim();
  const publicDsn = process.env.NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN?.trim();
  const hasServerDsn = Boolean(serverDsn);
  const hasPublicDsn = Boolean(publicDsn);

  if (process.env.NEXT_RUNTIME !== "nodejs") {
    logReporterSkipped("non_node_runtime", {
      next_runtime: nextRuntime,
      has_server_dsn: hasServerDsn,
      has_public_dsn: hasPublicDsn,
    });
    return;
  }

  if (!isObservabilityEnabled()) {
    logReporterSkipped("observability_disabled", {
      next_runtime: nextRuntime,
      has_server_dsn: hasServerDsn,
      has_public_dsn: hasPublicDsn,
    });
    return;
  }

  const dsn = serverDsn || publicDsn;
  if (!dsn) {
    logReporterSkipped("missing_dsn", {
      next_runtime: nextRuntime,
      has_server_dsn: hasServerDsn,
      has_public_dsn: hasPublicDsn,
    });
    return;
  }

  const Sentry = await import("@sentry/nextjs");
  Sentry.init({
    dsn,
    environment: process.env.OBSERVABILITY_ENV ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    release:
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.RELEASE_SHA ??
      process.env.GITHUB_SHA ??
      process.env.OBSERVABILITY_RELEASE,
    tracesSampleRate: 0,
  });

  setExceptionReporter({
    captureException(error, fields) {
      Sentry.withScope((scope) => {
        setScopeUser(scope, fields);
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
  logger.info("Registered server observability reporter", {
    event: "opencompany.observability_reporter_registered",
    next_runtime: nextRuntime,
    has_server_dsn: hasServerDsn,
    has_public_dsn: hasPublicDsn,
  });
}

function logReporterSkipped(
  reason: "non_node_runtime" | "observability_disabled" | "missing_dsn",
  fields: {
    next_runtime: string;
    has_server_dsn: boolean;
    has_public_dsn: boolean;
  },
) {
  logger.info("Skipped server observability reporter registration", {
    event: "opencompany.observability_reporter_skipped",
    reason,
    ...fields,
  });
}

function setScopeUser(
  scope: { setUser(user: { id: string } | null): void },
  fields: Record<string, unknown>,
) {
  if (typeof fields.user_id === "string" && fields.user_id) {
    scope.setUser({ id: fields.user_id });
  }
}

function readHeader(headers: NodeJS.Dict<string | string[]>, name: string) {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}
