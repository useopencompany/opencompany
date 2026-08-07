import type { BrainUsageEntry } from "../usage";
import type { ParsedArgs } from "./args";

export type CommandResult = {
  code: number;
  data: unknown;
  text: string;
  usage?: BrainUsageEntry[];
};

export type CommandContext = {
  root: string;
  json: boolean;
  args: ParsedArgs;
};

export function ok(text: string, data: unknown = {}): CommandResult {
  return { code: 0, data: { ...asObject(data), ok: true }, text };
}

export function fail(text: string, code = 1, data: unknown = {}): CommandResult {
  return { code, data: { ...asObject(data), ok: false, error: text }, text: `Error: ${text}` };
}

export function notFound(text: string): CommandResult {
  return fail(text, 2);
}

export function render(result: CommandResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
    return;
  }
  const stream = result.code === 0 ? process.stdout : process.stderr;
  stream.write(`${result.text}\n`);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
