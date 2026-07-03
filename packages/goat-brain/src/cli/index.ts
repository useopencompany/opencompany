#!/usr/bin/env bun
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_GOAT_BRAIN_FOLDERS,
  DEFAULT_GOAT_BRAIN_RELATION_TYPE,
  GOAT_BRAIN_TIMELINE_SENTINEL,
  type GoatBrainDocument,
  type GoatBrainRelation,
  type GoatBrainSource,
  goatBrainRelativePath,
  isValidGoatBrainFolder,
  isValidGoatBrainId,
  isValidGoatBrainRelationType,
  normalizeGoatBrainFolder,
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
import { loadProviders } from "../retrieval/providers";
import { findGoatBrainFile, listGoatBrainFiles, type StoredGoatBrainFile } from "../store";
import { formatGoatBrainUsageReport, type GoatBrainUsageEntry } from "../usage";
import { parseArgs, readStdin } from "./args";
import { type CommandContext, type CommandResult, fail, notFound, ok, render } from "./io";

type Handler = (ctx: CommandContext) => Promise<CommandResult>;

const COMMANDS: Record<string, Handler> = {
  create,
  get,
  query,
  rewrite,
  "append-timeline": appendTimeline,
  link,
  move,
  delete: del,
  folder,
  doctor,
};

const GLOBAL_FLAGS = ["root", "json", "report-usage"] as const;
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  create: ["folder", "id", "title", "truth", "truth-stdin", "tag", "related", "source-ref"],
  get: ["id", "section"],
  query: ["text", "folder", "since", "limit", "hops", "lexical-only", "include-invalid"],
  rewrite: ["id", "truth", "truth-stdin"],
  "append-timeline": ["id", "at", "body", "body-stdin", "source-ref", "source-title"],
  link: ["id", "to", "as", "remove"],
  move: ["id", "folder"],
  delete: ["id", "force", "dry-run"],
  folder: ["path"],
  doctor: [],
};

export const HELP = `goat-brain - folder-first personal brain CLI

Usage: goat-brain <command> [options]

Commands:
  create            Create a markdown brain doc in a folder.
  get               Read a doc by id (--section truth|timeline|frontmatter|all).
  query             Hybrid retrieval over docs (--folder, --since, --hops, --limit).
  rewrite           Replace compiled truth for a doc.
  append-timeline   Append a dated timeline entry and optional source ref.
  link              Add/remove related edges.
  move              Move a doc to another folder.
  delete            Delete a doc (--dry-run, --force).
  folder            folder list | folder create --path <folder>.
  doctor            Check validation, links, folder shape, and weak provenance.

Global options:
  --root <path>     Brain root (default: goat-brain; GOAT_BRAIN_ROOT pins it).
  --json            Machine-readable output.
`;

export function helpResult(message: string): CommandResult {
  return fail(`${message}\n\n${HELP}`);
}

export function validateCommandArgs(commandName: string, args: ReturnType<typeof parseArgs>) {
  const allowed = COMMAND_FLAGS[commandName];
  if (!allowed) return null;
  const allowedSet = new Set([...GLOBAL_FLAGS, ...allowed]);
  const unknown = args.names().find((name) => !allowedSet.has(name));
  return unknown ? `Unknown option "--${unknown}".` : null;
}

async function create(ctx: CommandContext): Promise<CommandResult> {
  const folder = normalizeGoatBrainFolder(ctx.args.get("folder") ?? "inbox");
  if (!isValidGoatBrainFolder(folder)) return fail("`--folder` must be a safe folder path.");
  const rawId = ctx.args.get("id") ?? ctx.args.get("title") ?? "untitled";
  const id = normalizeGoatBrainId(rawId);
  if (!isValidGoatBrainId(id)) return fail("`--id` must resolve to a lowercase slug.");
  if (await findGoatBrainFile(ctx.root, id))
    return fail(`A brain doc with id "${id}" already exists.`);

  const now = nowIso();
  const title = ctx.args.get("title")?.trim() || titleFromId(id);
  const truth = (
    ctx.args.has("truth-stdin") ? await readStdin() : (ctx.args.get("truth") ?? "")
  ).trim();
  const related = readRelated(ctx.args.getAll("related"));
  const sourceRef = ctx.args.get("source-ref")?.trim();
  const doc: GoatBrainDocument = {
    frontmatter: {
      id,
      folder,
      title,
      createdAt: now,
      updatedAt: now,
      related,
      ...(ctx.args.getAll("tag").length > 0 ? { tags: ctx.args.getAll("tag") } : {}),
      ...(sourceRef ? { sources: [{ ref: sourceRef, capturedAt: now }] } : {}),
    },
    title,
    compiledTruth: truth,
    timeline: sourceRef ? [{ at: now, body: `Created from ${sourceRef}.` }] : [],
  };
  const relativePath = await persist(ctx.root, doc);
  return ok(`Created "${id}" at ${relativePath}.`, { id, folder, path: relativePath });
}

async function get(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.positionals[0] ?? ctx.args.get("id");
  if (!id) return fail("Provide a brain id.");
  const loaded = await loadDoc(ctx.root, id);
  if (!loaded) return notFound(`No brain doc found with id "${id}".`);
  const { file, doc } = loaded;
  const section = ctx.args.get("section") ?? "all";
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
    return ok(text, { id: file.id, path: file.relativePath, timeline: doc.timeline });
  }
  return ok(file.source, { id: file.id, path: file.relativePath, doc });
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
  const hits = await queryGoatBrain(
    ctx.root,
    {
      text,
      ...(ctx.args.get("folder")
        ? { folder: normalizeGoatBrainFolder(ctx.args.get("folder") ?? "") }
        : {}),
      ...(since ? { since } : {}),
      ...(ctx.args.number("hops") !== undefined
        ? { hops: Math.max(0, ctx.args.number("hops") ?? 0) }
        : {}),
      limit: ctx.args.number("limit") ?? 10,
      lexicalOnly: ctx.args.has("lexical-only"),
      ...(ctx.args.has("include-invalid") ? { includeInvalid: true } : {}),
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

async function appendTimeline(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.positionals[0] ?? ctx.args.get("id");
  if (!id) return fail("Provide a brain id.");
  const loaded = await loadDoc(ctx.root, id);
  if (!loaded) return notFound(`No brain doc found with id "${id}".`);
  const body = (
    ctx.args.has("body-stdin") ? await readStdin() : (ctx.args.get("body") ?? "")
  ).trim();
  if (!body) return fail("`--body` or `--body-stdin` is required.");
  const at = ctx.args.get("at") ?? nowIso();
  const parsedAt = Date.parse(at);
  if (Number.isNaN(parsedAt)) return fail("`--at` must be an ISO-8601 timestamp.");
  const entryAt = new Date(parsedAt).toISOString();
  loaded.doc.timeline.push({ at: entryAt, body });
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
  return ok(`Appended timeline entry to "${id}".`, { id, path: relativePath });
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
  const byTarget = new Map(
    (loaded.doc.frontmatter.related ?? []).map((relation) => [relation.target, relation]),
  );
  for (const target of remove) byTarget.delete(target);
  for (const target of ctx.args.getAll("to")) {
    if (!isValidGoatBrainId(target)) return fail(`Invalid related id "${target}".`);
    byTarget.set(target, { type: relationType, target });
  }
  loaded.doc.frontmatter.related = [...byTarget.values()].sort((a, b) =>
    a.target.localeCompare(b.target),
  );
  loaded.doc.frontmatter.updatedAt = nowIso();
  const relativePath = await persist(ctx.root, loaded.doc);
  return ok(`Updated related links for "${id}".`, {
    id,
    path: relativePath,
    related: loaded.doc.frontmatter.related,
  });
}

async function move(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.positionals[0] ?? ctx.args.get("id");
  const folder = normalizeGoatBrainFolder(ctx.args.get("folder") ?? "");
  if (!id) return fail("Provide a brain id.");
  if (!isValidGoatBrainFolder(folder)) return fail("`--folder` must be a safe folder path.");
  const loaded = await loadDoc(ctx.root, id);
  if (!loaded) return notFound(`No brain doc found with id "${id}".`);
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
    return ok(`Would delete "${id}" at ${file.relativePath}.`, { id, path: file.relativePath });
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
    const folderPath = normalizeGoatBrainFolder(ctx.args.get("path") ?? "");
    if (!isValidGoatBrainFolder(folderPath)) return fail("`--path` must be a safe folder path.");
    return ok(`Folder "${folderPath}" is available.`, { folder: folderPath });
  }
  return fail('folder command must be "list" or "create".');
}

async function doctor(ctx: CommandContext): Promise<CommandResult> {
  const files = await listGoatBrainFiles(ctx.root);
  const findings: Array<{ severity: "error" | "warn"; code: string; id: string; message: string }> =
    [];
  const idCounts = new Map<string, number>();
  const byId = new Map<
    string,
    { file: StoredGoatBrainFile; doc: ReturnType<typeof parseGoatBrainDocument> }
  >();
  for (const file of files) {
    idCounts.set(file.id, (idCounts.get(file.id) ?? 0) + 1);
    if (!byId.has(file.id)) byId.set(file.id, { file, doc: parseGoatBrainDocument(file.source) });
  }
  for (const [id, count] of idCounts) {
    if (count > 1)
      findings.push({
        severity: "error",
        code: "duplicate_id",
        id,
        message: `Id "${id}" is used by ${count} files.`,
      });
  }
  for (const file of files) {
    const doc = parseGoatBrainDocument(file.source);
    const validation = validateGoatBrainDocument(doc, file.id, file.source);
    if (!validation.ok) {
      for (const message of validation.errors)
        findings.push({ severity: "error", code: "invalid", id: file.id, message });
    }
    const expectedPath =
      doc.frontmatter.folder &&
      doc.frontmatter.id &&
      isValidGoatBrainFolder(doc.frontmatter.folder) &&
      isValidGoatBrainId(doc.frontmatter.id)
        ? goatBrainRelativePath(doc.frontmatter.folder, doc.frontmatter.id)
        : null;
    if (expectedPath && expectedPath !== file.relativePath) {
      findings.push({
        severity: "error",
        code: "path_mismatch",
        id: file.id,
        message: `File path "${file.relativePath}" should be "${expectedPath}".`,
      });
    }
    for (const relation of doc.frontmatter.related ?? []) {
      if (!byId.has(relation.target)) {
        findings.push({
          severity: "error",
          code: "broken_related",
          id: file.id,
          message: `Related id "${relation.target}" does not exist.`,
        });
      }
    }
    if (
      doc.compiledTruth.trim() &&
      doc.timeline.length === 0 &&
      !(doc.frontmatter.sources ?? []).length
    ) {
      findings.push({
        severity: "warn",
        code: "weak_provenance",
        id: file.id,
        message: "Compiled truth has no timeline entries or sources.",
      });
    }
  }
  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warn");
  const summary = `${files.length} files checked - ${errors.length} error(s), ${warnings.length} warning(s).`;
  const text = [
    summary,
    ...findings.map(
      (finding) =>
        `${finding.severity.toUpperCase()} ${finding.code} ${finding.id}: ${finding.message}`,
    ),
  ].join("\n");
  return {
    ...ok(text, {
      files: files.length,
      errors: errors.length,
      warnings: warnings.length,
      findings,
    }),
    code: errors.length > 0 ? 1 : 0,
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
  if (!fm.id || !fm.folder || !fm.createdAt || !fm.updatedAt) {
    throw new Error("Cannot write an invalid brain document.");
  }
  return {
    title: doc.title,
    compiledTruth: doc.compiledTruth,
    timeline: doc.timeline,
    frontmatter: {
      id: fm.id,
      folder: fm.folder,
      createdAt: fm.createdAt,
      updatedAt: fm.updatedAt,
      related: fm.related ?? [],
      ...(fm.title ? { title: fm.title } : {}),
      ...(fm.tags ? { tags: fm.tags } : {}),
      ...(fm.sources ? { sources: fm.sources } : {}),
    },
  };
}

async function loadDoc(root: string, id: string) {
  const file = await findGoatBrainFile(root, id);
  if (!file) return null;
  const doc = parseGoatBrainDocument(file.source);
  return { file, doc };
}

function readRelated(values: string[]): GoatBrainRelation[] {
  return [...new Set(values.filter(isValidGoatBrainId))].map((target) => ({
    type: DEFAULT_GOAT_BRAIN_RELATION_TYPE,
    target,
  }));
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const commandName = argv[0];
  if (!commandName || commandName === "help" || commandName === "--help" || commandName === "-h") {
    process.stdout.write(HELP);
    process.exit(commandName ? 0 : 1);
  }

  const args = parseArgs(argv.slice(1));
  const json = args.has("json");
  const handler = COMMANDS[commandName];
  if (!handler) {
    render(helpResult(`Unknown command "${commandName}".`), json);
    process.exit(1);
  }
  const invalidArgs = validateCommandArgs(commandName, args);
  if (invalidArgs) {
    render(helpResult(invalidArgs), json);
    process.exit(1);
  }

  try {
    const result = await handler({ root: resolveGoatBrainRoot(args.get("root")), json, args });
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
