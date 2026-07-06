import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  DEFAULT_GOAT_BRAIN_RELATION_TYPE,
  type GoatBrainFrontmatter,
  type GoatBrainRelation,
  type GoatBrainSource,
  type GoatBrainStatus,
} from "./schema";
import { normalizeBuiltInGoatBrainEntityType } from "./schemas";

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
  const type = normalizeBuiltInGoatBrainEntityType(readString(raw.type) ?? undefined);
  if (type) out.type = type;
  const status = readStatus(raw.status);
  if (status) out.status = status;
  const aliases = readStringArray(raw.aliases);
  if (aliases.length > 0) out.aliases = aliases;
  const createdAt = readString(raw.createdAt) ?? readString(raw.created_at);
  if (createdAt) out.createdAt = createdAt;
  const updatedAt = readString(raw.updatedAt) ?? readString(raw.updated_at);
  if (updatedAt) out.updatedAt = updatedAt;
  out.relations = readRelations("related" in raw ? raw.related : raw.relations);
  const mergedInto = readString(raw.mergedInto) ?? readString(raw.merged_into);
  if (mergedInto) out.mergedInto = mergedInto;
  const legacyKeys = ["schema_type", "metadata"].filter((key) => key in raw);
  if (legacyKeys.length > 0) out.legacyKeys = legacyKeys;
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
    type: frontmatter.type,
    status: frontmatter.status,
    createdAt: frontmatter.createdAt,
    updatedAt: frontmatter.updatedAt,
    related: (frontmatter.relations ?? []).map((relation) => ({
      type: relation.type,
      to: relation.to,
    })),
  };
  if (frontmatter.title) record.title = frontmatter.title;
  if (frontmatter.aliases && frontmatter.aliases.length > 0) record.aliases = frontmatter.aliases;
  if (frontmatter.tags && frontmatter.tags.length > 0) record.tags = frontmatter.tags;
  if (frontmatter.mergedInto) record.mergedInto = frontmatter.mergedInto;
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
      if (target) relation = { type: DEFAULT_GOAT_BRAIN_RELATION_TYPE, to: target };
    } else if (isRecord(item)) {
      const target = readString(item.to);
      if (target)
        relation = { type: readString(item.type) ?? DEFAULT_GOAT_BRAIN_RELATION_TYPE, to: target };
    }
    if (relation && !seen.has(relation.to)) {
      seen.add(relation.to);
      out.push(relation);
    }
  }
  return out;
}

function readStatus(value: unknown): GoatBrainStatus | null {
  const status = readString(value);
  if (status === "draft" || status === "active" || status === "archived" || status === "merged") {
    return status;
  }
  return null;
}

function readSources(value: unknown): GoatBrainSource[] {
  if (!Array.isArray(value)) return [];
  const out: GoatBrainSource[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const ref = readString(item.ref);
    if (!ref) continue;
    const capturedAt = readString(item.captured_at) ?? readString(item.capturedAt);
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
