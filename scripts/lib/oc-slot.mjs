// Slot allocation for running several full local stacks side by side — one per
// Conductor worktree — without colliding on ports or disrupting the :3000 primary.
//
// A "slot" is a small integer that deterministically maps a worktree to a pair of
// ports: web and runner. Everything else (the shared dev DB, Electric, durable-streams)
// is shared across slots, so a slot only needs its own web + runner. Slot 0 is reserved
// for the classic single-stack flow (web :3000 / runner :3040, the launchd primary);
// review slots live in the 33xx band so they never touch :3000.
//
//   slot 1 → web 3310, runner 3311
//   slot 2 → web 3320, runner 3321
//   …
//   slot 9 → web 3390, runner 3391
//
// The web port doubles as the WorkOS redirect origin, so the 3310–3390 band is exactly
// the set of localhost redirect URIs to register once in the WorkOS dashboard.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const SLOT_MIN = 1;
export const SLOT_MAX = 9;
const SLOT_BASE = 3300;
const SLOT_STRIDE = 10;

const STATE_DIR = ".context";
const STATE_FILE = join(STATE_DIR, "oc-slot.json");

/** The web + runner ports for a slot. */
export function slotPorts(slot) {
  const web = SLOT_BASE + slot * SLOT_STRIDE;
  return { web, runner: web + 1 };
}

/**
 * Deterministic slot for a name (the worktree directory name), so the same worktree
 * keeps the same ports across reboots. A cheap stable hash — no crypto needed.
 */
export function computeSlot(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SLOT_MIN + (hash % (SLOT_MAX - SLOT_MIN + 1));
}

/** True when nothing is LISTENing on the TCP port locally. */
export function isPortFree(port) {
  const lsof = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  // lsof exits 1 with empty stdout when there is no listener — that's "free".
  return !lsof.stdout || lsof.stdout.trim() === "";
}

/** Both of a slot's ports are free. */
export function slotIsFree(slot) {
  const { web, runner } = slotPorts(slot);
  return isPortFree(web) && isPortFree(runner);
}

/**
 * Pick a usable slot. Starts from `preferred` (the worktree's deterministic slot) and
 * walks the band so a busy preferred slot falls through to the next free one. Throws
 * when every slot is occupied (you're already running SLOT_MAX stacks).
 */
export function findFreeSlot(preferred) {
  if (slotIsFree(preferred)) return preferred;
  for (let slot = SLOT_MIN; slot <= SLOT_MAX; slot++) {
    if (slotIsFree(slot)) return slot;
  }
  throw new Error(
    `All local stack slots (${SLOT_MIN}-${SLOT_MAX}) are in use. Tear one down first ` +
      `(bun run dev:slot down in its worktree) or free its ports.`,
  );
}

/** The worktree this process is running in — used as the slot key. */
export function worktreeName(cwd = process.cwd()) {
  return basename(cwd);
}

/**
 * Resolve the slot to boot from CLI args. `--slot=N` forces a specific slot (and fails
 * if it's busy, so the failure is loud rather than silently moving you elsewhere); a
 * bare `--slot` (or nothing) auto-picks from the worktree's deterministic slot.
 */
export function resolveSlot(args, cwd = process.cwd()) {
  const explicit = args.map((a) => /^--slot=(\d+)$/.exec(a)).find(Boolean);
  if (explicit) {
    const slot = Number(explicit[1]);
    if (slot < SLOT_MIN || slot > SLOT_MAX) {
      throw new Error(`--slot must be ${SLOT_MIN}-${SLOT_MAX}, got ${slot}.`);
    }
    if (!slotIsFree(slot)) {
      const { web, runner } = slotPorts(slot);
      throw new Error(`Slot ${slot} is busy (:${web} or :${runner} in use).`);
    }
    return slot;
  }
  return findFreeSlot(computeSlot(worktreeName(cwd)));
}

/**
 * The environment that relocates web + runner onto a slot. Turbo passes these through
 * to the dev tasks (PORT/RUNNER_PORT/RUNNER_* are in turbo.json globalEnv; NEXT_PUBLIC_*
 * is auto-included for the Next task), so injecting them into process.env before
 * spawning turbo is enough — we never write them into .env.local/.env.override.local
 * (that would also hijack the classic :3000 flow in this worktree).
 *
 * DATABASE_URL is deliberately absent: the slot inherits the shared dev DB from
 * .env.local, which is the whole point — you see your real chats. ELECTRIC_URL likewise
 * inherits the shared :3010 container. DURABLE_STREAMS_URL is set by the orchestrator
 * once it knows the shared server's URL.
 */
export function slotEnv(slot) {
  const { web, runner } = slotPorts(slot);
  return {
    PORT: String(web),
    RUNNER_PORT: String(runner),
    NEXT_PUBLIC_APP_URL: `http://localhost:${web}`,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: `http://localhost:${web}/auth/callback`,
    RUNNER_PUBLIC_URL: `http://localhost:${runner}`,
    RUNNER_INTERNAL_URL: `http://localhost:${runner}`,
    RUNNER_ALLOWED_ORIGINS: `http://localhost:${web}`,
  };
}

/** Record the running slot so `down`/status can find it (best-effort, gitignored). */
export function writeSlotState(slot, extra = {}) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      STATE_FILE,
      `${JSON.stringify({ slot, ...slotPorts(slot), ...extra, startedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch {
    // Non-fatal: the slot is still deterministic from the worktree name.
  }
}

/** The recorded slot for this worktree, or null. */
export function readSlotState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function clearSlotState() {
  rmSync(STATE_FILE, { force: true });
}

/** SIGTERM whatever is listening on a slot's web + runner ports. Shared infra is left alone. */
export function killSlotPorts(slot) {
  const { web, runner } = slotPorts(slot);
  for (const port of [web, runner]) {
    const pids = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
      .stdout.split(/\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  return { web, runner };
}
