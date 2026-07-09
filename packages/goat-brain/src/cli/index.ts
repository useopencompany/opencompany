#!/usr/bin/env bun
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkGoatBrainHealth,
  DEFAULT_GOAT_BRAIN_FOLDERS,
  DEFAULT_GOAT_BRAIN_RELATION_TYPE,
  defaultGoatBrainFolder,
  deterministicEvidenceId,
  formatGoatBrainEvidenceLink,
  GOAT_BRAIN_ENTITY_TYPES,
  GOAT_BRAIN_EVIDENCE_ZONE,
  type GoatBrainDocument,
  type GoatBrainKind,
  type GoatBrainRelation,
  type GoatBrainSource,
  goatBrainFolderKindError,
  goatBrainKindForFolder,
  goatBrainTimelineBody,
  goatBrainTimelineEntryFromParts,
  ingestGoatBrain,
  isBuiltInGoatBrainEntityType,
  isValidGoatBrainFolder,
  isValidGoatBrainId,
  isValidGoatBrainKind,
  isValidGoatBrainRelationType,
  normalizeBuiltInGoatBrainEntityType,
  normalizeEvidenceId,
  normalizeGoatBrainFolderForV1,
  normalizeGoatBrainId,
  nowIso,
  parseGoatBrainDocument,
  pathForGoatBrainDocument,
  queryGoatBrain,
  removeGoatBrainFile,
  resolveGoatBrainRoot,
  serializeGoatBrainDocument,
  validateGoatBrainDocument,
  writeGoatBrainDocumentText,
} from "../index";
import { createGateway } from "../retrieval/gateway";
import { loadProviders } from "../retrieval/providers";
import { findGoatBrainFile, listGoatBrainFiles } from "../store";
import { formatGoatBrainUsageReport, type GoatBrainUsageEntry } from "../usage";
import { parseArgs, readStdin } from "./args";
import { type CommandContext, type CommandResult, fail, notFound, ok, render } from "./io";

type Handler = (ctx: CommandContext) => Promise<CommandResult>;

const COMMANDS: Record<string, Handler> = {
  help: helpCommand,
  create,
  list,
  get,
  timeline,
  query,
  ingest,
  rewrite,
  set,
  "timeline-add": appendTimeline,
  "append-timeline": appendTimeline,
  "append-evidence": appendEvidence,
  alias,
  link,
  merge,
  move,
  delete: del,
  folder,
  doctor,
};

const GLOBAL_FLAGS = ["root", "json", "report-usage", "help"] as const;
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  help: [],
  create: [
    "folder",
    "id",
    "title",
    "type",
    "kind",
    "truth",
    "truth-stdin",
    "alias",
    "relation",
    "source-ref",
    "source-title",
    "evidence-id",
    "status",
  ],
  list: ["folder", "limit", "include-merged"],
  rewrite: ["id", "truth", "truth-stdin"],
  set: ["id", "title", "type", "status"],
  timeline: ["id", "limit", "since"],
  "timeline-add": [
    "id",
    "at",
    "body",
    "body-stdin",
    "detail",
    "detail-stdin",
    "source-ref",
    "source-title",
    "evidence-id",
  ],
  "append-timeline": [
    "id",
    "at",
    "body",
    "body-stdin",
    "detail",
    "detail-stdin",
    "source-ref",
    "source-title",
    "evidence-id",
  ],
  "append-evidence": [
    "id",
    "type",
    "folder",
    "at",
    "title",
    "body",
    "body-stdin",
    "detail",
    "detail-stdin",
    "source-ref",
    "source-title",
    "evidence-id",
    "relation",
  ],
  alias: ["id", "add", "remove"],
  link: ["id", "to", "as", "remove"],
  merge: ["from", "into"],
  move: ["id", "folder"],
  delete: ["id", "force", "dry-run"],
  folder: ["path"],
  doctor: [],
  get: ["id", "section"],
  ingest: ["text", "text-stdin", "source-ref", "source-title", "at", "dry-run", "model"],
  query: [
    "text",
    "folder",
    "since",
    "limit",
    "hops",
    "graph-direction",
    "lexical-only",
    "include-invalid",
    "include-merged",
    "include-archived",
  ],
};

export const HELP = `goat-brain - folder-first personal brain CLI

Usage: goat-brain <command> [options]
       goat-brain help [command]

Commands:
  help              Show global help or command-specific usage.
  create            Create a markdown brain doc in a folder.
  list              List brain docs without retrieval or model calls.
  ingest            Graph-first LLM ingest from source text.
  get               Read a doc by id (--section truth|timeline|frontmatter|all).
  timeline          Read dated evidence entries for a doc.
  query             Hybrid retrieval over docs (--folder, --since, --hops, --limit).
  rewrite           Replace compiled truth for a doc.
  set               Update a doc's title, type, or status.
  timeline-add      Add a dated evidence entry and optional source ref.
  append-timeline   Compatibility alias for timeline-add.
  append-evidence   Create a first-class evidence record and link it to a subject.
  alias             Add/remove aliases for a doc.
  link              Add/remove related edges.
  merge             Mark one doc as merged into another.
  move              Move a doc to another folder.
  delete            Delete a doc (--dry-run, --force).
  folder            folder list | folder create --path <folder>.
  doctor            Check validation, links, folder shape, and weak provenance.

Global options:
  --root <path>     Brain root (default: goat-brain; GOAT_BRAIN_ROOT pins it).
  --json            Machine-readable output.
  --help            Show help for a command.

Run "goat-brain help <command>" for command-specific examples.
`;

const COMMAND_HELP: Record<string, string> = {
  help: `Usage: goat-brain help [command]

Show global help or command-specific usage.

Examples:
  goat-brain help
  goat-brain help create
  goat-brain query --help`,
  create: `Usage: goat-brain create --type <type> --id <id> --title <title> (--truth <text> | --truth-stdin) [options]

Create a new Markdown brain document. Types classify documents; folders are free-form navigation.

Required:
  --type <type>       Entity type: ${GOAT_BRAIN_ENTITY_TYPES.join(", ")}.
  --id <id>           Lowercase brain slug.
  --title <title>     Human-readable title.
  --truth <text>      Compiled truth, or pass --truth-stdin and write truth to stdin.

Common options:
  --folder <path>     Any folder path. Defaults to the type's suggested folder.
                      "${GOAT_BRAIN_EVIDENCE_ZONE}/" is reserved for evidence documents.
  --kind <kind>       "page" (default) or "evidence". Evidence docs must live under
                      "${GOAT_BRAIN_EVIDENCE_ZONE}/"; inferred from --folder when omitted.
  --alias <text>      Repeatable alias.
  --relation <type:id>
  --source-ref <ref>  Provenance reference for the initial evidence entry.
  --json

Examples:
  goat-brain create --type company --folder companies --id opencompany --title OpenCompany --truth "OpenCompany builds agent infrastructure."
  goat-brain create --type person --folder team/gtm --id ada --title Ada --truth "Ada leads GTM."
  goat-brain create --type source --kind evidence --id ev-acme-email --title "Acme email" --truth "Acme asked for pricing."`,
  list: `Usage: goat-brain list [--folder <path>] [--limit <n>] [--include-merged] [--json]

List existing brain docs without retrieval or model calls.

Examples:
  goat-brain list
  goat-brain list --folder projects --limit 20 --json`,
  get: `Usage: goat-brain get <id> [--section all|truth|timeline|frontmatter] [--json]

Read a known brain document by id.

Examples:
  goat-brain get opencompany
  goat-brain get opencompany --section truth
  goat-brain get opencompany --section timeline --json`,
  timeline: `Usage: goat-brain timeline <id> [--since <duration-or-iso>] [--limit <n>] [--json]

Read dated evidence entries for a document. Relative --since values use m, h, d, or w.

Examples:
  goat-brain timeline opencompany
  goat-brain timeline opencompany --since 30d --limit 10 --json`,
  query: `Usage: goat-brain query <text> [options]
       goat-brain query --text <text> [options]

Search and retrieve relevant brain docs. Use list for inventory/enumeration instead of wildcard queries.
Merged and archived docs are excluded unless explicitly included.

Options:
  --folder <path>
  --since <duration-or-iso>
  --limit <n>
  --hops <n>
  --graph-direction out|in|both
  --lexical-only
  --include-invalid
  --include-merged
  --include-archived
  --json

Examples:
  goat-brain query "hiring plan" --limit 5
  goat-brain query --text "Ada launch sequencing" --hops 2 --graph-direction both --json`,
  ingest: `Usage: goat-brain ingest (--text <text> | --text-stdin) --source-ref <ref> [options]

Use the LLM ingest pipeline to plan graph-first brain changes from source text.

Required:
  --source-ref <ref>  Stable provenance reference.
  --text <text>       Source text, or pass --text-stdin and write text to stdin.

Options:
  --source-title <title>
  --at <iso-date>
  --dry-run
  --model <gateway-model>
  --json

Example:
  cat note.md | goat-brain ingest --text-stdin --source-ref chat:message_123 --source-title "Chat note" --dry-run`,
  rewrite: `Usage: goat-brain rewrite <id> (--truth <text> | --truth-stdin) [--json]

Replace the compiled truth section for a document.

Examples:
  goat-brain rewrite opencompany --truth "OpenCompany builds company-owned AI agents."
  cat truth.md | goat-brain rewrite opencompany --truth-stdin --json`,
  set: `Usage: goat-brain set <id> [--title <title>] [--type <type>] [--status <status>] [--json]

Update frontmatter fields for an existing document. Provide at least one of
--title, --type, or --status. Promoting a page to --status active requires its
compiled truth to cite evidence with [[evidence:<evidence-id>]].

Options:
  --title <title>     New human-readable title.
  --type <type>       Entity type: ${GOAT_BRAIN_ENTITY_TYPES.join(", ")}.
  --status <status>   draft, active, archived, or merged.

Examples:
  goat-brain set quick-note --title "Pricing idea" --type concept
  goat-brain set pricing-idea --status active`,
  "timeline-add": `Usage: goat-brain timeline-add <id> [--at <iso-date>] (--body <text> | --body-stdin) [options]

Add a dated evidence entry to a document.

Options:
  --detail <text> or --detail-stdin
  --source-ref <ref>
  --source-title <title>
  --evidence-id <id>
  --json

Examples:
  goat-brain timeline-add opencompany --body "User said OpenCompany is hiring."
  goat-brain timeline-add opencompany --at 2026-07-06 --body "Met Ada." --source-ref chat:message_123`,
  "append-timeline": `Usage: goat-brain append-timeline <id> [--at <iso-date>] (--body <text> | --body-stdin) [options]

Compatibility alias for timeline-add.

Example:
  goat-brain append-timeline opencompany --body "Updated launch plan."`,
  "append-evidence": `Usage: goat-brain append-evidence <subject-id> --source-ref <ref> [--at <iso-date>] (--body <text> | --body-stdin) [options]

Create an immutable evidence record in the ${GOAT_BRAIN_EVIDENCE_ZONE}/ zone and link it to the subject document.

Options:
  --type <type>        Entity type for the record. Defaults to source.
  --folder <path>      Folder inside "${GOAT_BRAIN_EVIDENCE_ZONE}/". Defaults to "${GOAT_BRAIN_EVIDENCE_ZONE}".
  --title <title>
  --detail <text> or --detail-stdin
  --source-title <title>
  --evidence-id <id>   Optional ev-* record id. Generated when omitted.
  --relation <type>    Relation from evidence to subject. Defaults to about.
  --json

Example:
  goat-brain append-evidence opencompany --type source --body "Acme asked for pricing." --source-ref gmail:thread_123`,
  alias: `Usage: goat-brain alias <id> [--add <alias>] [--remove <alias>] [--json]

Add or remove aliases for a document. Repeat --add or --remove as needed.

Example:
  goat-brain alias opencompany --add OC --add "Open Company" --json`,
  link: `Usage: goat-brain link <id> [--to <target-id>] [--as <relation>] [--remove <target-id>] [--json]

Add or remove related edges from one document to another.

Examples:
  goat-brain link launch-plan --to ada --as owner
  goat-brain link launch-plan --remove old-owner --json`,
  merge: `Usage: goat-brain merge --from <id> --into <id> [--json]
       goat-brain merge <from-id> <into-id> [--json]

Mark one document as merged into another.

Example:
  goat-brain merge --from acme-old --into acme`,
  move: `Usage: goat-brain move <id> --folder <path> [--json]

Move a document to a different folder. Evidence documents stay inside "${GOAT_BRAIN_EVIDENCE_ZONE}/"; pages stay outside it.

Example:
  goat-brain move launch-plan --folder projects/launch`,
  delete: `Usage: goat-brain delete <id> --dry-run
       goat-brain delete <id> --force

Preview or delete a document. In chat, deletes should use --dry-run only.

Examples:
  goat-brain delete old-note --dry-run
  goat-brain delete old-note --force`,
  folder: `Usage: goat-brain folder list [--json]
       goat-brain folder create --path <folder> [--json]

List folders in use or validate a new free-form folder path.

Examples:
  goat-brain folder list
  goat-brain folder create --path projects/launch`,
  doctor: `Usage: goat-brain doctor [--json]

Check validation, links, folder shape, and weak provenance.

Example:
  goat-brain doctor --json`,
};

export function commandHelp(commandName: string): string {
  return COMMAND_HELP[commandName] ?? HELP;
}

export function helpResult(message: string, commandName?: string): CommandResult {
  const help = commandName ? commandHelp(commandName) : HELP;
  return fail(`${message}\n\n${help}`, 1, { help });
}

export function validateCommandArgs(commandName: string, args: ReturnType<typeof parseArgs>) {
  const allowed = Object.hasOwn(COMMAND_FLAGS, commandName)
    ? COMMAND_FLAGS[commandName]
    : undefined;
  if (!allowed) return null;
  const allowedSet = new Set([...GLOBAL_FLAGS, ...allowed]);
  const unknown = args.names().find((name) => !allowedSet.has(name));
  return unknown ? `Unknown option "--${unknown}".` : null;
}

async function helpCommand(ctx: CommandContext): Promise<CommandResult> {
  const commandName = ctx.args.positionals[0];
  if (!commandName) return ok(HELP, { help: HELP });
  if (!Object.hasOwn(COMMANDS, commandName)) {
    return helpResult(`Unknown command "${commandName}".`);
  }
  const help = commandHelp(commandName);
  return ok(help, { command: commandName, help });
}

async function create(ctx: CommandContext): Promise<CommandResult> {
  const typeInput = ctx.args.get("type")?.trim();
  if (!typeInput) {
    return fail(`\`--type\` is required. Use one of: ${GOAT_BRAIN_ENTITY_TYPES.join(", ")}.`);
  }
  if (!isBuiltInGoatBrainEntityType(typeInput)) {
    return fail(
      `Unsupported Goat Brain entity type "${typeInput}". Use one of: ${GOAT_BRAIN_ENTITY_TYPES.join(
        ", ",
      )}.`,
    );
  }
  const kindInput = ctx.args.get("kind")?.trim();
  if (kindInput && !isValidGoatBrainKind(kindInput)) {
    return fail('`--kind` must be "page" or "evidence".');
  }
  const folderInput = ctx.args.get("folder")?.trim();
  const kind: GoatBrainKind =
    kindInput && isValidGoatBrainKind(kindInput)
      ? kindInput
      : folderInput
        ? goatBrainKindForFolder(folderInput)
        : "page";
  const folder = normalizeGoatBrainFolderForV1(
    folderInput ?? defaultGoatBrainFolder(typeInput, kind),
  );
  if (!isValidGoatBrainFolder(folder)) return fail("`--folder` must be a safe folder path.");
  const folderKindError = goatBrainFolderKindError(folder, kind);
  if (folderKindError) {
    return fail(`\`--folder\` "${folder}" does not match kind "${kind}". ${folderKindError}`);
  }
  const rawId = ctx.args.get("id") ?? ctx.args.get("title") ?? "untitled";
  const id = normalizeGoatBrainId(rawId);
  if (!isValidGoatBrainId(id)) return fail("`--id` must resolve to a lowercase slug.");
  if (await findGoatBrainFile(ctx.root, id))
    return fail(`A brain doc with id "${id}" already exists.`);

  const now = nowIso();
  const title = ctx.args.get("title")?.trim() || titleFromId(id);
  const type = typeInput;
  const status = ctx.args.get("status")?.trim() ?? "draft";
  if (status !== "draft" && status !== "active" && status !== "archived" && status !== "merged") {
    return fail("`--status` must be draft, active, archived, or merged.");
  }
  const truth = (
    ctx.args.has("truth-stdin") ? await readStdin() : (ctx.args.get("truth") ?? "")
  ).trim();
  if (!truth) return fail("`--truth` or `--truth-stdin` is required.");
  const relations = readRelations(ctx.args.getAll("relation"));
  if (!relations.ok) return fail(relations.error);
  const sourceRef = ctx.args.get("source-ref")?.trim();
  const sourceTitle = ctx.args.get("source-title")?.trim();
  const evidenceId = ctx.args.get("evidence-id")?.trim();
  const evidenceEntry = sourceRef
    ? goatBrainTimelineEntryFromParts({
        at: now,
        summary: `Created ${title}.`,
        sourceRef,
        sourceTitle: sourceTitle ?? "",
        ...(evidenceId ? { evidenceId } : {}),
      })
    : null;
  const possibleDuplicates = await findPossibleDuplicates(ctx.root, {
    id,
    title,
    truth,
  });
  const doc: GoatBrainDocument = {
    frontmatter: {
      id,
      folder,
      kind,
      type,
      status,
      title,
      createdAt: now,
      updatedAt: now,
      relations: relations.value,
      ...(ctx.args.getAll("alias").length > 0 ? { aliases: ctx.args.getAll("alias") } : {}),
      ...(sourceRef
        ? {
            sources: [
              {
                ref: sourceRef,
                capturedAt: now,
                ...(sourceTitle ? { title: sourceTitle } : {}),
              },
            ],
          }
        : {}),
    },
    title,
    compiledTruth: truth,
    timeline: evidenceEntry ? [evidenceEntry] : [],
  };
  const relativePath = await persist(ctx.root, doc);
  return ok(`Created "${id}" at ${relativePath}.`, {
    id,
    folder,
    path: relativePath,
    ...(evidenceEntry ? { evidenceId: evidenceEntry.evidenceId } : {}),
    ...(possibleDuplicates.length > 0 ? { warnings: { possibleDuplicates } } : {}),
  });
}

async function get(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.positionals[0] ?? ctx.args.get("id");
  if (!id) return fail("Provide a brain id.");
  const loaded = await loadDoc(ctx.root, id);
  if (!loaded) return notFound(`No brain doc found with id "${id}".`);
  const { file, doc } = loaded;
  const section = ctx.args.get("section") ?? "all";
  if (!["all", "frontmatter", "truth", "timeline"].includes(section)) {
    return fail("`--section` must be all, frontmatter, truth, or timeline.");
  }
  if (section === "frontmatter") {
    return ok(JSON.stringify(doc.frontmatter, null, 2), {
      id: file.id,
      path: file.relativePath,
      frontmatter: doc.frontmatter,
    });
  }
  if (section === "truth") {
    return ok(doc.compiledTruth || "_No compiled truth yet._", {
      id: file.id,
      path: file.relativePath,
      compiledTruth: doc.compiledTruth,
    });
  }
  if (section === "timeline") {
    const text = doc.timeline.length
      ? doc.timeline.map((entry) => `### ${entry.at}\n${entry.body}`).join("\n\n")
      : "_No timeline yet._";
    return ok(text, {
      id: file.id,
      path: file.relativePath,
      timeline: doc.timeline,
    });
  }
  return ok(file.source, { id: file.id, path: file.relativePath, doc });
}

async function list(ctx: CommandContext): Promise<CommandResult> {
  const folderInput = ctx.args.get("folder");
  const folder = folderInput ? normalizeGoatBrainFolderForV1(folderInput) : null;
  if (folderInput && !isValidGoatBrainFolder(folder ?? "")) {
    return fail("`--folder` must be a safe folder path.");
  }

  const limit = Math.max(1, ctx.args.number("limit") ?? Number.POSITIVE_INFINITY);
  const docs = (
    await Promise.all(
      (
        await listGoatBrainFiles(ctx.root)
      ).map(async (file) => {
        try {
          const doc = parseGoatBrainDocument(file.source);
          const folderPath = doc.frontmatter.folder;
          if (
            !folderPath ||
            (folder && folderPath !== folder && !folderPath.startsWith(`${folder}/`))
          ) {
            return null;
          }
          if (!ctx.args.has("include-merged") && doc.frontmatter.status === "merged") return null;
          const type = isBuiltInGoatBrainEntityType(doc.frontmatter.type)
            ? doc.frontmatter.type
            : null;
          if (!type) return null;
          return {
            id: file.id,
            path: file.relativePath,
            folder: folderPath,
            title: doc.frontmatter.title ?? doc.title ?? file.id,
            type,
            updatedAt: doc.frontmatter.updatedAt ?? "",
          };
        } catch {
          return null;
        }
      }),
    )
  )
    .filter((doc): doc is NonNullable<typeof doc> => doc !== null)
    .sort((a, b) => {
      const updated = b.updatedAt.localeCompare(a.updatedAt);
      return updated !== 0 ? updated : a.path.localeCompare(b.path);
    })
    .slice(0, limit);

  const rendered = docs.length
    ? docs
        .map(
          (doc) =>
            `[${doc.folder}] ${doc.title} (${doc.id}, updated ${doc.updatedAt || "unknown"})`,
        )
        .join("\n")
    : "No brain docs found.";
  return ok(rendered, { count: docs.length, docs });
}

async function timeline(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.positionals[0] ?? ctx.args.get("id");
  if (!id) return fail("Provide a brain id.");
  const loaded = await loadDoc(ctx.root, id);
  if (!loaded) return notFound(`No brain doc found with id "${id}".`);
  const sinceInput = ctx.args.get("since");
  const since = sinceInput ? resolveSince(sinceInput) : undefined;
  if (sinceInput && !since) {
    return fail(`Invalid --since value "${sinceInput}". Use 30m, 24h, 7d, 2w, or ISO-8601.`);
  }
  const limit = Math.max(1, ctx.args.number("limit") ?? 100);
  const entries = sortedTimelineEntries(loaded.doc.timeline)
    .filter((entry) => !since || entry.at >= since)
    .slice(0, limit);
  const text = entries.length
    ? entries.map((entry) => `### ${entry.at}\n${entry.body}`).join("\n\n")
    : "_No timeline yet._";
  return ok(text, {
    id: loaded.file.id,
    path: loaded.file.relativePath,
    timeline: entries,
  });
}

async function query(ctx: CommandContext): Promise<CommandResult> {
  const text = (ctx.args.get("text") ?? ctx.args.positionals.join(" ")).trim();
  const usage: GoatBrainUsageEntry[] = [];
  const providers = ctx.args.has("lexical-only")
    ? {}
    : await loadProviders(process.env, (entry) => usage.push(entry));
  const sinceInput = ctx.args.get("since");
  const since = sinceInput ? resolveSince(sinceInput) : undefined;
  if (sinceInput && !since) {
    return fail(`Invalid --since value "${sinceInput}". Use 30m, 24h, 7d, 2w, or ISO-8601.`);
  }
  const graphDirectionInput = ctx.args.get("graph-direction");
  const graphDirection = readGraphDirection(graphDirectionInput);
  if (graphDirectionInput && !graphDirection) {
    return fail('Invalid --graph-direction value. Use "out", "in", or "both".');
  }
  const hits = await queryGoatBrain(
    ctx.root,
    {
      text,
      ...(ctx.args.get("folder")
        ? { folder: normalizeGoatBrainFolderForV1(ctx.args.get("folder") ?? "") }
        : {}),
      ...(since ? { since } : {}),
      ...(ctx.args.number("hops") !== undefined
        ? { hops: Math.max(0, ctx.args.number("hops") ?? 0) }
        : {}),
      ...(graphDirection ? { graphDirection } : {}),
      limit: ctx.args.number("limit") ?? 10,
      lexicalOnly: ctx.args.has("lexical-only"),
      ...(ctx.args.has("include-invalid") ? { includeInvalid: true } : {}),
      ...(ctx.args.has("include-merged") ? { includeMerged: true } : {}),
      ...(ctx.args.has("include-archived") ? { includeArchived: true } : {}),
    },
    providers,
  );
  const rendered = hits.length
    ? hits
        .map(
          (hit, index) =>
            `${index + 1}. [${hit.folder}] ${hit.title} (${hit.id}, score ${hit.score}, updated ${hit.updatedAt})\n${hit.snippet}\nNext: goat-brain get ${hit.id}`,
        )
        .join("\n\n")
    : "No matching brain docs found.";
  return { ...ok(rendered, { count: hits.length, hits }), usage };
}

async function ingest(ctx: CommandContext): Promise<CommandResult> {
  const text = (
    ctx.args.has("text-stdin") ? await readStdin() : (ctx.args.get("text") ?? "")
  ).trim();
  if (!text) return fail("`--text` or `--text-stdin` is required.");
  const sourceRef = ctx.args.get("source-ref")?.trim();
  if (!sourceRef) return fail("`--source-ref` is required.");
  const apiKey = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
  if (!apiKey) return fail("VERCEL_AI_GATEWAY_API_KEY is required for ingest.");
  const usage: GoatBrainUsageEntry[] = [];
  const gateway = createGateway({
    apiKey,
    ...(process.env.GOAT_BRAIN_GATEWAY_BASE_URL
      ? { baseUrl: process.env.GOAT_BRAIN_GATEWAY_BASE_URL }
      : {}),
    chatModel:
      ctx.args.get("model")?.trim() ||
      process.env.GOAT_BRAIN_INGEST_MODEL?.trim() ||
      "openai/gpt-5.5",
    onUsage: (entry) => usage.push(entry),
  });
  const sourceTitle = ctx.args.get("source-title")?.trim();
  const at = ctx.args.get("at")?.trim();
  const result = await ingestGoatBrain(
    ctx.root,
    {
      text,
      sourceRef,
      ...(sourceTitle ? { sourceTitle } : {}),
      ...(at ? { at } : {}),
      ...(ctx.args.has("dry-run") ? { dryRun: true } : {}),
    },
    gateway,
  );
  const rendered = result.dryRun
    ? `Dry run planned ${result.plan.length} brain change(s).`
    : result.failed.length > 0
      ? `Ingested ${result.applied.length} brain change(s); ${result.failed.length} failed.`
      : `Ingested ${result.applied.length} brain change(s).`;
  return {
    ...ok(rendered, result),
    usage,
    code: ingestCommandExitCode(result),
  };
}

export function ingestCommandExitCode(result: {
  applied: Array<{ id: string }>;
  failed?: unknown[];
  health: {
    findings: Array<{ severity: "error" | "warn"; id: string }>;
  } | null;
}): number {
  if (result.failed && result.failed.length > 0) return 1;
  if (!result.health) return 0;
  const appliedIds = new Set(result.applied.map((change) => change.id));
  return result.health.findings.some(
    (finding) => finding.severity === "error" && appliedIds.has(finding.id),
  )
    ? 1
    : 0;
}

async function rewrite(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.positionals[0] ?? ctx.args.get("id");
  if (!id) return fail("Provide a brain id.");
  const loaded = await loadDoc(ctx.root, id);
  if (!loaded) return notFound(`No brain doc found with id "${id}".`);
  const truth = (
    ctx.args.has("truth-stdin") ? await readStdin() : (ctx.args.get("truth") ?? "")
  ).trim();
  if (!truth) return fail("`--truth` or `--truth-stdin` is required.");
  loaded.doc.compiledTruth = truth;
  loaded.doc.frontmatter.updatedAt = nowIso();
  const relativePath = await persist(ctx.root, loaded.doc);
  return ok(`Rewrote compiled truth for "${id}".`, { id, path: relativePath });
}

async function set(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.positionals[0] ?? ctx.args.get("id");
  if (!id) return fail("Provide a brain id.");
  const title = ctx.args.get("title")?.trim();
  const typeInput = ctx.args.get("type")?.trim();
  const statusInput = ctx.args.get("status")?.trim();
  if (!title && !typeInput && !statusInput) {
    return fail("Provide at least one of `--title`, `--type`, or `--status`.");
  }
  const type = typeInput ? normalizeBuiltInGoatBrainEntityType(typeInput) : undefined;
  if (typeInput && !type) {
    return fail(
      `Unsupported Goat Brain entity type "${typeInput}". Use one of: ${GOAT_BRAIN_ENTITY_TYPES.join(
        ", ",
      )}.`,
    );
  }
  const status =
    statusInput === "draft" || statusInput === "active" || statusInput === "archived"
      ? statusInput
      : undefined;
  if (statusInput && !status) {
    return fail(
      "`--status` must be draft, active, or archived. Use the merge command to mark a doc merged.",
    );
  }
  const loaded = await loadDoc(ctx.root, id);
  if (!loaded) return notFound(`No brain doc found with id "${id}".`);
  if (loaded.doc.frontmatter.status === "merged") {
    return fail(`"${id}" is merged into "${loaded.doc.frontmatter.mergedInto ?? "?"}".`);
  }
  if (title) {
    loaded.doc.title = title;
    loaded.doc.frontmatter.title = title;
  }
  if (type) loaded.doc.frontmatter.type = type;
  if (status) loaded.doc.frontmatter.status = status;
  loaded.doc.frontmatter.updatedAt = nowIso();
  const relativePath = await persist(ctx.root, loaded.doc);
  return ok(`Updated "${id}".`, {
    id,
    path: relativePath,
    title: loaded.doc.frontmatter.title,
    type: loaded.doc.frontmatter.type,
    status: loaded.doc.frontmatter.status,
  });
}

async function appendTimeline(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.positionals[0] ?? ctx.args.get("id");
  if (!id) return fail("Provide a brain id.");
  const loaded = await loadDoc(ctx.root, id);
  if (!loaded) return notFound(`No brain doc found with id "${id}".`);
  if (ctx.args.has("body-stdin") && ctx.args.has("detail-stdin")) {
    return fail("Use only one stdin flag: `--body-stdin` or `--detail-stdin`.");
  }
  const summary = (
    ctx.args.has("body-stdin")
      ? await readStdin()
      : (ctx.args.get("body") ?? ctx.args.positionals.slice(2).join(" "))
  ).trim();
  if (!summary) return fail("`--body` or `--body-stdin` is required.");
  const detail = (
    ctx.args.has("detail-stdin") ? await readStdin() : (ctx.args.get("detail") ?? "")
  ).trim();
  const at = ctx.args.get("at") ?? ctx.args.positionals[1] ?? nowIso();
  const parsedAt = Date.parse(at);
  if (Number.isNaN(parsedAt)) return fail("`--at` must be an ISO-8601 timestamp.");
  const entryAt = new Date(parsedAt).toISOString();
  const evidenceId = ctx.args.get("evidence-id")?.trim();
  const entry = goatBrainTimelineEntryFromParts({
    at: entryAt,
    summary,
    detail,
    sourceRef: ctx.args.get("source-ref")?.trim() ?? "",
    sourceTitle: ctx.args.get("source-title")?.trim() ?? "",
    ...(evidenceId ? { evidenceId } : {}),
  });
  loaded.doc.timeline.push(entry);
  loaded.doc.frontmatter.updatedAt = nowIso();
  const sourceRef = ctx.args.get("source-ref")?.trim();
  if (sourceRef) {
    const sources = loaded.doc.frontmatter.sources ?? [];
    const source: GoatBrainSource = {
      ref: sourceRef,
      capturedAt: entryAt,
    };
    const sourceTitle = ctx.args.get("source-title")?.trim();
    if (sourceTitle) source.title = sourceTitle;
    sources.push(source);
    loaded.doc.frontmatter.sources = sources;
  }
  const relativePath = await persist(ctx.root, loaded.doc);
  return ok(`Appended timeline entry to "${id}".`, {
    id,
    path: relativePath,
    evidenceId: entry.evidenceId,
  });
}

async function appendEvidence(ctx: CommandContext): Promise<CommandResult> {
  const subjectId = ctx.args.positionals[0] ?? ctx.args.get("id");
  if (!subjectId) return fail("Provide a subject brain id.");
  if (!isValidGoatBrainId(subjectId)) return fail("Subject id must be a lowercase brain slug.");
  const typeInput = ctx.args.get("type")?.trim() || "source";
  if (!isBuiltInGoatBrainEntityType(typeInput)) {
    return fail(
      `Unsupported Goat Brain entity type "${typeInput}". Use one of: ${GOAT_BRAIN_ENTITY_TYPES.join(", ")}.`,
    );
  }
  const folder = normalizeGoatBrainFolderForV1(
    ctx.args.get("folder")?.trim() || GOAT_BRAIN_EVIDENCE_ZONE,
  );
  if (!isValidGoatBrainFolder(folder)) return fail("`--folder` must be a safe folder path.");
  const folderKindError = goatBrainFolderKindError(folder, "evidence");
  if (folderKindError) return fail(`\`--folder\` "${folder}" is invalid. ${folderKindError}`);
  const subject = await loadDoc(ctx.root, subjectId);
  if (!subject) return notFound(`No brain doc found with id "${subjectId}".`);
  if (ctx.args.has("body-stdin") && ctx.args.has("detail-stdin")) {
    return fail("Use only one stdin flag: `--body-stdin` or `--detail-stdin`.");
  }

  const summary = (
    ctx.args.has("body-stdin")
      ? await readStdin()
      : (ctx.args.get("body") ?? ctx.args.positionals.slice(2).join(" "))
  ).trim();
  if (!summary) return fail("`--body` or `--body-stdin` is required.");
  const sourceRef = ctx.args.get("source-ref")?.trim();
  if (!sourceRef) return fail("`--source-ref` is required for evidence records.");
  const detail = (
    ctx.args.has("detail-stdin") ? await readStdin() : (ctx.args.get("detail") ?? "")
  ).trim();
  const at = ctx.args.get("at") ?? ctx.args.positionals[1] ?? nowIso();
  const parsedAt = Date.parse(at);
  if (Number.isNaN(parsedAt)) return fail("`--at` must be an ISO-8601 timestamp.");
  const capturedAt = new Date(parsedAt).toISOString();
  const evidenceIdInput = ctx.args.get("evidence-id")?.trim();
  const evidenceId = evidenceIdInput
    ? normalizeEvidenceRecordId(evidenceIdInput)
    : deterministicEvidenceId({ at: capturedAt, summary, sourceRef });
  if (!evidenceId) return fail("`--evidence-id` must be a valid ev-* brain id.");
  if (await findGoatBrainFile(ctx.root, evidenceId)) {
    return fail(`A brain doc with id "${evidenceId}" already exists.`);
  }
  const sourceTitle = ctx.args.get("source-title")?.trim();
  const title = ctx.args.get("title")?.trim() || evidenceTitle(sourceTitle, summary);
  const evidenceBody = goatBrainTimelineBody({
    summary,
    detail,
    sourceRef,
    sourceTitle: sourceTitle ?? "",
  });
  const evidenceDoc: GoatBrainDocument = {
    frontmatter: {
      id: evidenceId,
      folder,
      kind: "evidence",
      type: typeInput,
      status: "active",
      title,
      createdAt: capturedAt,
      updatedAt: capturedAt,
      relations: [{ type: ctx.args.get("relation")?.trim() || "about", to: subjectId }],
      sources: [
        {
          ref: sourceRef,
          capturedAt,
          ...(sourceTitle ? { title: sourceTitle } : {}),
        },
      ],
    },
    title,
    compiledTruth: evidenceBody,
    timeline: [],
  };

  subject.doc.frontmatter.updatedAt = nowIso();
  const timelineEntry = goatBrainTimelineEntryFromParts({
    evidenceId,
    at: capturedAt,
    summary: `${formatGoatBrainEvidenceLink(evidenceId, title)}: ${summary}`,
    detail,
    sourceRef,
    sourceTitle: sourceTitle ?? "",
  });
  if (!subject.doc.timeline.some((entry) => entry.evidenceId === evidenceId)) {
    subject.doc.timeline = [...subject.doc.timeline, timelineEntry];
  }

  const evidencePath = await persist(ctx.root, evidenceDoc);
  const subjectPath = await persist(ctx.root, subject.doc);
  return ok(`Created evidence "${evidenceId}" and linked it to "${subjectId}".`, {
    id: subjectId,
    path: subjectPath,
    evidenceId,
    evidencePath,
  });
}

function sortedTimelineEntries(entries: GoatBrainDocument["timeline"]) {
  return [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

function normalizeEvidenceRecordId(value: string | undefined): string | null {
  if (!value) return null;
  return normalizeEvidenceId(value);
}

function evidenceTitle(sourceTitle: string | undefined, summary: string) {
  if (sourceTitle?.trim()) return sourceTitle.trim();
  const clipped = summary.replace(/\s+/g, " ").trim().slice(0, 80);
  return clipped ? `Evidence: ${clipped}` : "Evidence";
}

async function alias(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.positionals[0] ?? ctx.args.get("id");
  if (!id) return fail("Provide a brain id.");
  const loaded = await loadDoc(ctx.root, id);
  if (!loaded) return notFound(`No brain doc found with id "${id}".`);
  const aliases = new Set(loaded.doc.frontmatter.aliases ?? []);
  for (const value of ctx.args.getAll("remove")) aliases.delete(value.trim());
  for (const value of ctx.args.getAll("add")) {
    const alias = value.trim();
    if (alias) aliases.add(alias);
  }
  loaded.doc.frontmatter.aliases = [...aliases].sort((a, b) => a.localeCompare(b));
  loaded.doc.frontmatter.updatedAt = nowIso();
  const relativePath = await persist(ctx.root, loaded.doc);
  return ok(`Updated aliases for "${id}".`, {
    id,
    path: relativePath,
    aliases: loaded.doc.frontmatter.aliases,
  });
}

async function link(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.positionals[0] ?? ctx.args.get("id");
  if (!id) return fail("Provide a brain id.");
  const loaded = await loadDoc(ctx.root, id);
  if (!loaded) return notFound(`No brain doc found with id "${id}".`);
  const remove = new Set(ctx.args.getAll("remove"));
  const relationType = ctx.args.get("as") ?? DEFAULT_GOAT_BRAIN_RELATION_TYPE;
  if (!isValidGoatBrainRelationType(relationType))
    return fail("`--as` must be a lowercase relation type.");
  const byKey = new Map(
    (loaded.doc.frontmatter.relations ?? []).map((relation) => [relationKey(relation), relation]),
  );
  for (const target of remove) {
    if (!isValidGoatBrainId(target)) return fail(`Invalid related id "${target}".`);
    for (const key of [...byKey.keys()]) {
      if (key.endsWith(`:${target}`)) byKey.delete(key);
    }
  }
  for (const target of ctx.args.getAll("to")) {
    if (!isValidGoatBrainId(target)) return fail(`Invalid related id "${target}".`);
    byKey.set(relationKey({ type: relationType, to: target }), {
      type: relationType,
      to: target,
    });
  }
  loaded.doc.frontmatter.relations = [...byKey.values()].sort((a, b) =>
    relationKey(a).localeCompare(relationKey(b)),
  );
  loaded.doc.frontmatter.updatedAt = nowIso();
  const relativePath = await persist(ctx.root, loaded.doc);
  return ok(`Updated related links for "${id}".`, {
    id,
    path: relativePath,
    relations: loaded.doc.frontmatter.relations,
  });
}

async function merge(ctx: CommandContext): Promise<CommandResult> {
  const from = ctx.args.get("from") ?? ctx.args.positionals[0];
  const into = ctx.args.get("into") ?? ctx.args.positionals[1];
  if (!from || !into) return fail("Provide --from and --into brain ids.");
  if (!isValidGoatBrainId(from) || !isValidGoatBrainId(into)) {
    return fail("Merge ids must be lowercase brain slugs.");
  }
  if (from === into) return fail("Cannot merge a brain doc into itself.");
  const source = await loadDoc(ctx.root, from);
  if (!source) return notFound(`No brain doc found with id "${from}".`);
  const target = await loadDoc(ctx.root, into);
  if (!target) return notFound(`No brain doc found with id "${into}".`);

  const targetAliases = new Set(target.doc.frontmatter.aliases ?? []);
  if (source.doc.title) targetAliases.add(source.doc.title);
  for (const alias of source.doc.frontmatter.aliases ?? []) targetAliases.add(alias);
  target.doc.frontmatter.aliases = [...targetAliases].sort((a, b) => a.localeCompare(b));
  target.doc.frontmatter.updatedAt = nowIso();

  const sourceRelations = new Map(
    (source.doc.frontmatter.relations ?? []).map((relation) => [relationKey(relation), relation]),
  );
  sourceRelations.set(relationKey({ type: "merged_into", to: into }), {
    type: "merged_into",
    to: into,
  });
  source.doc.frontmatter.relations = [...sourceRelations.values()].sort((a, b) =>
    relationKey(a).localeCompare(relationKey(b)),
  );
  source.doc.frontmatter.status = "merged";
  source.doc.frontmatter.mergedInto = into;
  source.doc.frontmatter.updatedAt = nowIso();

  const targetPath = await persist(ctx.root, target.doc);
  const sourcePath = await persist(ctx.root, source.doc);
  return ok(`Marked "${from}" as merged into "${into}".`, {
    from,
    into,
    sourcePath,
    targetPath,
  });
}

async function move(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.positionals[0] ?? ctx.args.get("id");
  const folder = normalizeGoatBrainFolderForV1(ctx.args.get("folder") ?? "");
  if (!id) return fail("Provide a brain id.");
  if (!isValidGoatBrainFolder(folder)) return fail("`--folder` must be a safe folder path.");
  const loaded = await loadDoc(ctx.root, id);
  if (!loaded) return notFound(`No brain doc found with id "${id}".`);
  const kind = loaded.doc.frontmatter.kind;
  if (!isValidGoatBrainKind(kind)) {
    return fail(`Cannot move "${id}" because frontmatter.kind is missing or invalid.`);
  }
  const folderKindError = goatBrainFolderKindError(folder, kind);
  if (folderKindError) {
    return fail(`\`--folder\` "${folder}" does not match kind "${kind}". ${folderKindError}`);
  }
  const oldPath = loaded.file.relativePath;
  loaded.doc.frontmatter.folder = folder;
  loaded.doc.frontmatter.updatedAt = nowIso();
  const newPath = await persist(ctx.root, loaded.doc);
  if (newPath !== oldPath) await removeGoatBrainFile(ctx.root, oldPath);
  return ok(`Moved "${id}" to ${folder}.`, { id, path: newPath, oldPath });
}

async function del(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.positionals[0] ?? ctx.args.get("id");
  if (!id) return fail("Provide a brain id.");
  const file = await findGoatBrainFile(ctx.root, id);
  if (!file) return notFound(`No brain doc found with id "${id}".`);
  if (ctx.args.has("dry-run"))
    return ok(`Would delete "${id}" at ${file.relativePath}.`, {
      id,
      path: file.relativePath,
    });
  if (!ctx.args.has("force")) return fail("Deletion requires --force.");
  await removeGoatBrainFile(ctx.root, file.relativePath);
  return ok(`Deleted "${id}".`, { id, path: file.relativePath });
}

async function folder(ctx: CommandContext): Promise<CommandResult> {
  const subcommand = ctx.args.positionals[0] ?? "list";
  if (subcommand === "list") {
    const files = await listGoatBrainFiles(ctx.root);
    const folders = new Set<string>(DEFAULT_GOAT_BRAIN_FOLDERS);
    for (const file of files) {
      const doc = parseGoatBrainDocument(file.source);
      if (doc.frontmatter.folder) folders.add(doc.frontmatter.folder);
    }
    const values = [...folders].sort();
    return ok(values.join("\n"), { folders: values });
  }
  if (subcommand === "create") {
    const folderPath = normalizeGoatBrainFolderForV1(ctx.args.get("path") ?? "");
    if (!isValidGoatBrainFolder(folderPath)) return fail("`--path` must be a safe folder path.");
    return ok(`Folder "${folderPath}" is available.`, { folder: folderPath });
  }
  return fail('folder command must be "list" or "create".');
}

async function doctor(ctx: CommandContext): Promise<CommandResult> {
  const report = await checkGoatBrainHealth(ctx.root);
  const summary = `${report.files} files checked - ${report.errors} error(s), ${report.warnings} warning(s).`;
  const text = [
    summary,
    ...report.findings.map(
      (finding) =>
        `${finding.severity.toUpperCase()} ${finding.code} ${finding.id}: ${finding.message}`,
    ),
  ].join("\n");
  return {
    ...ok(text, {
      files: report.files,
      errors: report.errors,
      warnings: report.warnings,
      findings: report.findings,
    }),
    code: report.errors > 0 ? 1 : 0,
  };
}

async function persist(
  root: string,
  doc: ReturnType<typeof parseGoatBrainDocument> | GoatBrainDocument,
): Promise<string> {
  const normalized = toWritableDocument(doc);
  const source = serializeGoatBrainDocument(normalized);
  const validation = validateGoatBrainDocument(
    parseGoatBrainDocument(source),
    normalized.frontmatter.id,
    source,
  );
  if (!validation.ok) throw new Error(validation.errors.join(" "));
  const relativePath = pathForGoatBrainDocument(normalized);
  await writeGoatBrainDocumentText(root, relativePath, source);
  return relativePath;
}

function toWritableDocument(
  doc: ReturnType<typeof parseGoatBrainDocument> | GoatBrainDocument,
): GoatBrainDocument {
  const fm = doc.frontmatter;
  if (!fm.id || !fm.folder || !fm.createdAt || !fm.updatedAt || !fm.type) {
    throw new Error("Cannot write an invalid brain document.");
  }
  if (!isBuiltInGoatBrainEntityType(fm.type)) {
    throw new Error("Cannot write a brain document without a valid type.");
  }
  if (!isValidGoatBrainKind(fm.kind)) {
    throw new Error("Cannot write a brain document without a valid kind.");
  }
  return {
    title: doc.title,
    compiledTruth: doc.compiledTruth,
    timeline: doc.timeline,
    frontmatter: {
      id: fm.id,
      folder: fm.folder,
      kind: fm.kind,
      type: fm.type,
      status: fm.status ?? "draft",
      createdAt: fm.createdAt,
      updatedAt: fm.updatedAt,
      relations: fm.relations ?? [],
      ...(fm.title ? { title: fm.title } : {}),
      ...(fm.aliases ? { aliases: fm.aliases } : {}),
      ...(fm.sources ? { sources: fm.sources } : {}),
      ...(fm.mergedInto ? { mergedInto: fm.mergedInto } : {}),
    },
  };
}

async function loadDoc(root: string, id: string) {
  const file = await findGoatBrainFile(root, id);
  if (!file) return null;
  const doc = parseGoatBrainDocument(file.source);
  return { file, doc };
}

function readRelations(
  values: string[],
): { ok: true; value: GoatBrainRelation[] } | { ok: false; error: string } {
  const out: GoatBrainRelation[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const [rawType, rawTo, ...rest] = value.split(":");
    if (!rawType || !rawTo || rest.length > 0) {
      return { ok: false, error: '`--relation` must use "type:brain-id".' };
    }
    const type = rawType.trim() || DEFAULT_GOAT_BRAIN_RELATION_TYPE;
    const to = rawTo.trim();
    if (!isValidGoatBrainRelationType(type))
      return { ok: false, error: `Invalid relation type "${type}".` };
    if (!isValidGoatBrainId(to)) return { ok: false, error: `Invalid relation target "${to}".` };
    const key = `${type}:${to}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ type, to });
    }
  }
  return { ok: true, value: out };
}

function relationKey(relation: GoatBrainRelation): string {
  return `${relation.type}:${relation.to}`;
}

function titleFromId(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

const RELATIVE_SINCE = /^(\d+)([mhdw])$/;
const SINCE_UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

function resolveSince(raw: string, now = Date.now()): string | null {
  const trimmed = raw.trim();
  const relative = RELATIVE_SINCE.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = SINCE_UNIT_MS[relative[2] ?? ""];
    if (!unitMs || !Number.isFinite(amount) || amount <= 0) return null;
    return new Date(now - amount * unitMs).toISOString();
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function readGraphDirection(raw: string | undefined) {
  if (raw === "out" || raw === "in" || raw === "both") return raw;
  return undefined;
}

async function findPossibleDuplicates(
  root: string,
  input: { id: string; title: string; truth: string },
) {
  const nextText = `${input.title}\n${input.truth}`;
  const files = await listGoatBrainFiles(root);
  return files
    .flatMap((file) => {
      if (file.id === input.id) return [];
      try {
        const doc = parseGoatBrainDocument(file.source);
        if (doc.frontmatter.status === "merged") return [];
        const score = duplicateScore(nextText, `${doc.title}\n${doc.compiledTruth}`);
        if (score < 0.45) return [];
        return [
          {
            id: file.id,
            title: doc.frontmatter.title ?? doc.title ?? file.id,
            score: Number(score.toFixed(2)),
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function duplicateScore(a: string, b: string) {
  const aTokens = meaningfulTokens(a);
  const bTokens = meaningfulTokens(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let shared = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) shared += 1;
  }
  return shared / Math.min(aTokens.size, bTokens.size);
}

const DUPLICATE_STOP_WORDS = new Set([
  "and",
  "for",
  "from",
  "the",
  "with",
  "this",
  "that",
  "into",
  "note",
]);

function meaningfulTokens(value: string) {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length >= 3 && !DUPLICATE_STOP_WORDS.has(token)),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const commandName = argv[0];
  if (!commandName || commandName === "--help" || commandName === "-h") {
    process.stdout.write(HELP);
    process.exit(commandName ? 0 : 1);
  }

  const args = parseArgs(argv.slice(1));
  const json = args.has("json");
  const handler = Object.hasOwn(COMMANDS, commandName) ? COMMANDS[commandName] : undefined;
  if (!handler) {
    render(helpResult(`Unknown command "${commandName}".`), json);
    process.exit(1);
  }
  if (args.has("help")) {
    render(
      ok(commandHelp(commandName), {
        command: commandName,
        help: commandHelp(commandName),
      }),
      json,
    );
    process.exit(0);
  }
  const invalidArgs = validateCommandArgs(commandName, args);
  if (invalidArgs) {
    render(helpResult(invalidArgs, commandName), json);
    process.exit(1);
  }

  try {
    const result = withCommandHelpOnFailure(
      await handler({
        root: resolveGoatBrainRoot(args.get("root")),
        json,
        args,
      }),
      commandName,
    );
    render(result, json);
    if (args.has("report-usage") && result.usage && result.usage.length > 0) {
      process.stderr.write(`${formatGoatBrainUsageReport(result.usage)}\n`);
    }
    process.exit(result.code);
  } catch (error) {
    render(
      fail(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`),
      json,
    );
    process.exit(1);
  }
}

function withCommandHelpOnFailure(result: CommandResult, commandName: string): CommandResult {
  if (result.code === 0 || !isFailureData(result.data) || result.text.includes("Usage:")) {
    return result;
  }
  const help = commandHelp(commandName);
  return {
    ...result,
    text: `${result.text}\n\n${help}`,
    data: {
      ...result.data,
      help,
    },
  };
}

function isFailureData(data: unknown): data is { ok: false } & Record<string, unknown> {
  return Boolean(data && typeof data === "object" && (data as { ok?: unknown }).ok === false);
}

function isCliEntrypoint() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  const argvPath = path.resolve(process.argv[1]);
  if (modulePath === argvPath) return true;
  try {
    return realpathSync(modulePath) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  void main();
}
