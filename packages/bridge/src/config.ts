import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Device identity for the bridge daemon, written by `oc-bridge pair`. Holds the
// device secret, so the file is kept owner-only (0600).

export type BridgeConfig = {
  deviceId: string;
  deviceSecret: string;
  workspaceId: string;
  deviceName: string;
  apiUrl: string;
  runnerUrl: string;
};

const CONFIG_FIELDS = [
  "deviceId",
  "deviceSecret",
  "workspaceId",
  "deviceName",
  "apiUrl",
  "runnerUrl",
] as const;

// OC_BRIDGE_HOME exists so tests (and parallel installs) can point the bridge at a
// throwaway directory instead of the real ~/.opencompany.
export function bridgeHome(): string {
  return process.env.OC_BRIDGE_HOME ?? join(homedir(), ".opencompany");
}

export function configPath(): string {
  return join(bridgeHome(), "bridge.json");
}

export function loadConfig(path: string = configPath()): BridgeConfig | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const field of CONFIG_FIELDS) {
    const value = parsed[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Invalid bridge config at ${path}: missing or empty "${field}".`);
    }
  }
  return parsed as BridgeConfig;
}

export function saveConfig(config: BridgeConfig, path: string = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // writeFileSync only applies mode on creation; enforce it on overwrite too.
  chmodSync(path, 0o600);
}
