#!/usr/bin/env bun
import { resolveRoot } from "../store";
import { appendEvidence } from "./append-evidence";
import { parseArgs } from "./args";
import { create } from "./create";
import { doctor } from "./doctor";
import { get } from "./get";
import { type CommandContext, type CommandResult, fail, render } from "./io";
import { merge } from "./merge";
import { query } from "./query";
import { rewrite } from "./rewrite";

const COMMANDS: Record<string, (ctx: CommandContext) => Promise<CommandResult>> = {
  create,
  get,
  query,
  "append-evidence": appendEvidence,
  rewrite,
  merge,
  doctor,
};

const HELP = `memory — structured, evidence-first memory for the personal agent

Usage: memory <command> [options]

Commands:
  create           Create a canonical object (person|company|project|customer|decision|concept|theme)
  get              Fetch a memory file (--section truth|timeline|frontmatter|all, --follow)
  query            Hybrid retrieval over the tree (--type, --status, --folder, --since, --limit, --lexical-only)
  append-evidence  Record immutable evidence and link it to canonical subjects
  rewrite          Update compiled truth (requires [^ev:<id>] citations to linked evidence)
  merge            Resolve a duplicate canonical object into another (--from, --into, --dry-run)
  doctor           Check integrity (--fix-freshness)

Global options:
  --root <path>    Memory root (default: agent/memory)
  --json           Machine-readable output
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const commandName = argv[0];

  if (!commandName || commandName === "help" || commandName === "--help" || commandName === "-h") {
    process.stdout.write(HELP);
    process.exit(commandName ? 0 : 1);
  }

  const handler = COMMANDS[commandName];
  const args = parseArgs(argv.slice(1));
  const json = args.has("json");

  if (!handler) {
    const result = fail(`Unknown command "${commandName}". Run \`memory help\`.`);
    render(result, json);
    process.exit(1);
  }

  const ctx: CommandContext = { root: resolveRoot(args.get("root")), json, args };

  try {
    const result = await handler(ctx);
    render(result, json);
    process.exit(result.code);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    render(fail(`Unexpected error: ${message}`), json);
    process.exit(1);
  }
}

void main();
