#!/usr/bin/env node

import "./load-env.mjs";
import { neon } from "@neondatabase/serverless";

const chatId = parseChatId(process.argv.slice(2));
if (!chatId) {
  console.error("Usage: bun run goat:codex:debug -- <chat-id-or-goat-url>");
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const sql = neon(databaseUrl);

await printSection(
  "chat",
  sql`
  SELECT id, user_workos_id, title, model, engine, closed_at, created_at, updated_at
  FROM goat.chat_sessions
  WHERE id = ${chatId}
`,
);

await printSection(
  "messages",
  sql`
  SELECT id, role, left(content, 800) AS content, task_id, debug_trace, created_at, updated_at
  FROM goat.chat_messages
  WHERE session_id = ${chatId}
  ORDER BY created_at ASC
`,
);

await printSection(
  "local session",
  sql`
  SELECT *
  FROM goat.local_codex_sessions
  WHERE chat_session_id = ${chatId}
`,
);

await printSection(
  "turns",
  sql`
  SELECT t.*
  FROM goat.local_codex_turns t
  JOIN goat.local_codex_sessions s ON s.id = t.local_codex_session_id
  WHERE s.chat_session_id = ${chatId}
  ORDER BY t.created_at ASC
`,
);

await printSection(
  "commands",
  sql`
  SELECT c.*
  FROM goat.local_codex_commands c
  JOIN goat.local_codex_sessions s ON s.id = c.local_codex_session_id
  WHERE s.chat_session_id = ${chatId}
  ORDER BY c.created_at ASC
`,
);

await printSection(
  "recent events",
  sql`
  SELECT e.id, e.type, e.local_codex_turn_id, e.command_id, e.created_at, e.payload, e.raw_event
  FROM goat.local_codex_events e
  JOIN goat.local_codex_sessions s ON s.id = e.local_codex_session_id
  WHERE s.chat_session_id = ${chatId}
  ORDER BY e.created_at DESC
  LIMIT 25
`,
);

await printSection(
  "recent bridges",
  sql`
  SELECT id, user_workos_id, name, token_prefix, last_seen_at, revoked_at, created_at, updated_at
  FROM goat.local_bridges
  ORDER BY last_seen_at DESC NULLS LAST, created_at DESC
  LIMIT 10
`,
);

async function printSection(name, rowsPromise) {
  const rows = await rowsPromise;
  console.log(`\n## ${name}`);
  console.log(JSON.stringify(rows, null, 2));
}

function parseChatId(args) {
  const raw = args.find((arg) => arg && !arg.startsWith("--"))?.trim();
  if (!raw) return null;
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const url = new URL(raw);
    return url.searchParams.get("chat");
  }
  return raw;
}
