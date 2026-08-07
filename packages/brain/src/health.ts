import { extractBrainCitations, parseBrainDocument } from "./document";
import { deriveBrainEdges } from "./edges";
import { parseBrainInlineLinks } from "./inline-links";
import { brainRelativePath } from "./paths";
import { isValidBrainFolder, isValidBrainId, isValidBrainSourceRef } from "./schema";
import { listBrainFiles, type StoredBrainFile } from "./store";
import { validateBrainDocument } from "./validate";

export type BrainHealthFinding = {
  severity: "error" | "warn";
  code: string;
  id: string;
  message: string;
};

export type BrainHealthReport = {
  files: number;
  errors: number;
  warnings: number;
  findings: BrainHealthFinding[];
};

export async function checkBrainHealth(root: string): Promise<BrainHealthReport> {
  const files = await listBrainFiles(root);
  const findings: BrainHealthFinding[] = [];
  const idCounts = new Map<string, number>();
  const byId = new Map<
    string,
    { file: StoredBrainFile; doc: ReturnType<typeof parseBrainDocument> }
  >();
  const parsedFiles: Array<{
    file: StoredBrainFile;
    doc: ReturnType<typeof parseBrainDocument>;
  }> = [];
  const aliasOwners = new Map<string, string>();

  for (const file of files) {
    idCounts.set(file.id, (idCounts.get(file.id) ?? 0) + 1);
    try {
      const doc = parseBrainDocument(file.source);
      parsedFiles.push({ file, doc });
      if (!byId.has(file.id)) byId.set(file.id, { file, doc });
    } catch (error) {
      findings.push({
        severity: "error",
        code: "parse_error",
        id: file.id,
        message: error instanceof Error ? error.message : "Failed to parse brain document.",
      });
    }
  }

  for (const [id, count] of idCounts) {
    if (count > 1) {
      findings.push({
        severity: "error",
        code: "duplicate_id",
        id,
        message: `Id "${id}" is used by ${count} files.`,
      });
    }
  }

  const degreeById = graphDegreeById(byId);
  const evidenceRecordIds = new Set(
    parsedFiles.filter(({ doc }) => doc.frontmatter.kind === "evidence").map(({ file }) => file.id),
  );

  for (const { file, doc } of parsedFiles) {
    const validation = validateBrainDocument(doc, file.id, file.source);
    if (!validation.ok) {
      for (const message of validation.errors) {
        findings.push({ severity: "error", code: "invalid", id: file.id, message });
      }
    }

    const expectedPath =
      doc.frontmatter.folder &&
      doc.frontmatter.id &&
      isValidBrainFolder(doc.frontmatter.folder) &&
      isValidBrainId(doc.frontmatter.id)
        ? brainRelativePath(doc.frontmatter.folder, doc.frontmatter.id)
        : null;
    if (expectedPath && expectedPath !== file.relativePath) {
      findings.push({
        severity: "error",
        code: "path_mismatch",
        id: file.id,
        message: `File path "${file.relativePath}" should be "${expectedPath}".`,
      });
    }

    checkRelations({ id: file.id, byId, relations: doc.frontmatter.relations ?? [], findings });

    for (const alias of doc.frontmatter.aliases ?? []) {
      const key = alias.toLowerCase();
      const owner = aliasOwners.get(key);
      if (owner && owner !== file.id) {
        findings.push({
          severity: "error",
          code: "alias_collision",
          id: file.id,
          message: `Alias "${alias}" is already used by "${owner}".`,
        });
      } else {
        aliasOwners.set(key, file.id);
      }
    }

    const inlineLinkText = [doc.compiledTruth, ...doc.timeline.map((entry) => entry.body)].join(
      "\n\n",
    );
    checkInlineLinks({
      id: file.id,
      byId,
      text: inlineLinkText,
      findings,
    });
    checkCitations({
      id: file.id,
      localEvidenceIds: new Set(doc.timeline.map((entry) => entry.evidenceId)),
      evidenceRecordIds,
      text: inlineLinkText,
      findings,
    });

    if (files.length > 1 && (degreeById.get(file.id) ?? 0) === 0) {
      findings.push({
        severity: "warn",
        code: "orphan_node",
        id: file.id,
        message: "Document has no incoming or outgoing valid graph edges.",
      });
    }

    for (const sourceEntry of doc.frontmatter.sources ?? []) {
      const ref = sourceEntry.ref.trim();
      if (ref && !isValidBrainSourceRef(ref)) {
        findings.push({
          severity: "warn",
          code: "nonstandard_source_ref",
          id: file.id,
          message: `Source ref "${ref}" is not provider:id shaped.`,
        });
      }
    }

    if (
      doc.frontmatter.kind !== "evidence" &&
      doc.compiledTruth.trim() &&
      doc.timeline.length === 0 &&
      !(doc.frontmatter.sources ?? []).length
    ) {
      findings.push({
        severity: "warn",
        code: "weak_provenance",
        id: file.id,
        message: "Compiled truth has no timeline entries or sources.",
      });
    }
  }

  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warn").length;
  return { files: files.length, errors, warnings, findings };
}

function checkCitations(input: {
  id: string;
  localEvidenceIds: Set<string>;
  evidenceRecordIds: Set<string>;
  text: string;
  findings: BrainHealthFinding[];
}) {
  for (const citation of extractBrainCitations(input.text)) {
    if (input.localEvidenceIds.has(citation) || input.evidenceRecordIds.has(citation)) continue;
    input.findings.push({
      severity: "error",
      code: "broken_citation",
      id: input.id,
      message: `Citation "${citation}" does not match a local timeline entry or evidence record.`,
    });
  }
}

function graphDegreeById(
  byId: Map<string, { file: StoredBrainFile; doc: ReturnType<typeof parseBrainDocument> }>,
) {
  const degreeById = new Map([...byId.keys()].map((id) => [id, 0]));
  for (const [id, { doc }] of byId) {
    for (const edge of deriveBrainEdges({
      id,
      relations: doc.frontmatter.relations ?? [],
      body: [doc.compiledTruth, ...doc.timeline.map((entry) => entry.body)].join("\n\n"),
    })) {
      if (!byId.has(edge.to)) continue;
      degreeById.set(edge.from, (degreeById.get(edge.from) ?? 0) + 1);
      degreeById.set(edge.to, (degreeById.get(edge.to) ?? 0) + 1);
    }
  }
  return degreeById;
}

function checkRelations(input: {
  id: string;
  byId: Map<string, unknown>;
  relations: Array<{ type: string; to: string }>;
  findings: BrainHealthFinding[];
}) {
  for (const relation of input.relations) {
    if (!input.byId.has(relation.to)) {
      input.findings.push({
        severity: "error",
        code: "broken_relation",
        id: input.id,
        message: `Relation target "${relation.to}" does not exist.`,
      });
    }
  }
}

function checkInlineLinks(input: {
  id: string;
  byId: Map<string, unknown>;
  text: string;
  findings: BrainHealthFinding[];
}) {
  for (const link of parseBrainInlineLinks(input.text)) {
    if (!link.valid) {
      input.findings.push({
        severity: "error",
        code: link.kind === "page" ? "invalid_wiki_link" : `invalid_${link.kind}_link`,
        id: input.id,
        message: `${link.kind} link target "${link.target}" is invalid.`,
      });
      continue;
    }
    if (link.kind === "page" && !input.byId.has(link.target)) {
      input.findings.push({
        severity: "error",
        code: "broken_wiki_link",
        id: input.id,
        message: `Wiki link target "${link.target}" does not exist.`,
      });
    }
  }
}
