import { parseDocument } from "../document";
import { folderForType } from "../paths";
import type { MemoryDocument, MemoryStatus } from "../schema";
import { DEFAULT_RELATION_TYPE, isCanonicalType, isMemoryType, isValidMemoryId } from "../schema";
import { areAnyNamesSimilar } from "../similarity";
import { listFiles } from "../store";
import { nowIso } from "../time";
import { readStdin } from "./args";
import { entityNames, isLiveCanonical, persist, validateCitations } from "./common";
import { type CommandContext, type CommandResult, fail, ok } from "./io";

// Create a canonical object with valid frontmatter and the two-layer skeleton. Evidence types
// are rejected here — they go through append-evidence, which enforces provenance.
export async function create(ctx: CommandContext): Promise<CommandResult> {
  const { args, root } = ctx;
  const type = args.get("type");
  const id = args.get("id");

  if (!type || !isMemoryType(type)) {
    return fail("`--type` is required and must be a known type.");
  }
  if (!isCanonicalType(type)) {
    return fail(`\`${type}\` is an evidence type — use \`memory append-evidence\` instead.`);
  }
  if (!id || !isValidMemoryId(id)) {
    return fail("`--id` is required and must be a lowercase slug (a-z, 0-9, hyphen).");
  }
  const title = args.get("title") ?? id;
  const aliases = args.getAll("alias");

  const files = await listFiles(root);
  if (files.some((file) => file.id === id)) {
    return fail(`An id "${id}" already exists. Ids must be unique across the whole tree.`);
  }

  // Refuse a near-duplicate of an existing object of the same type — the same person/company filed
  // twice under a slightly different name (`aurelio` vs `aurelio-anastassiades`, a misspelling like
  // `gruenberg` vs `grueneberg`). The right move is to update the existing record, not create a
  // second one. `--allow-similar` is the escape hatch for genuinely distinct things that happen to
  // share a name; it is a presence-only boolean, but treat an explicit `--allow-similar false` as
  // "do not override" so a caller fumbling the flag syntax can't silently defeat the guard.
  const allowSimilar = args.has("allow-similar") && args.get("allow-similar") !== "false";
  if (!allowSimilar) {
    const folderPrefix = `${folderForType(type)}/`;
    const newNames = entityNames(title, id, aliases);
    const collisions: string[] = [];
    for (const file of files) {
      if (!file.relativePath.startsWith(folderPrefix)) continue;
      const existing = parseDocument(file.source);
      // Same liveness predicate doctor uses, plus the exact type (the folder prefix is just a cheap
      // pre-filter; the type check guards a misfiled doc). doctor additionally suppresses pairs
      // already adjudicated `not_duplicate`, but a brand-new record carries no such link yet, so that
      // can't apply here — `--allow-similar` is how you record "this really is a different <type>".
      if (!isLiveCanonical(existing.frontmatter) || existing.frontmatter.type !== type) continue;
      const existingNames = entityNames(
        existing.title,
        file.id,
        existing.frontmatter.aliases ?? [],
      );
      if (areAnyNamesSimilar(newNames, existingNames)) collisions.push(file.id);
    }
    if (collisions.length > 0) {
      const list = collisions.map((c) => `"${c}"`).join(", ");
      return fail(
        `This looks like the same ${type} as ${list}, which already exists. Update that record instead of creating a duplicate: \`memory get <id>\`, then \`memory rewrite\` (or \`memory alias\` to record the other spelling). If two existing records are the same thing, \`memory merge\` them. If this really is a different ${type}, re-run with --allow-similar.`,
      );
    }
  }

  const statusInput = args.get("status");
  const status: MemoryStatus =
    statusInput === "active" || statusInput === "deprecated" ? statusInput : "draft";

  const truth = (args.has("truth-stdin") ? await readStdin() : (args.get("truth") ?? "")).trim();

  // The create/rewrite contract: uncited compiled truth may only live in a `draft`. A record born
  // `active` with compiled truth must already be evidence-backed (same gate as `rewrite`), so
  // active truth can't bypass the citation discipline `rewrite` enforces. The normal path is
  // create (draft) → append-evidence → rewrite (which promotes to active); this just blocks the
  // shortcut that would otherwise let uncited "truth" start life as established fact.
  if (status === "active" && truth) {
    const citations = await validateCitations(root, id, truth);
    if (!citations.ok) {
      return fail(
        `Cannot create an active "${id}" with this compiled truth: ${citations.error} Create it as a draft (omit --status), then capture evidence and \`memory rewrite\` to promote it.`,
      );
    }
  }

  const now = nowIso();
  const related = [...new Set(args.getAll("related").filter(isValidMemoryId))].map((target) => ({
    type: DEFAULT_RELATION_TYPE,
    target,
  }));

  const doc: MemoryDocument = {
    frontmatter: {
      id,
      type,
      status,
      createdAt: now,
      updatedAt: now,
      related,
      ...(aliases.length > 0 ? { aliases } : {}),
    },
    title,
    compiledTruth: truth,
    timeline: [],
  };

  const relativePath = await persist(root, doc);
  return ok(`Created ${type} "${id}" at ${relativePath}.`, { id, type, path: relativePath });
}
