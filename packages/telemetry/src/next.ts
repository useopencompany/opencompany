import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { OTLPHttpJsonTraceExporter, registerOTel } from "@vercel/otel";
import {
  isObservabilityEnabled,
  OBSERVABILITY_SERVICE_NAME,
  OTEL_METRIC_EXPORT_INTERVAL_MS,
} from ".";
import { parseOtlpHeaders } from "./node";

let registered = false;

export function registerNextObservability(input: { serviceName?: string } = {}) {
  if (registered || !isObservabilityEnabled()) return;
  const endpoint = process.env.GOAT_OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return;
  registered = true;

  const serviceName = input.serviceName ?? OBSERVABILITY_SERVICE_NAME;
  const headers = parseOtlpHeaders(process.env.GOAT_OTEL_EXPORTER_OTLP_HEADERS);
  registerOTel({
    serviceName,
    traceExporter: new OTLPHttpJsonTraceExporter({
      url: `${endpoint.replace(/\/+$/, "")}/v1/traces`,
      ...(headers ? { headers } : {}),
    }),
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${endpoint.replace(/\/+$/, "")}/v1/metrics`,
      ...(headers ? { headers } : {}),
    }),
    exportIntervalMillis: OTEL_METRIC_EXPORT_INTERVAL_MS,
  });
  metrics.setGlobalMeterProvider(
    new MeterProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        ...(readRelease() ? { [ATTR_SERVICE_VERSION]: readRelease() } : {}),
      }),
      readers: [metricReader],
    }),
  );
}

function readRelease() {
  return process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.OBSERVABILITY_RELEASE ?? undefined;
}
