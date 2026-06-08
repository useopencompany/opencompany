import type { GatewayUsageEntry } from "../retrieval/gateway";
import type { ParsedArgs } from "./args";

// Shared shape every command returns. `data` is the machine payload (printed under --json);
// `text` is the human-readable rendering. `code` is the process exit code: 0 ok, 1 guardrail
// failure, 2 not found. `usage` is the model-backed retrieval footprint, surfaced out-of-band for
// session billing (never rendered to the model) — see src/usage.ts.
export type CommandResult = {
  code: number;
  data: unknown;
  text: string;
  usage?: GatewayUsageEntry[];
};

export type CommandContext = {
  root: string;
  json: boolean;
  args: ParsedArgs;
};

export function ok(text: string, data: unknown = {}): CommandResult {
  return { code: 0, data: { ok: true, ...asObject(data) }, text };
}

export function fail(text: string, code = 1, data: unknown = {}): CommandResult {
  return { code, data: { ok: false, error: text, ...asObject(data) }, text: `Error: ${text}` };
}

export function notFound(text: string): CommandResult {
  return fail(text, 2);
}

export function render(result: CommandResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
  } else {
    const stream = result.code === 0 ? process.stdout : process.stderr;
    stream.write(`${result.text}\n`);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
