#!/usr/bin/env bun
import { resolveRoot } from "../store";
import { formatMemoryUsageReport } from "../usage";
import { alias } from "./alias";
import { appendEvidence } from "./append-evidence";
import { parseArgs } from "./args";
import { create } from "./create";
import { del } from "./delete";
import { doctor } from "./doctor";
import { get } from "./get";
import { type CommandContext, type CommandResult, fail, render } from "./io";
import { link } from "./link";
import { merge } from "./merge";
import { query } from "./query";
import { rewrite } from "./rewrite";

const COMMANDS: Record<string, (ctx: CommandContext) => Promise<CommandResult>> = {
  create,
  get,
  query,
  "append-evidence": appendEvidence,
  rewrite,
  alias,
  link,
  merge,
  delete: del,
  doctor,
};

const HELP = `memory — structured, evidence-first memory for the personal agent

Usage: memory <command> [options]

Commands:
  create           Create a canonical object (person|company|project|customer|decision|concept|theme).
                   New objects start as drafts; --status active with compiled truth requires citations.
  get              Fetch a memory file (--section truth|timeline|frontmatter|all, --follow).
                   Default output is structured; --section scopes both the text and the --json payload.
  query            Hybrid retrieval over the tree.
                   Filters: --type, --status, --folder, --since, --limit, --lexical-only.
                   --hops N follows related links + citations N steps out, pulling in neighbors.
                   Results include capped compiled truth; run memory get <id> for the full record.
                   Hides merged stubs and invalid records by default; --include-merged / --include-invalid opt back in.
  append-evidence  Record immutable evidence and link it to canonical subjects.
  rewrite          Update compiled truth (requires [^ev:<id>] citations to linked evidence).
                   Promotes a draft to active once its truth is evidence-backed.
  alias            Add or remove aliases on a canonical object (--add, --remove, repeatable).
  link             Add or remove directional, typed related edges (--to, --as <type>, --remove).
  merge            Resolve a duplicate canonical object into another (--from, --into, --dry-run).
                   The source id is kept as an alias on the survivor so the old name still resolves.
  delete           Permanently remove a memory file (--force, --dry-run); scrubs inbound links.
  doctor           Check integrity (broken links, provenance, stale truth, duplicates).

Notes:
  Status lifecycle: draft (uncited scratch) → active (cited) ; deprecated (down-ranked) ; merged (redirect stub).
  Writes are last-write-wins with no locking — avoid running two writes against the same object in parallel.

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
  // Set by the runner's `memory` tool only. When on, emit the model-backed retrieval footprint as
  // a trailing sentinel line the runner parses for billing and strips before the model sees it.
  const reportUsage = args.has("report-usage");

  if (!handler) {
    const result = fail(`Unknown command "${commandName}". Run \`memory help\`.`);
    render(result, json);
    process.exit(1);
  }

  const ctx: CommandContext = { root: resolveRoot(args.get("root")), json, args };

  try {
    const result = await handler(ctx);
    render(result, json);
    // The marker goes to stderr, not stdout: it keeps the model-facing result (stdout) pristine and
    // avoids being dropped if stdout is truncated. The runner parses it off stderr and strips it.
    if (reportUsage && result.usage && result.usage.length > 0) {
      process.stderr.write(`${formatMemoryUsageReport(result.usage)}\n`);
    }
    process.exit(result.code);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    render(fail(`Unexpected error: ${message}`), json);
    process.exit(1);
  }
}

void main();
