import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import {
  isObservabilityEnabled,
  OBSERVABILITY_SERVICE_NAME,
  OTEL_METRIC_EXPORT_INTERVAL_MS,
  OTEL_TRACE_SAMPLE_RATE,
} from ".";

let sdk: NodeSDK | null = null;

export function registerNodeObservability(input: { serviceName?: string } = {}) {
  if (sdk || !isObservabilityEnabled()) return null;
  const endpoint = process.env.OPENCOMPANY_OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return null;

  const headers = parseOtlpHeaders(process.env.OPENCOMPANY_OTEL_EXPORTER_OTLP_HEADERS);
  const traceExporter = new OTLPTraceExporter({
    url: tracesEndpoint(endpoint),
    ...(headers ? { headers } : {}),
  });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: metricsEndpoint(endpoint),
      ...(headers ? { headers } : {}),
    }),
    exportIntervalMillis: OTEL_METRIC_EXPORT_INTERVAL_MS,
  });

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: input.serviceName ?? OBSERVABILITY_SERVICE_NAME,
      ...(readRelease() ? { [ATTR_SERVICE_VERSION]: readRelease() } : {}),
    }),
    traceExporter,
    metricReader,
    sampler: new TraceIdRatioBasedSampler(OTEL_TRACE_SAMPLE_RATE),
  });
  sdk.start();
  return sdk;
}

export async function shutdownNodeObservability() {
  if (!sdk) return;
  const active = sdk;
  sdk = null;
  await active.shutdown();
}

export function parseOtlpHeaders(value: string | undefined): Record<string, string> | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const headers: Record<string, string> = {};
  for (const item of raw.split(",")) {
    const index = item.indexOf("=");
    if (index <= 0) continue;
    const key = item.slice(0, index).trim();
    const headerValue = item.slice(index + 1).trim();
    if (key && headerValue) headers[key] = headerValue;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function tracesEndpoint(endpoint: string) {
  return endpoint.replace(/\/+$/, "").endsWith("/v1/traces")
    ? endpoint.replace(/\/+$/, "")
    : `${endpoint.replace(/\/+$/, "")}/v1/traces`;
}

function metricsEndpoint(endpoint: string) {
  return endpoint.replace(/\/+$/, "").endsWith("/v1/metrics")
    ? endpoint.replace(/\/+$/, "")
    : `${endpoint.replace(/\/+$/, "")}/v1/metrics`;
}

function readRelease() {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.RENDER_GIT_COMMIT ??
    process.env.OBSERVABILITY_RELEASE ??
    undefined
  );
}
