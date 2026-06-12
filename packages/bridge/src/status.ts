import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bridgeHome } from "./config";
import type { BridgeMode } from "./settings";

// A small, machine-readable status file the daemon writes so a local control surface
// (the macOS menubar app) can show connection state + recent activity without parsing
// the human log. It carries no secrets — only the device name, connection state, and a
// short ring buffer of recent actions. The settings file remains the permission
// authority; this file is observation-only.

export type BridgeActivityEntry = {
  at: string;
  tool: string;
  decision: string;
  summary: string;
};

export type BridgeStatus = {
  deviceName: string;
  connected: boolean;
  // Heartbeat: the app treats a status whose updatedAt is stale (daemon crashed without
  // flipping connected:false) as disconnected.
  updatedAt: string;
  mode: BridgeMode;
  recentActions: BridgeActivityEntry[];
};

const MAX_RECENT_ACTIONS = 25;

export function statusPath(): string {
  return join(bridgeHome(), "bridge-status.json");
}

export function readStatus(path: string = statusPath()): BridgeStatus | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BridgeStatus;
  } catch {
    return null;
  }
}

function writeStatus(status: BridgeStatus, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

// A tiny in-process writer that owns the status file for one daemon run. Keeps the ring
// buffer in memory and rewrites the file on every change, stamping updatedAt each time.
export function createStatusWriter(input: {
  deviceName: string;
  mode: BridgeMode;
  path?: string;
  now?: () => Date;
}) {
  const path = input.path ?? statusPath();
  const now = input.now ?? (() => new Date());
  const status: BridgeStatus = {
    deviceName: input.deviceName,
    connected: false,
    updatedAt: now().toISOString(),
    mode: input.mode,
    recentActions: [],
  };

  const flush = () => {
    status.updatedAt = now().toISOString();
    writeStatus(status, path);
  };

  return {
    setConnected(connected: boolean) {
      status.connected = connected;
      flush();
    },
    setMode(mode: BridgeMode) {
      status.mode = mode;
      flush();
    },
    pushActivity(entry: Omit<BridgeActivityEntry, "at">) {
      status.recentActions.unshift({ at: now().toISOString(), ...entry });
      if (status.recentActions.length > MAX_RECENT_ACTIONS) {
        status.recentActions.length = MAX_RECENT_ACTIONS;
      }
      flush();
    },
  };
}

export type BridgeStatusWriter = ReturnType<typeof createStatusWriter>;
