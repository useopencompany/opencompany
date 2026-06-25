#!/usr/bin/env node

import { existsSync, readFileSync, watchFile } from "node:fs";
import { exit } from "node:process";

const DEFAULT_LOG_FILE = ".context/logs/dev-turbo.json";
const SOURCE_ALIASES = new Map([
  ["web", "@opencompany/web#dev"],
  ["runner", "@opencompany/runner#dev"],
  ["inngest", "@opencompany/inngest-dev#dev"],
  ["stripe", "@opencompany/stripe-webhooks#dev"],
  ["turbo", "turbo"],
]);

const options = parseArgs(process.argv.slice(2));

if (!existsSync(options.logFile)) {
  console.error(
    `No dev log file found at ${options.logFile}. Start the dev server with bun run dev.`,
  );
  exit(1);
}

let printed = 0;
printRecords({ initial: true });

if (options.follow) {
  watchFile(options.logFile, { interval: 500 }, () => {
    printRecords({ initial: false });
  });
}

function printRecords({ initial }) {
  const records = readLogRecords(options.logFile).filter((record) =>
    matchesOptions(record, options),
  );
  if (!initial && records.length < printed) printed = 0;
  const nextRecords = initial ? records.slice(-options.tail) : records.slice(printed);

  for (const record of nextRecords) {
    console.log(formatRecord(record));
  }

  printed = records.length;
}

function parseArgs(args) {
  const parsed = {
    logFile: DEFAULT_LOG_FILE,
    source: null,
    query: null,
    tail: 200,
    follow: false,
    errors: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [key, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];

    if (key === "--log-file") {
      parsed.logFile = inlineValue ?? args[(index += 1)];
    } else if (key === "--source" || key === "--task") {
      parsed.source = normalizeSource(inlineValue ?? args[(index += 1)]);
    } else if (key === "--grep" || key === "--query") {
      parsed.query = (inlineValue ?? args[(index += 1)])?.toLowerCase() ?? null;
    } else if (key === "--tail") {
      const value = Number(inlineValue ?? args[(index += 1)]);
      if (!Number.isInteger(value) || value < 1) {
        console.error("--tail must be a positive integer.");
        exit(1);
      }
      parsed.tail = value;
    } else if (key === "--follow" || key === "-f") {
      parsed.follow = true;
    } else if (key === "--errors") {
      parsed.errors = true;
    } else if (key === "--help" || key === "-h") {
      printHelp();
      exit(0);
    } else if (arg && !arg.startsWith("-")) {
      parsed.query = arg.toLowerCase();
    } else {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      exit(1);
    }
  }

  return parsed;
}

function normalizeSource(source) {
  if (!source) return null;
  const normalized = source.trim();
  return SOURCE_ALIASES.get(normalized) ?? normalized;
}

function readLogRecords(logFile) {
  const input = readFileSync(logFile, "utf8");
  return extractJsonObjects(input)
    .map((chunk) => {
      try {
        return JSON.parse(chunk);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function extractJsonObjects(input) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(input.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function matchesOptions(record, input) {
  const source = String(record.source ?? "");
  const text = stripAnsi(String(record.text ?? ""));
  const level = String(record.level ?? "");

  if (input.source && !source.includes(input.source)) return false;
  if (input.errors && !isErrorRecord({ level, text })) return false;
  if (input.query && !`${source}\n${level}\n${text}`.toLowerCase().includes(input.query)) {
    return false;
  }

  return true;
}

function isErrorRecord({ level, text }) {
  const lower = `${level}\n${text}`.toLowerCase();
  return (
    lower.includes("error") ||
    lower.includes("failed") ||
    lower.includes("exception") ||
    lower.includes("econnrefused")
  );
}

function formatRecord(record) {
  const timestamp = record.timestamp ? new Date(record.timestamp).toISOString() : "";
  const source = record.source ?? "unknown";
  const level = record.level ?? "info";
  const text = stripAnsi(String(record.text ?? ""));
  return `[${timestamp}] ${source} ${level}: ${text}`;
}

function stripAnsi(value) {
  return value.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    "",
  );
}

function printHelp() {
  console.log(`Usage: bun run dev:logs -- [options] [query]

Options:
  --source <name>      Filter by source. Aliases: web, runner, inngest, stripe, turbo.
  --tail <lines>       Number of matching records to print. Default: 200.
  --grep <query>       Filter records by text/source/level.
  --errors            Show likely errors and failures.
  --follow, -f         Keep printing new matching records.
  --log-file <path>    Read another Turbo log file. Default: ${DEFAULT_LOG_FILE}.

Examples:
  bun run dev:logs -- --source runner --tail 100
  bun run dev:logs -- --source web --grep ECONNREFUSED
  bun run dev:logs -- --errors --follow
`);
}
