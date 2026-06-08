import { parseDocument } from "../document";
import { isCanonicalType } from "../schema";
import { listFiles } from "../store";
import { nowIso } from "../time";
import { loadValid, persist, uniqueMerge } from "./common";
import { type CommandContext, type CommandResult, fail, ok } from "./io";

// Resolve a duplicate canonical object into another. Timelines, aliases and related links are
// consolidated, evidence subjects are re-pointed, and the source becomes a redirect stub.
// Compiled truth is NOT auto-merged — the caller re-synthesizes it with `rewrite` so the
// citation invariant is preserved.
export async function merge(ctx: CommandContext): Promise<CommandResult> {
  const { args, root } = ctx;
  const fromId = args.get("from");
  const intoId = args.get("into");
  if (!fromId || !intoId) return fail("`--from <id>` and `--into <id>` are required.");
  if (fromId === intoId) return fail("Cannot merge a record into itself.");

  const from = await loadValid(root, fromId);
  if (from.kind !== "ok") return fail(`Source "${fromId}" not found or invalid.`);
  const into = await loadValid(root, intoId);
  if (into.kind !== "ok") return fail(`Target "${intoId}" not found or invalid.`);

  if (!isCanonicalType(from.doc.frontmatter.type) || !isCanonicalType(into.doc.frontmatter.type)) {
    return fail("Both records must be canonical objects.");
  }
  if (from.doc.frontmatter.type !== into.doc.frontmatter.type && !args.has("force")) {
    return fail(
      `Type mismatch (${from.doc.frontmatter.type} → ${into.doc.frontmatter.type}). Pass --force to merge anyway.`,
    );
  }

  // Find evidence that points at the source so its subjects can be re-pointed.
  const repointed: string[] = [];
  const evidenceFiles = await listFiles(root);
  for (const file of evidenceFiles) {
    const parsed = parseDocument(file.source);
    if ((parsed.frontmatter.subjects ?? []).includes(fromId)) {
      repointed.push(file.id);
    }
  }

  const now = nowIso();
  const plan = {
    from: fromId,
    into: intoId,
    timelineEntriesMoved: from.doc.timeline.length,
    aliasesAdded: uniqueMerge([fromId], from.doc.frontmatter.aliases ?? []),
    evidenceRepointed: repointed,
  };

  if (args.has("dry-run")) {
    return ok(
      `DRY RUN — would merge "${fromId}" into "${intoId}": move ${plan.timelineEntriesMoved} timeline entries, re-point ${repointed.length} evidence record(s).`,
      { dryRun: true, plan },
    );
  }

  // Consolidate into the target.
  into.doc.timeline = [...into.doc.timeline, ...from.doc.timeline];
  into.doc.frontmatter.aliases = uniqueMerge(
    into.doc.frontmatter.aliases ?? [],
    [fromId],
    from.doc.frontmatter.aliases ?? [],
  );
  into.doc.frontmatter.related = uniqueMerge(
    into.doc.frontmatter.related,
    from.doc.frontmatter.related,
  ).filter((rel) => rel !== fromId && rel !== intoId);
  into.doc.frontmatter.updatedAt = now;
  await persist(root, into.doc);

  // Re-point evidence subjects from→into (structural fix; evidence content/updated_at unchanged).
  for (const evidenceId of repointed) {
    const evidence = await loadValid(root, evidenceId);
    if (evidence.kind !== "ok" || !evidence.doc.frontmatter.subjects) continue;
    evidence.doc.frontmatter.subjects = uniqueMerge(
      evidence.doc.frontmatter.subjects.map((s) => (s === fromId ? intoId : s)),
    );
    await persist(root, evidence.doc);
  }

  // Stub the source as a redirect.
  from.doc.frontmatter.status = "merged";
  from.doc.frontmatter.mergedInto = intoId;
  from.doc.frontmatter.updatedAt = now;
  from.doc.compiledTruth = `Merged into [[${intoId}]].`;
  from.doc.timeline = [];
  await persist(root, from.doc);

  return ok(
    `Merged "${fromId}" into "${intoId}". Re-pointed ${repointed.length} evidence record(s). Now run \`memory rewrite ${intoId}\` to re-synthesize compiled truth with citations.`,
    { ...plan, hint: `memory rewrite ${intoId}` },
  );
}
