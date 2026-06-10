import type { EvidenceType, MemoryDocument } from "../schema";
import { isCanonicalType, isEvidenceType, isValidMemoryId } from "../schema";
import { idExists } from "../store";
import { nowIso } from "../time";
import { readStdin } from "./args";
import { loadValid, persist } from "./common";
import { type CommandContext, type CommandResult, fail, ok } from "./io";

// Record an immutable evidence file and link it to its subjects. Evidence requires provenance
// (kind + source ref) and at least one existing canonical subject. Appending an evidence
// timeline entry to each subject does NOT touch the subject's compiled truth or updated_at —
// only `rewrite` advances compiled truth, keeping recency meaningful.
export async function appendEvidence(ctx: CommandContext): Promise<CommandResult> {
  const { args, root } = ctx;
  const kind = args.get("kind");
  const id = args.get("id");

  if (!kind || !isEvidenceType(kind)) {
    return fail(
      "`--kind` is required and must be an evidence kind (meeting, conversation, doc, research, correction).",
    );
  }
  if (!id || !isValidMemoryId(id)) {
    return fail("`--id` is required and must be a lowercase slug.");
  }
  const sourceRef = args.get("source-ref");
  if (!sourceRef) {
    return fail("`--source-ref` is required — evidence must carry provenance.");
  }
  const subjects = args.getAll("subject").filter(isValidMemoryId);
  if (subjects.length === 0) {
    return fail("At least one `--subject <canonical-id>` is required.");
  }
  if (await idExists(root, id)) {
    return fail(`An id "${id}" already exists. Evidence is append-only and ids are unique.`);
  }

  // Every subject must exist and be canonical.
  for (const subjectId of subjects) {
    const loaded = await loadValid(root, subjectId);
    if (loaded.kind === "missing") return fail(`Subject "${subjectId}" does not exist.`);
    if (loaded.kind === "invalid")
      return fail(`Subject "${subjectId}" is invalid: ${loaded.errors[0]}`);
    if (!isCanonicalType(loaded.doc.frontmatter.type)) {
      return fail(
        `Subject "${subjectId}" is not a canonical object; evidence can only point at canonical objects.`,
      );
    }
  }

  const now = nowIso();
  const capturedAt = args.get("captured-at") ?? now;
  const body = args.has("body-stdin") ? await readStdin() : (args.get("body") ?? "");
  const author = args.get("author");
  const summary = args.get("summary") ?? "";

  const evidence: MemoryDocument = {
    frontmatter: {
      id,
      type: kind as EvidenceType,
      status: "active",
      createdAt: now,
      updatedAt: now,
      related: [],
      subjects,
      source: {
        ref: sourceRef,
        capturedAt,
        ...(author ? { author } : {}),
      },
    },
    title: args.get("title") ?? id,
    compiledTruth: summary.trim(),
    timeline: [{ at: now, body: body.trim() || summary.trim() || "(no details captured)" }],
  };

  const evidencePath = await persist(root, evidence);

  // Append a dated pointer to each subject's timeline (compiled truth untouched).
  for (const subjectId of subjects) {
    const loaded = await loadValid(root, subjectId);
    if (loaded.kind !== "ok") continue;
    const note = summary.trim()
      ? `${summary.trim()} See [^ev:${id}].`
      : `New ${kind}. See [^ev:${id}].`;
    loaded.doc.timeline.push({ at: now, body: note });
    await persist(root, loaded.doc);
  }

  return ok(`Recorded ${kind} "${id}" linked to ${subjects.join(", ")}.`, {
    id,
    kind,
    path: evidencePath,
    subjects,
  });
}
