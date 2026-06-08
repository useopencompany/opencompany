import type { MemoryDocument, MemoryStatus } from "../schema";
import { isCanonicalType, isMemoryType, isValidMemoryId } from "../schema";
import { idExists } from "../store";
import { nowIso } from "../time";
import { readStdin } from "./args";
import { persist, validateCitations } from "./common";
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
  if (await idExists(root, id)) {
    return fail(`An id "${id}" already exists. Ids must be unique across the whole tree.`);
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
  const aliases = args.getAll("alias");
  const related = args.getAll("related").filter(isValidMemoryId);

  const doc: MemoryDocument = {
    frontmatter: {
      id,
      type,
      status,
      freshness: "fresh",
      createdAt: now,
      updatedAt: now,
      related,
      ...(aliases.length > 0 ? { aliases } : {}),
    },
    title: args.get("title") ?? id,
    compiledTruth: truth,
    timeline: [],
  };

  const relativePath = await persist(root, doc);
  return ok(`Created ${type} "${id}" at ${relativePath}.`, { id, type, path: relativePath });
}
