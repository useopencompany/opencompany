import { extractCitations, parseDocument } from "../document";
import { isCanonicalType, isEvidenceType } from "../schema";
import { findFile, listFiles, removeFile } from "../store";
import { nowIso } from "../time";
import { loadValid, persist, uniqueMerge } from "./common";
import { type CommandContext, type CommandResult, fail, notFound, ok } from "./io";

// Permanently remove a memory file (a merged stub, a duplicate, or a bad object). Deletion is
// gated on inbound references so we never silently strand the tree. References split two ways:
//   - hard refs (citations to the target, objects merged into it) can't be auto-repaired without
//     losing integrity, so they require `--force` and are reported as manual follow-ups;
//   - soft refs (related links, evidence subjects) are scrubbed automatically on delete.
// A corrupt/invalid object can still be deleted — we parse leniently and remove by path.
export async function del(ctx: CommandContext): Promise<CommandResult> {
  const { args, root } = ctx;
  const id = args.positionals[0] ?? args.get("id");
  if (!id) return fail("Provide a memory id: `memory delete <id>`.");

  const file = await findFile(root, id);
  if (!file) return notFound(`No memory found with id "${id}".`);

  const targetIsEvidence = isEvidenceType(parseDocument(file.source).frontmatter.type);

  const relatedLinks: string[] = []; // objects whose `related` points at id
  const mergedStubs: string[] = []; // objects merged INTO id (their merged_into === id)
  const evidenceSubjects: string[] = []; // evidence listing id as a subject
  const citedBy: string[] = []; // canonical objects citing id (only when id is evidence)

  for (const other of await listFiles(root)) {
    if (other.id === id) continue;
    const parsed = parseDocument(other.source);
    if ((parsed.frontmatter.related ?? []).some((rel) => rel.target === id)) {
      relatedLinks.push(other.id);
    }
    if (parsed.frontmatter.mergedInto === id) mergedStubs.push(other.id);
    if (
      isEvidenceType(parsed.frontmatter.type) &&
      (parsed.frontmatter.subjects ?? []).includes(id)
    ) {
      evidenceSubjects.push(other.id);
    }
    if (
      targetIsEvidence &&
      isCanonicalType(parsed.frontmatter.type) &&
      extractCitations(parsed.compiledTruth).includes(id)
    ) {
      citedBy.push(other.id);
    }
  }

  const refs = { relatedLinks, mergedStubs, evidenceSubjects, citedBy };
  const hardBlocks: string[] = [];
  if (citedBy.length > 0) hardBlocks.push(`cited by ${citedBy.join(", ")}`);
  if (mergedStubs.length > 0) hardBlocks.push(`merge target of ${mergedStubs.join(", ")}`);
  const softBlocks: string[] = [];
  if (relatedLinks.length > 0) softBlocks.push(`related-linked from ${relatedLinks.join(", ")}`);
  if (evidenceSubjects.length > 0) {
    softBlocks.push(`a subject of evidence ${evidenceSubjects.join(", ")}`);
  }
  const blocking = [...hardBlocks, ...softBlocks];

  if (args.has("dry-run")) {
    return ok(
      blocking.length > 0
        ? `DRY RUN — deleting "${id}" would affect: ${blocking.join("; ")}.`
        : `DRY RUN — "${id}" has no inbound references; safe to delete.`,
      { dryRun: true, id, refs, requiresForce: hardBlocks.length > 0 },
    );
  }

  // Hard references must be acknowledged with --force; soft references alone are scrubbed silently.
  if (hardBlocks.length > 0 && !args.has("force")) {
    return fail(
      `"${id}" is still referenced (${hardBlocks.join("; ")}). Re-run with --force to delete anyway; you must then repair those citations/redirects manually (try \`memory doctor\`).`,
      1,
      { refs },
    );
  }

  // Scrub fixable structural references so nothing dangles after the file is gone.
  const now = nowIso();
  const orphanedEvidence: string[] = [];
  for (const otherId of uniqueMerge([...relatedLinks, ...evidenceSubjects])) {
    const other = await loadValid(root, otherId);
    if (other.kind !== "ok") continue;
    let changed = false;
    if ((other.doc.frontmatter.related ?? []).some((r) => r.target === id)) {
      other.doc.frontmatter.related = other.doc.frontmatter.related.filter((r) => r.target !== id);
      changed = true;
    }
    if (other.doc.frontmatter.subjects?.includes(id)) {
      other.doc.frontmatter.subjects = other.doc.frontmatter.subjects.filter((s) => s !== id);
      if (other.doc.frontmatter.subjects.length === 0) orphanedEvidence.push(otherId);
      changed = true;
    }
    if (changed) {
      other.doc.frontmatter.updatedAt = now;
      await persist(root, other.doc);
    }
  }

  await removeFile(root, file.relativePath);

  const notes: string[] = [];
  if (citedBy.length > 0) {
    notes.push(`still cited by ${citedBy.join(", ")} — rewrite their compiled truth`);
  }
  if (mergedStubs.length > 0) {
    notes.push(`${mergedStubs.join(", ")} were merged into it — re-point or delete them`);
  }
  if (orphanedEvidence.length > 0) {
    notes.push(`evidence ${orphanedEvidence.join(", ")} now has no subjects`);
  }

  return ok(
    `Deleted "${id}" (${file.relativePath}).${notes.length > 0 ? ` Follow up: ${notes.join("; ")}.` : ""}`,
    { id, path: file.relativePath, scrubbed: { related: relatedLinks, subjects: evidenceSubjects }, notes },
  );
}
