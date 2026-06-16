import { extractCitations, parseDocument, TIMELINE_HEADING, TRUTH_HEADING } from "../document";
import { typeForFolder } from "../paths";
import { isCanonicalType, isEvidenceType } from "../schema";
import { areAnyNamesSimilar } from "../similarity";
import { listFiles } from "../store";
import { validateDocument } from "../validate";
import { entityNames, isLiveCanonical } from "./common";
import { type CommandContext, type CommandResult, fail, ok } from "./io";

type Severity = "error" | "warn";
type Finding = { severity: Severity; code: string; id: string; message: string };

// Walk the whole tree and report integrity problems: missing provenance, duplicate ids/aliases,
// broken links and citations, orphan evidence, stale compiled truth, type/folder mismatches and
// malformed bodies. This is a read-only report — nothing is written back.
export async function doctor(ctx: CommandContext): Promise<CommandResult> {
  const { root } = ctx;
  const files = await listFiles(root);
  const findings: Finding[] = [];

  // Index everything once.
  const byId = new Map<
    string,
    { relativePath: string; source: string; parsed: ReturnType<typeof parseDocument> }
  >();
  const idCounts = new Map<string, number>();
  const aliasOwners = new Map<string, string[]>();
  const citedEvidence = new Set<string>();

  for (const file of files) {
    const parsed = parseDocument(file.source);
    idCounts.set(file.id, (idCounts.get(file.id) ?? 0) + 1);
    if (!byId.has(file.id))
      byId.set(file.id, { relativePath: file.relativePath, source: file.source, parsed });
    for (const alias of parsed.frontmatter.aliases ?? []) {
      const owners = aliasOwners.get(alias) ?? [];
      owners.push(file.id);
      aliasOwners.set(alias, owners);
    }
    if (isCanonicalType(parsed.frontmatter.type)) {
      for (const cited of extractCitations(parsed.compiledTruth)) citedEvidence.add(cited);
    }
  }

  for (const [id, count] of idCounts) {
    if (count > 1)
      findings.push({
        severity: "error",
        code: "duplicate_id",
        id,
        message: `Id "${id}" is used by ${count} files.`,
      });
  }
  for (const [alias, owners] of aliasOwners) {
    const distinct = [...new Set(owners)];
    if (distinct.length > 1) {
      findings.push({
        severity: "error",
        code: "duplicate_alias",
        id: distinct.join(","),
        message: `Alias "${alias}" maps to multiple objects: ${distinct.join(", ")}.`,
      });
    }
  }

  // Near-duplicate canonical objects: the same real person/company filed twice under a slightly
  // different name (`aurelio` + `aurelio-anastassiades`, `gruenberg` + `grueneberg`). This is a
  // warning, not an error — the names only *look* alike, so a human or a model judges whether they
  // are truly the same before running `merge`. Merged/deprecated stubs are skipped so a redirect is
  // never flagged against the survivor it already points to, and a pair already adjudicated distinct
  // (linked `not_duplicate` in either direction) is suppressed so we don't re-flag genuinely
  // different look-alikes forever. Compared within a type only; O(n²) over live canonical objects,
  // which is fine for realistic memory trees.
  const liveCanonical = [...byId.entries()]
    .filter(([, entry]) => isLiveCanonical(entry.parsed.frontmatter))
    .map(([id, entry]) => ({
      id,
      type: entry.parsed.frontmatter.type,
      names: entityNames(entry.parsed.title, id, entry.parsed.frontmatter.aliases ?? []),
      notDuplicateOf: new Set(
        (entry.parsed.frontmatter.related ?? [])
          .filter((r) => r.type === "not_duplicate")
          .map((r) => r.target),
      ),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (let i = 0; i < liveCanonical.length; i++) {
    const a = liveCanonical[i];
    if (!a) continue;
    for (let j = i + 1; j < liveCanonical.length; j++) {
      const b = liveCanonical[j];
      if (!b || a.type !== b.type) continue;
      if (a.notDuplicateOf.has(b.id) || b.notDuplicateOf.has(a.id)) continue;
      if (areAnyNamesSimilar(a.names, b.names)) {
        findings.push({
          severity: "warn",
          code: "near_duplicate",
          id: `${a.id},${b.id}`,
          message: `"${a.id}" and "${b.id}" look like the same ${a.type}. If they are, merge them (\`memory merge --from <duplicate> --into <record-to-keep>\`, then \`memory rewrite\`).`,
        });
      }
    }
  }

  for (const file of files) {
    const entry = byId.get(file.id);
    if (!entry) continue;
    const { parsed } = entry;
    const fm = parsed.frontmatter;

    // Strict frontmatter / per-type validation (provenance, subjects, timestamps, etc.).
    const validation = validateDocument(parsed, file.id);
    if (!validation.ok) {
      for (const error of validation.errors) {
        findings.push({ severity: "error", code: "invalid", id: file.id, message: error });
      }
    }

    // Body shape.
    if (!file.source.includes(TRUTH_HEADING) || !file.source.includes(TIMELINE_HEADING)) {
      findings.push({
        severity: "error",
        code: "body_shape",
        id: file.id,
        message: "Missing the '## Compiled truth' or '## Timeline' section.",
      });
    }

    // Type/folder agreement.
    const folder = file.relativePath.slice(0, file.relativePath.lastIndexOf("/"));
    const expectedType = typeForFolder(folder);
    if (expectedType && fm.type && expectedType !== fm.type) {
      findings.push({
        severity: "error",
        code: "type_folder_mismatch",
        id: file.id,
        message: `Type "${fm.type}" sits in "${folder}/" (expected type "${expectedType}").`,
      });
    }

    // Broken related links.
    for (const rel of fm.related ?? []) {
      if (!byId.has(rel.target))
        findings.push({
          severity: "error",
          code: "broken_related",
          id: file.id,
          message: `Related id "${rel.target}" (${rel.type}) does not exist.`,
        });
    }

    // Broken merged_into target.
    if (fm.mergedInto && !byId.has(fm.mergedInto)) {
      findings.push({
        severity: "error",
        code: "broken_merge",
        id: file.id,
        message: `merged_into target "${fm.mergedInto}" does not exist.`,
      });
    }

    if (isCanonicalType(fm.type)) {
      // Citations in compiled truth must resolve to evidence that lists this object.
      for (const cited of extractCitations(parsed.compiledTruth)) {
        const evidence = byId.get(cited);
        if (!evidence) {
          findings.push({
            severity: "error",
            code: "broken_citation",
            id: file.id,
            message: `Cited evidence "${cited}" does not exist.`,
          });
        } else if (!(evidence.parsed.frontmatter.subjects ?? []).includes(file.id)) {
          findings.push({
            severity: "error",
            code: "unlinked_citation",
            id: file.id,
            message: `Cited evidence "${cited}" does not list "${file.id}" as a subject.`,
          });
        }
      }

      // Stale: compiled truth older than the newest evidence about this object.
      const newestEvidence = newestSubjectEvidence(file.id, byId);
      if (newestEvidence && fm.updatedAt && newestEvidence > fm.updatedAt) {
        findings.push({
          severity: "warn",
          code: "stale",
          id: file.id,
          message: "Newer evidence exists than the last compiled-truth rewrite.",
        });
      }
    }

    if (isEvidenceType(fm.type)) {
      // Orphan evidence: dangling subjects, or not cited by any subject's compiled truth.
      const liveSubjects = (fm.subjects ?? []).filter((s) => byId.has(s));
      if (liveSubjects.length === 0) {
        findings.push({
          severity: "error",
          code: "orphan_evidence",
          id: file.id,
          message: "Evidence has no existing subjects.",
        });
      } else if (!citedEvidence.has(file.id)) {
        findings.push({
          severity: "warn",
          code: "uncited_evidence",
          id: file.id,
          message: "Evidence is not cited by any subject's compiled truth.",
        });
      }
    }
  }

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warn");
  const summary = `${files.length} files checked — ${errors.length} error(s), ${warnings.length} warning(s).`;
  const text = [
    summary,
    ...findings.map((f) => `  [${f.severity}] ${f.code} (${f.id}): ${f.message}`),
  ].join("\n");

  const result = { summary, findings };
  return errors.length > 0 ? fail(text, 1, result) : ok(text, result);
}

function newestSubjectEvidence(
  subjectId: string,
  byId: Map<string, { parsed: ReturnType<typeof parseDocument> }>,
): string | null {
  let newest: string | null = null;
  for (const { parsed } of byId.values()) {
    if (!isEvidenceType(parsed.frontmatter.type)) continue;
    if (!(parsed.frontmatter.subjects ?? []).includes(subjectId)) continue;
    const captured = parsed.frontmatter.source?.capturedAt ?? parsed.frontmatter.createdAt ?? null;
    if (captured && (!newest || captured > newest)) newest = captured;
  }
  return newest;
}
