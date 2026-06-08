import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_RELATION_TYPE, type MemoryFrontmatter, type MemoryRelation, type MemorySource } from "./schema";

// On-disk YAML uses snake_case (created_at, merged_into, captured_at); the TS model uses
// camelCase. These two functions are the only place that mapping lives.

export function splitFrontmatter(source: string): { yaml: string; body: string } {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { yaml: "", body: normalized };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return { yaml: "", body: normalized };
  }
  return {
    yaml: normalized.slice(4, end),
    body: normalized.slice(end + 4).replace(/^\n+/, ""),
  };
}

// Lenient parse — never throws, fills only what it can read. Strict checks live in validate.ts
// so a hand-edited file surfaces actionable errors rather than silently degrading.
export function parseFrontmatter(yaml: string): Partial<MemoryFrontmatter> {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch {
    return {};
  }
  if (!isRecord(raw)) return {};

  const out: Partial<MemoryFrontmatter> = {};
  const id = readString(raw.id);
  if (id) out.id = id;
  const type = readString(raw.type);
  if (type) out.type = type as MemoryFrontmatter["type"];
  const status = readString(raw.status);
  if (status) out.status = status as MemoryFrontmatter["status"];
  const createdAt = readString(raw.created_at);
  if (createdAt) out.createdAt = createdAt;
  const updatedAt = readString(raw.updated_at);
  if (updatedAt) out.updatedAt = updatedAt;
  out.related = readRelations(raw.related);

  const aliases = readStringArray(raw.aliases);
  if (aliases.length > 0) out.aliases = aliases;
  const mergedInto = readString(raw.merged_into);
  if (mergedInto) out.mergedInto = mergedInto;

  const subjects = readStringArray(raw.subjects);
  if (subjects.length > 0) out.subjects = subjects;
  const source = parseSource(raw.source);
  if (source) out.source = source;

  return out;
}

// Read the typed-edge list, deduping by target (one edge per target). A bare string entry is
// read as an untyped edge (`{ type: "related", target }`) so legacy `related: [id, id]` files
// keep working; object entries `{ type, target }` are read as-is.
function readRelations(value: unknown): MemoryRelation[] {
  if (!Array.isArray(value)) return [];
  const out: MemoryRelation[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    let relation: MemoryRelation | null = null;
    if (typeof item === "string") {
      const target = readString(item);
      if (target) relation = { type: DEFAULT_RELATION_TYPE, target };
    } else if (isRecord(item)) {
      const target = readString(item.target);
      if (target) relation = { type: readString(item.type) ?? DEFAULT_RELATION_TYPE, target };
    }
    if (relation && !seen.has(relation.target)) {
      seen.add(relation.target);
      out.push(relation);
    }
  }
  return out;
}

function parseSource(value: unknown): MemorySource | null {
  if (!isRecord(value)) return null;
  const ref = readString(value.ref);
  const capturedAt = readString(value.captured_at);
  if (!ref || !capturedAt) return null;
  const author = readString(value.author);
  return {
    ref,
    capturedAt,
    ...(author ? { author } : {}),
  };
}

// Serialize to deterministic snake_case YAML. Empty optional fields are omitted so files stay
// clean and round-trip stably.
export function serializeFrontmatter(frontmatter: MemoryFrontmatter): string {
  const record: Record<string, unknown> = {
    id: frontmatter.id,
    type: frontmatter.type,
    status: frontmatter.status,
    created_at: frontmatter.createdAt,
    updated_at: frontmatter.updatedAt,
    related: (frontmatter.related ?? []).map((r) => ({ type: r.type, target: r.target })),
  };
  if (frontmatter.aliases && frontmatter.aliases.length > 0) record.aliases = frontmatter.aliases;
  if (frontmatter.mergedInto) record.merged_into = frontmatter.mergedInto;
  if (frontmatter.subjects && frontmatter.subjects.length > 0)
    record.subjects = frontmatter.subjects;
  if (frontmatter.source) {
    record.source = {
      ref: frontmatter.source.ref,
      captured_at: frontmatter.source.capturedAt,
      ...(frontmatter.source.author ? { author: frontmatter.source.author } : {}),
    };
  }
  return ["---", stringifyYaml(record, { lineWidth: 0 }).trimEnd(), "---"].join("\n");
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const str = readString(item);
    if (str && !seen.has(str)) {
      seen.add(str);
      out.push(str);
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
