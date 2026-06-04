// Local Durable Streams server for dev (no Electric Cloud needed). Starts the
// @durable-streams/server reference server on a fixed port and prints the URL to
// export as DURABLE_STREAMS_URL.
//
// Usage:
//   bun scripts/durable-streams-dev.mjs
// Then, in the runner AND web env:
//   DURABLE_STREAMS_URL="http://127.0.0.1:4150"
//
// The runner appends session events here; the web read proxy
// (/api/streams/v1/session/[id]) forwards browser reads to it.

import { DurableStreamTestServer } from "@durable-streams/server";

const PORT = Number(process.env.DURABLE_STREAMS_DEV_PORT ?? "4150");

const server = new DurableStreamTestServer({ port: PORT, host: "127.0.0.1" });
const url = await server.start();

console.log(`\n  Durable Streams dev server listening at ${url}`);
console.log(`  → export DURABLE_STREAMS_URL="${url}" (runner + web)`);

const shutdown = async () => {
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
