import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bridgeHome } from "./config";

// The local permission rulebook the daemon consults before executing anything from
// the cloud. The file is hand-editable, so loading normalizes the known keys and
// preserves any unknown ones across save.

export type BridgeMode = "ask" | "allow-everything";

export type BridgeSettings = {
  mode: BridgeMode;
  allow: string[];
  deny: string[];
  [key: string]: unknown;
};

export function defaultSettings(): BridgeSettings {
  return {
    mode: "ask",
    allow: [],
    deny: ["read(~/.ssh/**)", "write(~/.ssh/**)"],
  };
}

export function settingsPath(): string {
  return join(bridgeHome(), "bridge-settings.json");
}

export function loadSettings(path: string = settingsPath()): BridgeSettings {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return defaultSettings();
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    ...parsed,
    mode: parsed.mode === "allow-everything" ? "allow-everything" : "ask",
    allow: stringArray(parsed.allow),
    deny: stringArray(parsed.deny),
  };
}

export function saveSettings(settings: BridgeSettings, path: string = settingsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function appendAllowRule(rule: string, path: string = settingsPath()): void {
  const settings = loadSettings(path);
  if (settings.allow.includes(rule)) {
    return;
  }
  settings.allow.push(rule);
  saveSettings(settings, path);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}
