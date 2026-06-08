import { isCanonicalType } from "../schema";
import { nowIso } from "../time";
import { readStdin } from "./args";
import { loadValid, persist, validateCitations } from "./common";
import { type CommandContext, type CommandResult, fail, notFound, ok } from "./io";

// Update a canonical object's compiled truth. The integrity gate: the new truth must cite
// evidence with [^ev:<id>] footnotes, every cited evidence must exist, and each must already
// list this object in its `subjects`. The timeline is never touched here. A successful rewrite
// also promotes a `draft` to `active`: now that the truth is evidence-backed, it is no longer
// scratch (the create/rewrite contract — uncited truth lives in draft, cited truth is active).
export async function rewrite(ctx: CommandContext): Promise<CommandResult> {
  const { args, root } = ctx;
  const id = args.positionals[0] ?? args.get("id");
  if (!id) return fail("Provide a memory id: `memory rewrite <id> --truth ...`.");

  const loaded = await loadValid(root, id);
  if (loaded.kind === "missing") return notFound(`No memory found with id "${id}".`);
  if (loaded.kind === "invalid")
    return fail(`"${id}" is invalid and must be fixed first: ${loaded.errors[0]}`);
  if (!isCanonicalType(loaded.doc.frontmatter.type)) {
    return fail("Only canonical objects can be rewritten; evidence records are immutable.");
  }

  const truth = (args.has("truth-stdin") ? await readStdin() : (args.get("truth") ?? "")).trim();
  if (!truth) return fail("`--truth` (or `--truth-stdin`) is required.");

  const citations = await validateCitations(root, id, truth);
  if (!citations.ok) return fail(citations.error);

  const freshnessInput = args.get("freshness");
  loaded.doc.compiledTruth = truth;
  loaded.doc.frontmatter.updatedAt = nowIso();
  loaded.doc.frontmatter.freshness = freshnessInput === "aging" ? "aging" : "fresh";
  if (loaded.doc.frontmatter.status === "draft") {
    loaded.doc.frontmatter.status = "active";
  }

  const relativePath = await persist(root, loaded.doc);
  return ok(`Rewrote compiled truth for "${id}" (cited: ${citations.cited.join(", ")}).`, {
    id,
    path: relativePath,
    status: loaded.doc.frontmatter.status,
    cited: citations.cited,
  });
}
