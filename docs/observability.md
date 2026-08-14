# Observability

Web, API, and runner use `@opencompany/observability` for structured logs and handled-error
capture. Canonical product spans and metrics use `@opencompany/telemetry`.

Current service names are:

- `opencompany-goat` for the Next.js presentation runtime;
- `opencompany-api` for authenticated product/API and provider-ingress work;
- `opencompany-runner-goat` for durable execution and background workers.

Do not infer runtime ownership from older span names such as `goat.chat.turn` or physical fields such
as `chat_session_id`. Chat and Task execution is runner-owned even where retained telemetry names
reflect the physical schema. API request spans identify the public command/read boundary; runner Run,
Task, and Brain-ingestion spans identify durable work.

## Configuration

Better Stack/Sentry-compatible DSNs are optional; missing values disable remote error reporting.
SigNoz export requires `OPENCOMPANY_OBSERVABILITY_ENABLED` plus an OTLP endpoint and any required headers.
Latitude full-content LLM tracing requires `LATITUDE_API_KEY` and `LATITUDE_PROJECT_SLUG` and can be
disabled with `LATITUDE_TELEMETRY_DISABLED`.

Treat SigNoz, Latitude, Braintrust, and platform-log access as production-data access. LLM traces may
contain prompts, output, tool arguments, or provider payloads even when ordinary structured logs do
not.

## Logging contract

Logs may contain internal IDs, coarse status, duration, count, route name, release, environment,
provider/model name, and sandbox ID. Do not log prompts, Messages, model output, command bodies or
output, file contents, credentials, emails, provider payloads, or URLs with sensitive query strings.

Use semantic `Conversation`, `Message`, `Run`, `Attempt`, and `Event` IDs when a current contract
provides them. Physical storage IDs may remain useful for repository investigation but must not be
presented as a public protocol.

## Investigation

1. Confirm web, API, and runner `/healthz` endpoints report the expected release.
2. Locate the API request using its request ID, route, Actor-safe context, and status.
3. Follow the returned Run ID into runner spans and durable Events. Check Attempt number, lease loss,
   cancellation, provider errors, and terminal settlement.
4. Query Postgres only through an authorized operational path and only for the relevant IDs. Do not
   paste raw production rows or provider payloads into an issue.
5. If transient delivery failed but the Run is durable, reconnect from the last semantic Event ID;
   do not redispatch the command.

Configure the SigNoz MCP connection with [Agent MCP](./agent-mcp.md). Dashboard IDs and observed
tenant state belong in the monitoring system itself rather than this repository because they change
independently of code.
