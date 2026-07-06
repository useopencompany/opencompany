import { createHash } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { type GoatBrainRelation, goatBrainDocuments } from "@opencompany/db/goat-schema";
import {
  GOAT_BRAIN_MARKDOWN_MIME_TYPE,
  type GoatBrainEntry,
  goatBrainEntryFromLegacyMarkdown,
  inferGoatBrainEntityTypeFromFolder,
  serializeLegacyGoatBrainEntry,
} from "@opencompany/goat-brain";
import { eq } from "drizzle-orm";

const db = getDb();
const rows = await db.select().from(goatBrainDocuments);

let migrated = 0;
for (const row of rows) {
  const parsed = safeEntry(row.content);
  const type = row.entityType ?? parsed?.type ?? inferGoatBrainEntityTypeFromFolder(row.folderPath);
  const relations = normalizeRelations(row.relations);
  const entry: GoatBrainEntry = {
    id: row.brainId,
    folder: row.folderPath,
    title: row.title?.trim() || parsed?.title || row.brainId,
    kind: row.kind,
    mimeType: row.mimeType?.trim() || parsed?.mimeType || GOAT_BRAIN_MARKDOWN_MIME_TYPE,
    body: row.body || parsed?.body || "",
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    relations,
    sources: row.sources ?? parsed?.sources ?? [],
    type,
    aliases: normalizeStringArray(row.aliases, parsed?.aliases ?? []),
    tags: parsed?.tags ?? [],
    timeline:
      row.kind === "markdown" ? normalizeTimeline(row.timeline, parsed?.timeline ?? []) : [],
    ...(row.originalFileName ? { originalFileName: row.originalFileName } : {}),
    ...(row.assetStorageKey ? { assetStorageKey: row.assetStorageKey } : {}),
  };
  const content = serializeLegacyGoatBrainEntry(entry);
  await db
    .update(goatBrainDocuments)
    .set({
      content,
      body: entry.body,
      timeline: entry.timeline,
      relations,
      entityType: type,
      aliases: entry.aliases,
      contentHash: hash(content),
      sizeBytes: Buffer.byteLength(content, "utf8"),
    })
    .where(eq(goatBrainDocuments.id, row.id));
  migrated += 1;
}

console.log(`Migrated ${migrated} Goat Brain document(s) to v2.`);

function safeEntry(content: string): GoatBrainEntry | null {
  try {
    return goatBrainEntryFromLegacyMarkdown(content);
  } catch {
    return null;
  }
}

function normalizeRelations(value: unknown): GoatBrainRelation[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item): GoatBrainRelation[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const to =
      typeof record.to === "string"
        ? record.to
        : typeof record.target === "string"
          ? record.target
          : "";
    const type =
      typeof record.type === "string" && record.type.trim() ? record.type.trim() : "related";
    if (!to || seen.has(`${type}:${to}`)) return [];
    seen.add(`${type}:${to}`);
    return [{ type, to }];
  });
}

function normalizeTimeline(value: unknown, fallback: GoatBrainEntry["timeline"]) {
  if (!Array.isArray(value)) return fallback;
  return value.flatMap((item): GoatBrainEntry["timeline"] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.at !== "string" || typeof record.body !== "string") return [];
    return [{ at: record.at, body: record.body }];
  });
}

function normalizeStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function hash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}
