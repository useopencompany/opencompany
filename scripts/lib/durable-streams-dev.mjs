// Shared local Durable Streams server for dev (no Electric Cloud / Docker
// needed). Used by the standalone runner (scripts/durable-streams-dev.mjs) and
// by `bun run dev` (scripts/dev.mjs), which starts it automatically and injects
// DURABLE_STREAMS_URL so session transcripts stream out of the box.

import { DurableStreamTestServer } from "@durable-streams/server";

export const DURABLE_STREAMS_DEV_HOST = process.env.DURABLE_STREAMS_DEV_HOST?.trim() || "127.0.0.1";
export const DURABLE_STREAMS_DEV_PORT = Number(process.env.DURABLE_STREAMS_DEV_PORT ?? "4150");
export const DURABLE_STREAMS_DEV_URL = `http://${DURABLE_STREAMS_DEV_HOST}:${DURABLE_STREAMS_DEV_PORT}`;

/**
 * Start the in-memory Durable Streams reference server. Resolves to the running
 * server and its base URL (what to export as DURABLE_STREAMS_URL). The transcript
 * is also persisted in Postgres, so an ephemeral in-memory stream is fine for dev.
 */
export async function startDurableStreamsDevServer({
  host = DURABLE_STREAMS_DEV_HOST,
  port = DURABLE_STREAMS_DEV_PORT,
} = {}) {
  const server = new DurableStreamTestServer({ host, port });
  const url = await server.start();
  return { url, server };
}
