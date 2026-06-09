import { parseDocument } from "../document";
import { isCanonicalType } from "../schema";
import { listFiles } from "../store";
import { nowIso } from "../time";
import { loadValid, persist, uniqueMerge } from "./common";
import { type CommandContext, type CommandResult, fail, notFound, ok } from "./io";

// Manage the aliases of a canonical object after creation. Aliases are alternate names retrieval
// matches on, and they must stay globally unique so each one resolves to exactly one object. Adds
// are rejected when another object already owns the name (by id or alias); removes are a no-op when
// the alias isn't present. `--add` and `--remove` may each be repeated.
export async function alias(ctx: CommandContext): Promise<CommandResult> {
  const { args, root } = ctx;
  const id = args.positionals[0] ?? args.get("id");
  if (!id) {
    return fail("Provide a memory id: `memory alias <id> --add <name> --remove <name>`.");
  }

  const toAdd = args.getAll("add");
  const toRemove = new Set(args.getAll("remove"));
  if (toAdd.length === 0 && toRemove.size === 0) {
    return fail("Pass at least one `--add <name>` or `--remove <name>`.");
  }

  const loaded = await loadValid(root, id);
  if (loaded.kind === "missing") return notFound(`No memory found with id "${id}".`);
  if (loaded.kind === "invalid") {
    return fail(`"${id}" is invalid and must be fixed first: ${loaded.errors[0]}`);
  }
  if (!isCanonicalType(loaded.doc.frontmatter.type)) {
    return fail("Aliases are only valid on canonical objects.");
  }

  // Reject any add that another object already owns (by id or alias) so we never create the very
  // duplicate doctor would later flag.
  if (toAdd.length > 0) {
    const owners = new Map<string, string>();
    for (const file of await listFiles(root)) {
      if (file.id === id) continue;
      owners.set(file.id, file.id);
      for (const existing of parseDocument(file.source).frontmatter.aliases ?? []) {
        owners.set(existing, file.id);
      }
    }
    for (const name of toAdd) {
      const owner = owners.get(name);
      if (owner) {
        return fail(`Alias "${name}" already maps to "${owner}". Aliases must be globally unique.`);
      }
    }
  }

  const current = loaded.doc.frontmatter.aliases ?? [];
  const next = uniqueMerge(
    current.filter((a) => !toRemove.has(a)),
    toAdd,
  );

  loaded.doc.frontmatter.aliases = next;
  loaded.doc.frontmatter.updatedAt = nowIso();
  const relativePath = await persist(root, loaded.doc);

  return ok(`Updated aliases for "${id}": ${next.length > 0 ? next.join(", ") : "(none)"}.`, {
    id,
    path: relativePath,
    aliases: next,
  });
}
