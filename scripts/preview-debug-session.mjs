#!/usr/bin/env node

// Read-only preview session debugger. It intentionally prints summaries rather than raw payloads:
// runtime event payloads can contain prompts, model output, tool inputs, or command output.

import pg from "pg";
import {
  buildPreviewDebugSql,
  eventTypesForPreviewDebug,
  formatPreviewDebugReport,
  maskDatabaseUrl,
  parsePreviewDebugArgs,
  usage,
} from "./lib/preview-debug-session.mjs";

const { Pool } = pg;

await main().catch((error) => {
  console.error(`Preview session debug failed: ${error.message}`);
  process.exit(1);
});

async function main() {
  const args = parsePreviewDebugArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const summary = await loadPreviewSessionDebug(args);
  process.stdout.write(formatPreviewDebugReport(summary));
}

async function loadPreviewSessionDebug(args) {
  const pool = new Pool({
    connectionString: args.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000,
  });
  const client = await pool.connect();
  const sql = buildPreviewDebugSql();

  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '10000ms'");

    const [
      session,
      jobs,
      messages,
      events,
      latestDebugModelRequest,
      approvals,
      questions,
      usageRows,
      toolUsageRows,
      sandboxUsageRows,
    ] = await Promise.all([
      client.query(sql.session, [args.sessionId]),
      client.query(sql.jobs, [args.sessionId]),
      client.query(sql.messages, [args.sessionId]),
      client.query(sql.events, [args.sessionId, eventTypesForPreviewDebug()]),
      client.query(sql.latestDebugModelRequest, [args.sessionId]),
      client.query(sql.approvals, [args.sessionId]),
      client.query(sql.questions, [args.sessionId]),
      client.query(sql.usage, [args.sessionId]),
      client.query(sql.toolUsage, [args.sessionId]),
      client.query(sql.sandboxUsage, [args.sessionId]),
    ]);

    await client.query("ROLLBACK");

    return {
      pr: args.prNumber,
      sessionId: args.sessionId,
      sourceName: args.sourceName,
      databaseUrl: maskDatabaseUrl(args.databaseUrl),
      session: session.rows[0] ?? null,
      jobs: jobs.rows,
      messages: messages.rows,
      events: events.rows,
      latestDebugModelRequest: latestDebugModelRequest.rows[0] ?? null,
      approvals: approvals.rows,
      questions: questions.rows,
      usage: usageRows.rows[0] ?? {},
      toolUsage: toolUsageRows.rows[0] ?? {},
      sandboxUsage: sandboxUsageRows.rows[0] ?? {},
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures; preserve the original error.
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
