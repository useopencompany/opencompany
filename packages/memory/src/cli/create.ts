import type { MemoryDocument, MemoryStatus } from "../schema";
import { DEFAULT_RELATION_TYPE, isCanonicalType, isMemoryType, isValidMemoryId } from "../schema";
import { idExists } from "../store";
import { nowIso } from "../time";
import { readStdin } from "./args";
import { persist } from "./common";
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
  const status: MemoryStatus = statusInput === "deprecated" ? "deprecated" : "active";

  const truth = args.has("truth-stdin") ? await readStdin() : (args.get("truth") ?? "");
  const now = nowIso();
  const aliases = args.getAll("alias");
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
    title: args.get("title") ?? id,
    compiledTruth: truth.trim(),
    timeline: [],
  };

  const relativePath = await persist(root, doc);
  return ok(`Created ${type} "${id}" at ${relativePath}.`, { id, type, path: relativePath });
}
