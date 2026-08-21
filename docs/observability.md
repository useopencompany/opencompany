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

Better Stack/Sentry-compatible DSNs are required for the production web release so uncaught server
renders and browser error-boundary failures reach the error tracker. They remain optional for local
development and runtimes whose release preflight does not require them; missing values disable remote
error reporting there.
SigNoz export requires `OPENCOMPANY_OBSERVABILITY_ENABLED` plus an OTLP endpoint and any required headers.
Latitude full-content LLM tracing requires `LATITUDE_API_KEY` and `LATITUDE_PROJECT_SLUG` and can be
disabled with `LATITUDE_TELEMETRY_DISABLED`.

Treat SigNoz, Latitude, Braintrust, and platform-log access as production-data access. LLM traces may
contain prompts, output, tool arguments, or provider payloads even when ordinary structured logs do
not.

## Chat felt latency

The browser emits `chat_first_output_rendered` to the product PostHog project for foreground Chat
turns. It measures from a valid composer submit action, immediately before transport dispatch,
until React commits the first visible assistant text, reasoning, tool, subagent, task, artifact, or
error. The optimistic working indicator does not stop the timer.

The event includes Conversation, Run, and assistant Message IDs for investigation, plus engine,
resolved model, selected model, new-session/follow-up status, last-known sandbox status at Send,
send source, output kind, and `time_to_first_output_ms`. The sandbox status distinguishes running,
sleeping, deleted, not-yet-created, unknown, and non-sandbox turns. Use
engine/model/new-session/sandbox-status dimensions for percentile dashboards and the IDs only for
individual-turn drilldown. Do not add those IDs to OpenTelemetry histogram dimensions; metrics
intentionally keep low-cardinality attributes.

Background sends are excluded because their first output is not presented in the initiating browser.
Reloaded or reconnected Runs are also excluded because that browser did not observe the original Send
action. A canceled or failed submission that never commits assistant output produces no event.

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

After changing web error capture, invoke the cron-secret-protected
`/internal/observability/server-error` page with a unique
`x-opencompany-observability-probe-id` header and confirm that probe ID appears in Better Stack. The
page must render the not-found boundary without the production cron bearer and must emit no probe
error. With the bearer it fails the React Server Component render; the document request can still be
HTTP 200 after streaming begins, so the Better Stack event is the authoritative result.

Configure the SigNoz MCP connection with [Agent MCP](./agent-mcp.md). Dashboard IDs and observed
tenant state belong in the monitoring system itself rather than this repository because they change
independently of code.
