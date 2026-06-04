// Standalone local Durable Streams server for dev (no Electric Cloud needed).
// `bun run dev` already starts this automatically and injects DURABLE_STREAMS_URL;
// run it directly only when you want a standalone server (e.g. running the web and
// runner apps separately).
//
// Usage:
//   bun scripts/durable-streams-dev.mjs
// Then, in the runner AND web env:
//   DURABLE_STREAMS_URL="http://127.0.0.1:4150"
//
// The runner appends session events here; the web read proxy
// (/api/streams/v1/session/[id]) forwards browser reads to it.

import { startDurableStreamsDevServer } from "./lib/durable-streams-dev.mjs";

const { url, server } = await startDurableStreamsDevServer();

console.log(`\n  Durable Streams dev server listening at ${url}`);
console.log(`  → export DURABLE_STREAMS_URL="${url}" (runner + web)`);

const shutdown = async () => {
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
