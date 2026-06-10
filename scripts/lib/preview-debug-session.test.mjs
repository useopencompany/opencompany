import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildBetterStackHints,
  formatPreviewDebugReport,
  maskDatabaseUrl,
  parsePreviewDebugArgs,
  summarizeRuntimeEvent,
  usage,
} from "./preview-debug-session.mjs";

const makePostgresUrl = (authority) => ["postgresql:", authority].join("//");

test("parsePreviewDebugArgs requires PR, session id, and a preview database url", () => {
  const previewDatabaseUrl = makePostgresUrl("preview");

  assert.deepEqual(
    parsePreviewDebugArgs(["--pr", "42", "--session", "ses_123"], {
      PREVIEW_DATABASE_URL: previewDatabaseUrl,
    }),
    {
      pr: "42",
      prNumber: 42,
      sessionId: "ses_123",
      sourceName: "opencompany-runner-preview",
      databaseUrl: previewDatabaseUrl,
    },
  );

  assert.throws(() => parsePreviewDebugArgs(["--session", "ses_123"], {}), /--pr/);
  assert.throws(() => parsePreviewDebugArgs(["--pr", "42"], {}), /--session/);
  assert.throws(
    () => parsePreviewDebugArgs(["--pr", "42", "--session", "ses_123"], {}),
    /PREVIEW_DATABASE_URL or DATABASE_URL/,
  );
});

test("parsePreviewDebugArgs supports inline args and source override", () => {
  const fallbackDatabaseUrl = makePostgresUrl("fallback");
  const args = parsePreviewDebugArgs(
    ["--pr=7", "--session=ses_abc", "--source-name=runner-preview"],
    {
      DATABASE_URL: fallbackDatabaseUrl,
    },
  );

  assert.equal(args.prNumber, 7);
  assert.equal(args.sessionId, "ses_abc");
  assert.equal(args.sourceName, "runner-preview");
  assert.equal(args.databaseUrl, fallbackDatabaseUrl);
});

test("usage documents the runnable command", () => {
  assert.match(usage(), /bun run preview:debug-session/);
});

test("buildBetterStackHints includes preview PR and session filters", () => {
  const hints = buildBetterStackHints({
    pr: 42,
    sessionId: "ses_123",
    sourceName: "opencompany-runner-preview",
  });

  assert.equal(
    hints.runnerQuery,
    "source:opencompany-runner-preview preview_pr_number=42 session_id=ses_123",
  );
  assert.equal(hints.errorQuery, "preview_pr_number=42 session_id=ses_123");
});

test("summarizeRuntimeEvent keeps only safe allowlisted payload fields", () => {
  const summary = summarizeRuntimeEvent({
    id: 12,
    type: "tool.failed",
    message_id: "msg_123",
    created_at: "2026-06-10T12:00:00Z",
    payload: {
      messageId: "msg_123",
      toolCallId: "call_123",
      name: "run_command",
      input: { command: "cat secret.txt" },
      outputPreview: "raw command output",
      error: { code: "tool_failed", message: "Command failed", recoverable: false },
    },
  });

  assert.deepEqual(summary, {
    id: 12,
    type: "tool.failed",
    message_id: "msg_123",
    created_at: "2026-06-10T12:00:00Z",
    tool_call_id: "call_123",
    tool_name: "run_command",
    error_code: "tool_failed",
    error_message: "Command failed",
    error_recoverable: false,
  });
  assert.equal(JSON.stringify(summary).includes("secret.txt"), false);
  assert.equal(JSON.stringify(summary).includes("raw command output"), false);
});

test("formatPreviewDebugReport does not print raw message content or raw event payloads", () => {
  const report = formatPreviewDebugReport({
    pr: 42,
    sessionId: "ses_123",
    sourceName: "opencompany-runner-preview",
    session: {
      id: "ses_123",
      workspace_id: "wsp_123",
      user_id: "usr_123",
      agent_id: "agt_123",
      status: "failed",
      source: "user",
      model_provider: "vercel-ai-gateway",
      model_name: "openai/gpt-5.4-mini",
      last_error: "model stream failed",
      created_at: "2026-06-10T12:00:00Z",
      updated_at: "2026-06-10T12:01:00Z",
    },
    jobs: [],
    messages: [
      {
        id: "msg_1",
        role: "user",
        status: "completed",
        internal: false,
        content_length: 29,
        content: "do not print this prompt text",
        created_at: "2026-06-10T12:00:00Z",
      },
    ],
    events: [
      {
        id: 1,
        type: "tool.failed",
        message_id: "msg_2",
        payload: {
          toolCallId: "call_1",
          name: "write_file",
          outputPreview: "do not print tool output",
          error: { code: "tool_failed", message: "Tool failed", recoverable: true },
        },
        created_at: "2026-06-10T12:00:30Z",
      },
    ],
    approvals: [],
    questions: [],
    latestDebugModelRequest: null,
    usage: { model_steps: 1, input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    toolUsage: { calls: 1, cost_usd_micros: "0" },
    sandboxUsage: { records: 1, active_ms: "1000", cost_usd_micros: "10" },
  });

  assert.match(report, /status: failed/);
  assert.match(report, /chars=29/);
  assert.match(report, /source:opencompany-runner-preview preview_pr_number=42 session_id=ses_123/);
  assert.equal(report.includes("do not print this prompt text"), false);
  assert.equal(report.includes("do not print tool output"), false);
});

test("maskDatabaseUrl redacts userinfo", () => {
  assert.equal(
    maskDatabaseUrl(
      makePostgresUrl("real-user:real-password@example.neon.tech/db?sslmode=require"),
    ),
    makePostgresUrl("user:password@example.neon.tech/db?sslmode=require"),
  );
});
