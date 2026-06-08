import { extractCitations } from "../document";
import { isCanonicalType, isEvidenceType } from "../schema";
import { nowIso } from "../time";
import { readStdin } from "./args";
import { loadValid, persist } from "./common";
import { type CommandContext, type CommandResult, fail, notFound, ok } from "./io";

// Update a canonical object's compiled truth. The integrity gate: the new truth must cite
// evidence with [^ev:<id>] footnotes, every cited evidence must exist, and each must already
// list this object in its `subjects`. The timeline is never touched here.
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

  const cited = extractCitations(truth);
  if (cited.length === 0) {
    return fail(
      "Compiled truth must cite evidence with [^ev:<evidence-id>] footnotes. Capture evidence first with `memory append-evidence`.",
    );
  }

  // Validate each citation: it must resolve to an evidence record that lists this object.
  for (const evidenceId of cited) {
    const evidence = await loadValid(root, evidenceId);
    if (evidence.kind === "missing") {
      return fail(`Cited evidence "${evidenceId}" does not exist.`);
    }
    if (evidence.kind === "invalid") {
      return fail(`Cited evidence "${evidenceId}" is invalid: ${evidence.errors[0]}`);
    }
    if (!isEvidenceType(evidence.doc.frontmatter.type)) {
      return fail(`Citation "${evidenceId}" is not an evidence record.`);
    }
    if (!(evidence.doc.frontmatter.subjects ?? []).includes(id)) {
      return fail(
        `Evidence "${evidenceId}" does not list "${id}" as a subject — it cannot back this claim.`,
      );
    }
  }

  const freshnessInput = args.get("freshness");
  loaded.doc.compiledTruth = truth;
  loaded.doc.frontmatter.updatedAt = nowIso();
  loaded.doc.frontmatter.freshness = freshnessInput === "aging" ? "aging" : "fresh";

  const relativePath = await persist(root, loaded.doc);
  return ok(`Rewrote compiled truth for "${id}" (cited: ${cited.join(", ")}).`, {
    id,
    path: relativePath,
    cited,
  });
}
