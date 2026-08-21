import { createLogger } from "@opencompany/observability";
import { registerNextObservability } from "@opencompany/telemetry/next";
import * as Sentry from "@sentry/nextjs";
import type { Instrumentation } from "next";

const logger = createLogger({ service: "opencompany-web", runtime: "nextjs" });
const PROBE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u;

export async function register() {
  registerNextObservability({ serviceName: "opencompany-goat" });

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const digest = errorDigest(error);
  const probeId = safeProbeId(request.headers["x-opencompany-observability-probe-id"]);

  logger.error("Next.js request failed", {
    event: "opencompany.web_request_failed",
    method: request.method,
    route_path: context.routePath,
    route_type: context.routeType,
    router_kind: context.routerKind,
    render_source: context.renderSource,
    revalidate_reason: context.revalidateReason,
    error_name: error instanceof Error ? error.name : "Error",
    error_message: error instanceof Error ? error.message : String(error),
    error_digest: digest,
    observability_probe_id: probeId,
  });

  Sentry.withScope((scope) => {
    scope.setTag("event", "opencompany.web_request_failed");
    scope.setTag("nextjs.route_path", context.routePath);
    scope.setTag("nextjs.route_type", context.routeType);
    scope.setTag("nextjs.router_kind", context.routerKind);
    if (context.renderSource) scope.setTag("nextjs.render_source", context.renderSource);
    if (digest) scope.setContext("nextjs_error", { digest });
    if (probeId) scope.setTag("observability_probe_id", probeId);
    Sentry.captureRequestError(error, request, context);
  });

  await Sentry.flush(2_000);
};

function errorDigest(error: unknown) {
  if (!error || typeof error !== "object" || !("digest" in error)) return undefined;
  const digest = error.digest;
  return typeof digest === "string" ? digest.slice(0, 128) : undefined;
}

function safeProbeId(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && PROBE_ID_PATTERN.test(candidate) ? candidate : undefined;
}
