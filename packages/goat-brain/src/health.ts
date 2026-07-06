import { extractGoatBrainCitations, parseGoatBrainDocument } from "./document";
import { deriveGoatBrainEdges } from "./edges";
import { goatBrainRelativePath } from "./paths";
import { isValidGoatBrainFolder, isValidGoatBrainId } from "./schema";
import { listGoatBrainFiles, type StoredGoatBrainFile } from "./store";
import { validateGoatBrainDocument } from "./validate";
import { parseGoatBrainWikiLinks } from "./wiki-links";

export type GoatBrainHealthFinding = {
  severity: "error" | "warn";
  code: string;
  id: string;
  message: string;
};

export type GoatBrainHealthReport = {
  files: number;
  errors: number;
  warnings: number;
  findings: GoatBrainHealthFinding[];
};

export async function checkGoatBrainHealth(root: string): Promise<GoatBrainHealthReport> {
  const files = await listGoatBrainFiles(root);
  const findings: GoatBrainHealthFinding[] = [];
  const idCounts = new Map<string, number>();
  const byId = new Map<
    string,
    { file: StoredGoatBrainFile; doc: ReturnType<typeof parseGoatBrainDocument> }
  >();
  const parsedFiles: Array<{
    file: StoredGoatBrainFile;
    doc: ReturnType<typeof parseGoatBrainDocument>;
  }> = [];
  const aliasOwners = new Map<string, string>();

  for (const file of files) {
    idCounts.set(file.id, (idCounts.get(file.id) ?? 0) + 1);
    try {
      const doc = parseGoatBrainDocument(file.source);
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
    parsedFiles.filter(({ doc }) => doc.frontmatter.type === "evidence").map(({ file }) => file.id),
  );

  for (const { file, doc } of parsedFiles) {
    const validation = validateGoatBrainDocument(doc, file.id, file.source);
    if (!validation.ok) {
      for (const message of validation.errors) {
        findings.push({ severity: "error", code: "invalid", id: file.id, message });
      }
    }

    const expectedPath =
      doc.frontmatter.folder &&
      doc.frontmatter.id &&
      isValidGoatBrainFolder(doc.frontmatter.folder) &&
      isValidGoatBrainId(doc.frontmatter.id)
        ? goatBrainRelativePath(doc.frontmatter.folder, doc.frontmatter.id)
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

    checkWikiLinks({
      id: file.id,
      byId,
      text: doc.compiledTruth,
      findings,
    });
    checkCitations({
      id: file.id,
      localEvidenceIds: new Set(doc.timeline.map((entry) => entry.evidenceId)),
      evidenceRecordIds,
      text: doc.compiledTruth,
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

    if (
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
  findings: GoatBrainHealthFinding[];
}) {
  for (const citation of extractGoatBrainCitations(input.text)) {
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
  byId: Map<string, { file: StoredGoatBrainFile; doc: ReturnType<typeof parseGoatBrainDocument> }>,
) {
  const degreeById = new Map([...byId.keys()].map((id) => [id, 0]));
  for (const [id, { doc }] of byId) {
    for (const edge of deriveGoatBrainEdges({
      id,
      relations: doc.frontmatter.relations ?? [],
      body: doc.compiledTruth,
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
  findings: GoatBrainHealthFinding[];
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

function checkWikiLinks(input: {
  id: string;
  byId: Map<string, unknown>;
  text: string;
  findings: GoatBrainHealthFinding[];
}) {
  for (const link of parseGoatBrainWikiLinks(input.text)) {
    if (!link.valid) {
      input.findings.push({
        severity: "error",
        code: "invalid_wiki_link",
        id: input.id,
        message: `Wiki link target "${link.target}" is not a valid brain id.`,
      });
      continue;
    }
    if (!input.byId.has(link.target)) {
      input.findings.push({
        severity: "error",
        code: "broken_wiki_link",
        id: input.id,
        message: `Wiki link target "${link.target}" does not exist.`,
      });
    }
  }
}
