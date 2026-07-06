import { parseGoatBrainDocument } from "./document";
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
  const aliasOwners = new Map<string, string>();

  for (const file of files) {
    idCounts.set(file.id, (idCounts.get(file.id) ?? 0) + 1);
    if (!byId.has(file.id)) byId.set(file.id, { file, doc: parseGoatBrainDocument(file.source) });
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

  for (const file of files) {
    const doc = parseGoatBrainDocument(file.source);
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
