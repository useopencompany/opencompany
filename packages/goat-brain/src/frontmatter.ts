import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  DEFAULT_GOAT_BRAIN_RELATION_TYPE,
  type GoatBrainFrontmatter,
  type GoatBrainRelation,
  type GoatBrainSource,
} from "./schema";

export function splitFrontmatter(source: string): { yaml: string; body: string } {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { yaml: "", body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { yaml: "", body: normalized };
  return {
    yaml: normalized.slice(4, end),
    body: normalized.slice(end + 4).replace(/^\n+/, ""),
  };
}

export function parseFrontmatter(yaml: string): Partial<GoatBrainFrontmatter> {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch {
    return {};
  }
  if (!isRecord(raw)) return {};

  const out: Partial<GoatBrainFrontmatter> = {};
  const id = readString(raw.id);
  if (id) out.id = id;
  const folder = readString(raw.folder);
  if (folder) out.folder = folder;
  const title = readString(raw.title);
  if (title) out.title = title;
  const createdAt = readString(raw.created_at);
  if (createdAt) out.createdAt = createdAt;
  const updatedAt = readString(raw.updated_at);
  if (updatedAt) out.updatedAt = updatedAt;
  out.related = readRelations(raw.related);
  const tags = readStringArray(raw.tags);
  if (tags.length > 0) out.tags = tags;
  const sources = readSources(raw.sources);
  if (sources.length > 0) out.sources = sources;
  return out;
}

export function serializeFrontmatter(frontmatter: GoatBrainFrontmatter): string {
  const record: Record<string, unknown> = {
    id: frontmatter.id,
    folder: frontmatter.folder,
    created_at: frontmatter.createdAt,
    updated_at: frontmatter.updatedAt,
    related: (frontmatter.related ?? []).map((relation) => ({
      type: relation.type,
      target: relation.target,
    })),
  };
  if (frontmatter.title) record.title = frontmatter.title;
  if (frontmatter.tags && frontmatter.tags.length > 0) record.tags = frontmatter.tags;
  if (frontmatter.sources && frontmatter.sources.length > 0) {
    record.sources = frontmatter.sources.map((source) => ({
      ref: source.ref,
      ...(source.capturedAt ? { captured_at: source.capturedAt } : {}),
      ...(source.title ? { title: source.title } : {}),
    }));
  }
  return ["---", stringifyYaml(record, { lineWidth: 0 }).trimEnd(), "---"].join("\n");
}

function readRelations(value: unknown): GoatBrainRelation[] {
  if (!Array.isArray(value)) return [];
  const out: GoatBrainRelation[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    let relation: GoatBrainRelation | null = null;
    if (typeof item === "string") {
      const target = readString(item);
      if (target) relation = { type: DEFAULT_GOAT_BRAIN_RELATION_TYPE, target };
    } else if (isRecord(item)) {
      const target = readString(item.target);
      if (target)
        relation = { type: readString(item.type) ?? DEFAULT_GOAT_BRAIN_RELATION_TYPE, target };
    }
    if (relation && !seen.has(relation.target)) {
      seen.add(relation.target);
      out.push(relation);
    }
  }
  return out;
}

function readSources(value: unknown): GoatBrainSource[] {
  if (!Array.isArray(value)) return [];
  const out: GoatBrainSource[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const ref = readString(item.ref);
    if (!ref) continue;
    const capturedAt = readString(item.captured_at);
    const title = readString(item.title);
    out.push({
      ref,
      ...(capturedAt ? { capturedAt } : {}),
      ...(title ? { title } : {}),
    });
  }
  return out;
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
