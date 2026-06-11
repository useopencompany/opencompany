import {
  DEFAULT_RELATION_TYPE,
  isCanonicalType,
  isValidMemoryId,
  isValidRelationType,
  type MemoryRelation,
} from "../schema";
import { nowIso } from "../time";
import { loadValid, persist } from "./common";
import { type CommandContext, type CommandResult, fail, notFound, ok } from "./io";

// Manage the `related` graph edges of a canonical object. Edges are DIRECTIONAL — `link <id>`
// edits only `<id>`'s `related` list, never the other side — and TYPED: `--as <type>` labels the
// relationship (default `related`). Retrieval can then expand a result set by hopping along these
// edges (`memory query ... --hops N`). `--to` adds an edge, `--remove` drops one; both may be
// repeated. There is one edge per target, so re-adding a target just updates its type. Add targets
// must exist; removes are a no-op when absent (so a dangling edge can always be cleaned up).
export async function link(ctx: CommandContext): Promise<CommandResult> {
  const { args, root } = ctx;
  const id = args.positionals[0] ?? args.get("id");
  if (!id) {
    return fail(
      "Provide a memory id: `memory link <id> --to <other-id> [--as <type>] --remove <other-id>`.",
    );
  }

  const type = args.get("as") ?? DEFAULT_RELATION_TYPE;
  if (!isValidRelationType(type)) {
    return fail(`\`--as\` must be a lowercase slug (a-z, 0-9, _), e.g. depends_on. Got "${type}".`);
  }

  const toAdd = [...new Set(args.getAll("to").filter(isValidMemoryId))];
  const toRemove = new Set(args.getAll("remove").filter(isValidMemoryId));
  if (toAdd.length === 0 && toRemove.size === 0) {
    return fail("Pass at least one `--to <id>` or `--remove <id>` (valid memory ids).");
  }
  if (toAdd.includes(id) || toRemove.has(id)) {
    return fail("An object cannot be related to itself.");
  }

  const loaded = await loadValid(root, id);
  if (loaded.kind === "missing") return notFound(`No memory found with id "${id}".`);
  if (loaded.kind === "invalid") {
    return fail(`"${id}" is invalid and must be fixed first: ${loaded.errors[0]}`);
  }
  if (!isCanonicalType(loaded.doc.frontmatter.type)) {
    return fail("Related links are only valid on canonical objects.");
  }

  // Every add target must already exist — an edge to nothing is dead weight retrieval can't use.
  for (const target of toAdd) {
    const found = await loadValid(root, target);
    if (found.kind === "missing") {
      return fail(`Cannot link to "${target}": no such memory.`);
    }
  }

  // One edge per target: drop any existing edge to a removed or re-added target, then append the
  // re-added ones with the new type. Preserves the order of untouched edges.
  const touched = new Set([...toRemove, ...toAdd]);
  const current = loaded.doc.frontmatter.related ?? [];
  const kept = current.filter((rel) => !touched.has(rel.target));
  const added: MemoryRelation[] = toAdd.map((target) => ({ type, target }));
  const next = [...kept, ...added];

  loaded.doc.frontmatter.related = next;
  loaded.doc.frontmatter.updatedAt = nowIso();
  const relativePath = await persist(root, loaded.doc);

  const summary = next.length > 0 ? next.map((r) => `${r.type}→${r.target}`).join(", ") : "(none)";
  return ok(`Updated related for "${id}": ${summary}.`, { id, path: relativePath, related: next });
}
