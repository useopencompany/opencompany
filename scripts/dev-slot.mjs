// Boot an isolated full local stack for THIS worktree on its own ports, sharing the
// dev DB + Electric + durable-streams with every other slot. Lets you review several
// branches at once without touching the :3000 primary or other worktrees' stacks.
//
//   bun run dev:slot          # auto-pick this worktree's slot, boot web + runner
//   bun run dev:slot --slot=3  # force a specific slot (1-9)
//   bun run dev:slot down      # stop this worktree's slot (web + runner only)
//
// Only web + runner are per-slot — they run the branch's code. inngest/stripe are
// skipped (not on the interactive chat → runner → durable-streams path). Login on a
// slot's web port needs that port registered once in WorkOS (see the oclocal skill).

import "./load-env.mjs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { exit } from "node:process";
import {
  DURABLE_STREAMS_DEV_PORT,
  DURABLE_STREAMS_DEV_URL,
  startDurableStreamsDevServer,
} from "./lib/durable-streams-dev.mjs";
import {
  clearSlotState,
  isPortFree,
  killSlotPorts,
  readSlotState,
  resolveSlot,
  slotEnv,
  slotPorts,
  worktreeName,
  writeSlotState,
} from "./lib/oc-slot.mjs";

const args = process.argv.slice(2);

if (args.includes("down")) {
  const recorded = readSlotState();
  const slot = recorded?.slot ?? resolveSlot([], process.cwd());
  const { web, runner } = killSlotPorts(slot);
  clearSlotState();
  console.log(
    `\nStopped slot ${slot} (:${web} web, :${runner} runner). Shared infra left running.\n`,
  );
  exit(0);
}

const slot = resolveSlot(args);
const { web, runner } = slotPorts(slot);

// Relocate web + runner onto this slot. Injected into process.env (not .env files) so
// the classic :3000 flow in this worktree stays untouched; turbo forwards these to the
// dev tasks via globalEnv / Next public-var inference.
Object.assign(process.env, slotEnv(slot));

// Shared durable-streams on :4150. The runner publishes reasoning/message deltas there
// fire-and-forget — without it every run "lädt ewig". Host it in-process if it's down,
// otherwise reuse the already-running shared server.
let durableStreams = null;
if (isPortFree(DURABLE_STREAMS_DEV_PORT)) {
  try {
    const { url, server } = await startDurableStreamsDevServer();
    durableStreams = server;
    process.env.DURABLE_STREAMS_URL = url;
    console.log(`\nDurable Streams (shared) ready: ${url}`);
  } catch (error) {
    console.warn(`\nCould not start Durable Streams: ${error.message}. Runs won't live-stream.\n`);
  }
} else {
  process.env.DURABLE_STREAMS_URL = DURABLE_STREAMS_DEV_URL;
  console.log(`\nReusing shared Durable Streams at ${DURABLE_STREAMS_DEV_URL}.`);
}

const turboBin = existsSync("node_modules/.bin/turbo") ? "node_modules/.bin/turbo" : "turbo";
const dev = spawn(
  turboBin,
  // --ui=stream: tui needs a TTY and breaks under run_in_background.
  ["dev", "--ui=stream", "--filter=@opencompany/web", "--filter=@opencompany/runner"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      // ngrok + stripe are noise locally; inngest dev server is shared/optional and not
      // started here (interactive runs don't depend on it).
      OPENCOMPANY_NGROK_DISABLED: "1",
      STRIPE_LISTEN_DISABLED: "1",
      INNGEST_DEV: process.env.INNGEST_DEV ?? "1",
    },
  },
);

writeSlotState(slot, { pid: dev.pid, worktree: worktreeName() });

console.log(
  `\n  ▸ Slot ${slot} — ${worktreeName()}\n` +
    `    web    → http://localhost:${web}\n` +
    `    runner → http://localhost:${runner}\n` +
    `    Open http://localhost:${web} and log in as yourself (real DB → your real chats).\n` +
    `    First time on :${web}? Register http://localhost:${web}/auth/callback in WorkOS once.\n`,
);

let shuttingDown = false;

function stopDurableStreams() {
  if (durableStreams) {
    durableStreams.stop().catch(() => {});
    durableStreams = null;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    stopDurableStreams();
    clearSlotState();
    if (!dev.killed) dev.kill(signal);
  });
}

dev.on("exit", (code, signal) => {
  stopDurableStreams();
  clearSlotState();
  if (shuttingDown) exit(0);
  if (signal) exit(1);
  exit(code ?? 0);
});

dev.on("error", (error) => {
  stopDurableStreams();
  clearSlotState();
  console.error(`\nFailed to start turbo dev: ${error.message}\n`);
  exit(1);
});
