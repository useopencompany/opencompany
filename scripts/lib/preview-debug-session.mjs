import { previewNames } from "./preview-config.mjs";

const DEFAULT_SOURCE_NAME = "opencompany-runner-preview";
const EVENT_TYPES = [
  "session.status",
  "session.error",
  "session.incomplete",
  "session.archived",
  "tool.failed",
  "tool.approval_required",
  "tool.approval_resolved",
  "question.requested",
  "question.answered",
];

export function parsePreviewDebugArgs(argv, env = process.env) {
  const args = { sourceName: env.BETTER_STACK_PREVIEW_SOURCE_NAME || DEFAULT_SOURCE_NAME };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--pr") {
      args.pr = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--session") {
      args.sessionId = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--source-name") {
      args.sourceName = readValue(argv, ++index, token);
      continue;
    }
    if (token.startsWith("--pr=")) {
      args.pr = token.slice("--pr=".length);
      continue;
    }
    if (token.startsWith("--session=")) {
      args.sessionId = token.slice("--session=".length);
      continue;
    }
    if (token.startsWith("--source-name=")) {
      args.sourceName = token.slice("--source-name=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (args.help) return args;

  args.prNumber = parsePrNumber(args.pr);
  args.sessionId = parseSessionId(args.sessionId);
  args.databaseUrl = env.PREVIEW_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (!args.databaseUrl) {
    throw new Error("PREVIEW_DATABASE_URL or DATABASE_URL is required.");
  }

  return args;
}

export function usage() {
  return [
    "Usage: bun run preview:debug-session -- --pr <number> --session <session_id>",
    "",
    "Required env:",
    "  PREVIEW_DATABASE_URL or DATABASE_URL  Preview Neon connection string.",
    "",
    "Optional:",
    "  BETTER_STACK_PREVIEW_SOURCE_NAME     Defaults to opencompany-runner-preview.",
  ].join("\n");
}

export function buildPreviewDebugSql() {
  return {
    session: `
      SELECT
        id,
        workspace_id,
        user_id,
        agent_id,
        title,
        status,
        source,
        model_provider,
        model_name,
        parent_session_id,
        parent_message_id,
        parent_tool_call_id,
        e2b_sandbox_id,
        workdir,
        run_lease_id,
        run_lease_owner,
        run_lease_message_id,
        run_lease_expires_at,
        run_heartbeat_at,
        abort_requested_at,
        last_error,
        archived_at,
        sandbox_terminated_at,
        last_turn_finished_at,
        created_at,
        updated_at
      FROM agent_sessions
      WHERE id = $1
      LIMIT 1
    `,
    jobs: `
      SELECT
        id,
        kind,
        status,
        attempts,
        message_id,
        next_run_at,
        lease_id,
        lease_owner,
        lease_expires_at,
        last_error,
        created_at,
        updated_at
      FROM agent_session_run_jobs
      WHERE session_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT 50
    `,
    messages: `
      SELECT
        id,
        role,
        status,
        internal,
        char_length(content) AS content_length,
        tool_name,
        tool_call_id,
        response_to_message_id,
        created_at,
        completed_at
      FROM agent_session_messages
      WHERE session_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT 100
    `,
    events: `
      SELECT id, message_id, type, payload, created_at
      FROM agent_session_events
      WHERE session_id = $1
        AND (
          type = ANY($2::text[])
          OR type LIKE 'session.%'
        )
      ORDER BY id ASC
      LIMIT 200
    `,
    latestDebugModelRequest: `
      SELECT id, message_id, created_at
      FROM agent_session_events
      WHERE session_id = $1
        AND type = 'debug.model_request'
      ORDER BY id DESC
      LIMIT 1
    `,
    approvals: `
      SELECT
        id,
        message_id,
        tool_call_id,
        tool_name,
        provider_key,
        permission_group,
        status,
        decision_source,
        requested_at,
        decided_at,
        created_at,
        updated_at
      FROM agent_tool_approvals
      WHERE session_id = $1
      ORDER BY requested_at ASC, id ASC
      LIMIT 50
    `,
    questions: `
      SELECT
        id,
        message_id,
        tool_call_id,
        status,
        resolution_source,
        requested_at,
        answered_at,
        created_at,
        updated_at
      FROM agent_session_questions
      WHERE session_id = $1
      ORDER BY requested_at ASC, id ASC
      LIMIT 50
    `,
    usage: `
      SELECT
        COUNT(*)::int AS model_steps,
        COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::int AS output_tokens,
        COALESCE(SUM(total_tokens), 0)::int AS total_tokens
      FROM agent_session_usage
      WHERE session_id = $1
    `,
    toolUsage: `
      SELECT
        COUNT(*)::int AS calls,
        COALESCE(SUM(cost_usd_micros), 0)::bigint AS cost_usd_micros
      FROM agent_session_tool_usage
      WHERE session_id = $1
    `,
    sandboxUsage: `
      SELECT
        COUNT(*)::int AS records,
        COALESCE(SUM(active_ms), 0)::bigint AS active_ms,
        COALESCE(SUM(cost_usd_micros), 0)::bigint AS cost_usd_micros
      FROM agent_session_sandbox_usage
      WHERE session_id = $1
    `,
  };
}

export function eventTypesForPreviewDebug() {
  return EVENT_TYPES;
}

export function buildBetterStackHints({ pr, sessionId, sourceName = DEFAULT_SOURCE_NAME }) {
  const filters = [`source:${sourceName}`, `preview_pr_number=${pr}`, `session_id=${sessionId}`];
  return {
    filters,
    runnerQuery: filters.join(" "),
    errorQuery: `preview_pr_number=${pr} session_id=${sessionId}`,
  };
}

export function formatPreviewDebugReport(input) {
  const names = previewNames(input.pr);
  const hints = buildBetterStackHints({
    pr: input.pr,
    sessionId: input.sessionId,
    sourceName: input.sourceName,
  });
  const session = input.session ?? null;
  const lines = [];

  lines.push(`# Preview session debug`);
  lines.push("");
  lines.push(`PR: #${input.pr}`);
  lines.push(`Session: ${input.sessionId}`);
  lines.push(`Runner service: ${names.runnerService}`);
  lines.push(`Neon branch: ${names.neonBranch}`);
  lines.push("");

  lines.push("## Better Stack searches");
  lines.push(`Runner logs: ${hints.runnerQuery}`);
  lines.push(`Errors: ${hints.errorQuery}`);
  lines.push("");

  lines.push("## Session");
  if (!session) {
    lines.push("No session row found.");
  } else {
    lines.push(formatKeyValues(normalizeSessionRow(session)));
  }
  lines.push("");

  lines.push("## Run jobs");
  lines.push(formatRows(input.jobs, formatJobRow));
  lines.push("");

  lines.push("## Messages");
  lines.push(formatRows(input.messages, formatMessageRow));
  lines.push("");

  lines.push("## Runtime events");
  const events = input.events.map(summarizeRuntimeEvent);
  lines.push(formatRows(events, formatEventRow));
  lines.push("");

  lines.push("## Approvals");
  lines.push(formatRows(input.approvals, formatApprovalRow));
  lines.push("");

  lines.push("## Questions");
  lines.push(formatRows(input.questions, formatQuestionRow));
  lines.push("");

  lines.push("## Debug model request");
  if (input.latestDebugModelRequest) {
    lines.push(
      `Present: event ${input.latestDebugModelRequest.id}, message ${value(input.latestDebugModelRequest.message_id)}, ${iso(input.latestDebugModelRequest.created_at)}`,
    );
  } else {
    lines.push("No debug.model_request event found.");
  }
  lines.push("");

  lines.push("## Usage");
  lines.push(formatKeyValues(normalizeUsage(input.usage, input.toolUsage, input.sandboxUsage)));

  return `${lines.join("\n")}\n`;
}

export function summarizeRuntimeEvent(event) {
  const payload = isRecord(event.payload) ? event.payload : {};
  const error = isRecord(payload.error) ? payload.error : {};
  return compact({
    id: event.id,
    type: event.type,
    message_id: event.message_id,
    created_at: event.created_at,
    status: stringValue(payload.status),
    message: event.type === "session.error" ? stringValue(payload.message) : undefined,
    tool_call_id: stringValue(payload.toolCallId),
    tool_name: stringValue(payload.name),
    provider_key: stringValue(payload.providerKey),
    permission_group: stringValue(payload.permissionGroup),
    decision: stringValue(payload.decision),
    decision_source: stringValue(payload.decisionSource),
    answered: typeof payload.answered === "boolean" ? payload.answered : undefined,
    resolution_source: stringValue(payload.resolutionSource),
    error_code: stringValue(error.code),
    error_message: stringValue(error.message),
    error_recoverable: typeof error.recoverable === "boolean" ? error.recoverable : undefined,
  });
}

export function maskDatabaseUrl(databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.username) parsed.username = "user";
    if (parsed.password) parsed.password = "password";
    return parsed.toString();
  } catch {
    return "[invalid database url]";
  }
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parsePrNumber(value) {
  const pr = Number(value);
  if (!Number.isInteger(pr) || pr <= 0) throw new Error("--pr must be a positive integer.");
  return pr;
}

function parseSessionId(value) {
  const sessionId = String(value ?? "").trim();
  if (!sessionId) throw new Error("--session is required.");
  return sessionId;
}

function normalizeSessionRow(session) {
  return {
    status: session.status,
    last_error: session.last_error,
    source: session.source,
    agent_id: session.agent_id,
    workspace_id: session.workspace_id,
    user_id: session.user_id,
    model: [session.model_provider, session.model_name].filter(Boolean).join(" / "),
    e2b_sandbox_id: session.e2b_sandbox_id,
    run_lease_id: session.run_lease_id,
    run_lease_owner: session.run_lease_owner,
    run_lease_message_id: session.run_lease_message_id,
    run_lease_expires_at: iso(session.run_lease_expires_at),
    run_heartbeat_at: iso(session.run_heartbeat_at),
    abort_requested_at: iso(session.abort_requested_at),
    archived_at: iso(session.archived_at),
    sandbox_terminated_at: iso(session.sandbox_terminated_at),
    last_turn_finished_at: iso(session.last_turn_finished_at),
    created_at: iso(session.created_at),
    updated_at: iso(session.updated_at),
  };
}

function normalizeUsage(usage = {}, toolUsage = {}, sandboxUsage = {}) {
  return {
    model_steps: numberValue(usage.model_steps),
    input_tokens: numberValue(usage.input_tokens),
    output_tokens: numberValue(usage.output_tokens),
    total_tokens: numberValue(usage.total_tokens),
    tool_calls: numberValue(toolUsage.calls),
    tool_cost_usd_micros: numberValue(toolUsage.cost_usd_micros),
    sandbox_records: numberValue(sandboxUsage.records),
    sandbox_active_ms: numberValue(sandboxUsage.active_ms),
    sandbox_cost_usd_micros: numberValue(sandboxUsage.cost_usd_micros),
  };
}

function formatRows(rows, formatter) {
  if (!rows || rows.length === 0) return "None.";
  return rows.map(formatter).join("\n");
}

function formatJobRow(row) {
  return [
    `- #${row.id}`,
    row.kind,
    row.status,
    `attempts=${row.attempts}`,
    `message=${value(row.message_id)}`,
    `lease=${value(row.lease_id)}`,
    `expires=${iso(row.lease_expires_at)}`,
    `last_error=${value(row.last_error)}`,
    `updated=${iso(row.updated_at)}`,
  ].join(" | ");
}

function formatMessageRow(row) {
  return [
    `- ${row.id}`,
    row.role,
    row.status,
    `internal=${Boolean(row.internal)}`,
    `chars=${numberValue(row.content_length)}`,
    `tool=${value(row.tool_name)}`,
    `tool_call=${value(row.tool_call_id)}`,
    `response_to=${value(row.response_to_message_id)}`,
    `completed=${iso(row.completed_at)}`,
  ].join(" | ");
}

function formatEventRow(row) {
  return [
    `- #${row.id}`,
    row.type,
    `message=${value(row.message_id)}`,
    `at=${iso(row.created_at)}`,
    `status=${value(row.status)}`,
    `tool=${value(row.tool_name)}`,
    `tool_call=${value(row.tool_call_id)}`,
    `error_code=${value(row.error_code)}`,
    `error=${value(row.error_message)}`,
    `decision=${value(row.decision)}`,
    `resolution=${value(row.resolution_source ?? row.decision_source)}`,
  ].join(" | ");
}

function formatApprovalRow(row) {
  return [
    `- #${row.id}`,
    row.status,
    `tool=${value(row.tool_name)}`,
    `tool_call=${value(row.tool_call_id)}`,
    `provider=${value(row.provider_key)}`,
    `permission=${value(row.permission_group)}`,
    `decision_source=${value(row.decision_source)}`,
    `requested=${iso(row.requested_at)}`,
    `decided=${iso(row.decided_at)}`,
  ].join(" | ");
}

function formatQuestionRow(row) {
  return [
    `- #${row.id}`,
    row.status,
    `tool_call=${value(row.tool_call_id)}`,
    `resolution=${value(row.resolution_source)}`,
    `requested=${iso(row.requested_at)}`,
    `answered=${iso(row.answered_at)}`,
  ].join(" | ");
}

function formatKeyValues(values) {
  return Object.entries(values)
    .map(([key, item]) => `- ${key}: ${value(item)}`)
    .join("\n");
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function value(item) {
  if (item === undefined || item === null || item === "") return "-";
  return String(item);
}

function numberValue(item) {
  if (item === undefined || item === null || item === "") return 0;
  return Number(item);
}

function stringValue(item) {
  return typeof item === "string" && item ? item : undefined;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compact(obj) {
  const out = {};
  for (const [key, item] of Object.entries(obj)) {
    if (item !== undefined && item !== null && item !== "") out[key] = item;
  }
  return out;
}
