import { parse as parseYaml } from "yaml";

// Strict parser for a single Agent Skills `SKILL.md` document.
//
// This is the one authoritative Skills parser. It implements the official frontmatter contract
// exactly — the six supported fields, their value constraints, and the rule that `name` must equal
// the containing directory — plus opencompany's client policy that unknown top-level frontmatter
// fields are rejected. It performs no command extension, slug normalization, auto-suffixing, or
// opencompany-specific description handling. It returns the exact body boundary so callers can
// slice the model-facing body without re-parsing.

export class SkillSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillSpecError";
  }
}

// The six official frontmatter fields. `allowedTools` carries the raw space-separated `allowed-tools`
// string verbatim; this release stores but does not enforce it.
export type SkillFrontmatter = {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
};

export type ParsedSkillDocument = {
  frontmatter: SkillFrontmatter;
  // The exact document body: everything after the closing `---` delimiter line.
  body: string;
  // Index into the original content string where `body` begins (the exact body boundary).
  bodyStart: number;
};

// Official name rule: 1-64 chars, lowercase alphanumerics and hyphens, no leading/trailing hyphen,
// no consecutive hyphens. The pattern encodes all of those at once.
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const COMPATIBILITY_MAX = 500;

const KNOWN_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

type Frontmatter = { yamlText: string; bodyStart: number };

// Split leading YAML frontmatter from the body, tolerating a UTF-8 BOM, CRLF or LF newlines, and a
// missing final newline. Returns null when the document does not open with a frontmatter block.
function splitFrontmatter(content: string): Frontmatter | null {
  // A leading BOM precedes the opening delimiter; skip it for detection but keep byte offsets
  // relative to the original string so `bodyStart` stays exact.
  const bomOffset = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  const afterBom = content.slice(bomOffset);

  const open = /^---[ \t]*(?:\r\n|\n)/.exec(afterBom);
  if (!open) return null;
  const yamlStart = bomOffset + open[0].length;

  // The closing delimiter is a line consisting solely of `---` (optional trailing spaces/tabs),
  // introduced by a newline and terminated by a newline or end-of-input.
  const closeRe = /(?:\r\n|\n)---[ \t]*(?:\r\n|\n|$)/g;
  closeRe.lastIndex = yamlStart;
  const close = closeRe.exec(content);
  if (!close) return null;

  const yamlText = content.slice(yamlStart, close.index);
  const bodyStart = close.index + close[0].length;
  return { yamlText, bodyStart };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new SkillSpecError(`Frontmatter field \`${field}\` must be a string.`);
  }
  return value;
}

function parseMetadata(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillSpecError("Frontmatter field `metadata` must be a map of string values.");
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") {
      throw new SkillSpecError(`Frontmatter field \`metadata.${key}\` must be a string.`);
    }
    out[key] = entry;
  }
  return out;
}

// Parse and strictly validate a SKILL.md document. `expectedName` is the name of the directory that
// contains the SKILL.md; the frontmatter `name` must equal it. Throws SkillSpecError on any
// violation.
export function parseSkillDocument(content: string, expectedName: string): ParsedSkillDocument {
  const split = splitFrontmatter(content);
  if (!split) {
    throw new SkillSpecError("SKILL.md must begin with a YAML frontmatter block.");
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(split.yamlText);
  } catch {
    throw new SkillSpecError("SKILL.md frontmatter is not valid YAML.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SkillSpecError("SKILL.md frontmatter must be a YAML mapping.");
  }
  const record = parsed as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!KNOWN_FIELDS.has(key)) {
      throw new SkillSpecError(`Unknown frontmatter field \`${key}\`.`);
    }
  }

  const name = requireString(record.name, "name");
  if (name.length > SKILL_NAME_MAX || !SKILL_NAME_RE.test(name)) {
    throw new SkillSpecError(
      "Skill `name` must be 1-64 lowercase alphanumeric characters and hyphens, with no leading, trailing, or repeated hyphens.",
    );
  }
  if (name !== expectedName) {
    throw new SkillSpecError(
      `Skill \`name\` (${name}) must match its directory name (${expectedName}).`,
    );
  }

  const description = requireString(record.description, "description");
  if (description.trim().length === 0 || description.length > DESCRIPTION_MAX) {
    throw new SkillSpecError("Skill `description` must be 1-1024 non-empty characters.");
  }

  const frontmatter: SkillFrontmatter = { name, description };

  if (record.license !== undefined) {
    frontmatter.license = requireString(record.license, "license");
  }
  if (record.compatibility !== undefined) {
    const compatibility = requireString(record.compatibility, "compatibility");
    if (compatibility.length === 0 || compatibility.length > COMPATIBILITY_MAX) {
      throw new SkillSpecError("Skill `compatibility` must be 1-500 characters.");
    }
    frontmatter.compatibility = compatibility;
  }
  if (record.metadata !== undefined) {
    frontmatter.metadata = parseMetadata(record.metadata);
  }
  if (record["allowed-tools"] !== undefined) {
    frontmatter.allowedTools = requireString(record["allowed-tools"], "allowed-tools");
  }

  return { frontmatter, body: content.slice(split.bodyStart), bodyStart: split.bodyStart };
}
