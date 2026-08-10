# Observability

Goat and the runner use `@opencompany/observability` for structured logs and handled-error capture.
Better Stack/Sentry-compatible DSNs are optional; missing values disable remote reporting safely.

Goat-specific run outcomes and traces use `@opencompany/goat-observability`. SigNoz export requires
`GOAT_OBSERVABILITY_ENABLED` and an OTLP endpoint. Latitude full-content LLM tracing requires both
`LATITUDE_API_KEY` and `LATITUDE_PROJECT_SLUG` and can be disabled with
`LATITUDE_TELEMETRY_DISABLED`. Treat Latitude and Braintrust access as production-data access because
their traces may contain prompts, model output, and tool payloads.

Logs may contain internal IDs, coarse statuses, durations, counts, route names, release, environment,
provider/model names, and sandbox IDs. Do not log prompts, model output, command bodies/output, file
contents, credentials, emails, or URLs with sensitive query strings.

Hosted releases derive commit attribution from Vercel/Render metadata and verify the release through
Goat and runner health checks. Use `OBSERVABILITY_RELEASE` only for manual/non-Git deploys.

Detailed Goat SigNoz events, dashboards, and alerts are documented in
[signoz-goat-observability.md](./signoz-goat-observability.md).
