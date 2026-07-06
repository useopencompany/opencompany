import { createHash } from "node:crypto";
import {
  type ParsedGoatBrainDocument,
  parseGoatBrainDocument,
  serializeGoatBrainDocument,
} from "./document";
import { goatBrainRelativePath } from "./paths";
import {
  type GoatBrainDocument,
  type GoatBrainEntityType,
  type GoatBrainFrontmatter,
  type GoatBrainRelation,
  type GoatBrainSource,
  type GoatBrainStatus,
  type GoatBrainTimelineEntry,
  isValidGoatBrainFolder,
  isValidGoatBrainId,
  normalizeGoatBrainFolder,
} from "./schema";
import { inferGoatBrainEntityTypeFromFolder } from "./schemas";
import { isIsoDate } from "./time";
import { validateGoatBrainFolderType, validateGoatBrainRelations } from "./validate";

export const GOAT_BRAIN_ENTRY_SCHEMA_VERSION = "goat.brain.entry.v1";
export const GOAT_BRAIN_MARKDOWN_MIME_TYPE = "text/markdown";

export type GoatBrainEntryKind = "markdown" | "pdf" | "docx";

export type GoatBrainEntry = {
  id: string;
  folder: string;
  title: string;
  kind: GoatBrainEntryKind;
  mimeType: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  relations: GoatBrainRelation[];
  sources: GoatBrainSource[];
  type: GoatBrainEntityType;
  status: GoatBrainStatus;
  aliases: string[];
  tags: string[];
  timeline: GoatBrainTimelineEntry[];
  originalFileName?: string;
  assetStorageKey?: string;
};

export type GoatBrainPayloadDescriptor = {
  path: string;
  sha256: string;
  sizeBytes: number;
  originalFileName?: string;
};

export type GoatBrainSidecar = {
  schemaVersion: typeof GOAT_BRAIN_ENTRY_SCHEMA_VERSION;
  id: string;
  folder: string;
  title: string;
  kind: GoatBrainEntryKind;
  mimeType: string;
  createdAt: string;
  updatedAt: string;
  relations: GoatBrainRelation[];
  sources: GoatBrainSource[];
  type: GoatBrainEntityType;
  status?: GoatBrainStatus;
  aliases?: string[];
  tags: string[];
  timeline?: GoatBrainTimelineEntry[];
  assetStorageKey?: string;
  payload: GoatBrainPayloadDescriptor;
};

export type GoatBrainSidecarValidationResult =
  | { ok: true; entry: GoatBrainEntry }
  | { ok: false; errors: string[] };

export function goatBrainPayloadRelativePath(
  folder: string,
  id: string,
  kind: GoatBrainEntryKind = "markdown",
  originalFileName?: string,
): string {
  if (kind === "markdown") return goatBrainRelativePath(folder, id);
  const normalizedFolder = normalizeGoatBrainFolder(folder);
  if (!isValidGoatBrainFolder(normalizedFolder)) throw new Error("Invalid brain folder.");
  if (!isValidGoatBrainId(id)) throw new Error("Invalid brain id.");
  const extension = extensionForKind(kind, originalFileName);
  return `${normalizedFolder}/${id}.${extension}`;
}

export function goatBrainSidecarRelativePath(folder: string, id: string): string {
  const normalizedFolder = normalizeGoatBrainFolder(folder);
  if (!isValidGoatBrainFolder(normalizedFolder)) throw new Error("Invalid brain folder.");
  if (!isValidGoatBrainId(id)) throw new Error("Invalid brain id.");
  return `${normalizedFolder}/.brain/${id}.json`;
}

export function goatBrainPayloadHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function goatBrainPayloadSizeBytes(content: string | Uint8Array): number {
  return typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
}

export function goatBrainEntryFromLegacyMarkdown(source: string): GoatBrainEntry {
  return goatBrainEntryFromParsedLegacy(parseGoatBrainDocument(source));
}

export function goatBrainEntryFromLegacyDocument(doc: GoatBrainDocument): GoatBrainEntry {
  return {
    id: doc.frontmatter.id,
    folder: doc.frontmatter.folder,
    title: (doc.frontmatter.title ?? doc.title ?? doc.frontmatter.id).trim(),
    kind: "markdown",
    mimeType: GOAT_BRAIN_MARKDOWN_MIME_TYPE,
    body: doc.compiledTruth,
    createdAt: doc.frontmatter.createdAt,
    updatedAt: doc.frontmatter.updatedAt,
    relations: doc.frontmatter.relations ?? [],
    sources: doc.frontmatter.sources ?? [],
    type: doc.frontmatter.type ?? inferGoatBrainEntityTypeFromFolder(doc.frontmatter.folder),
    status: doc.frontmatter.status ?? "draft",
    aliases: doc.frontmatter.aliases ?? [],
    tags: doc.frontmatter.tags ?? [],
    timeline: doc.timeline,
  };
}

export function goatBrainEntryFromParsedLegacy(parsed: ParsedGoatBrainDocument): GoatBrainEntry {
  const frontmatter = parsed.frontmatter as Partial<GoatBrainFrontmatter>;
  const id = frontmatter.id ?? "";
  const folder = frontmatter.folder ?? "";
  if (!isValidGoatBrainId(id)) {
    throw new Error("Legacy brain document is missing a valid frontmatter.id.");
  }
  if (!isValidGoatBrainFolder(folder)) {
    throw new Error("Legacy brain document is missing a valid frontmatter.folder.");
  }
  const title = (frontmatter.title ?? parsed.title ?? id).trim();
  return {
    id,
    folder,
    title: title || id,
    kind: "markdown",
    mimeType: GOAT_BRAIN_MARKDOWN_MIME_TYPE,
    body: parsed.compiledTruth,
    createdAt: frontmatter.createdAt ?? "",
    updatedAt: frontmatter.updatedAt ?? "",
    relations: frontmatter.relations ?? [],
    sources: frontmatter.sources ?? [],
    type: frontmatter.type ?? inferGoatBrainEntityTypeFromFolder(folder),
    status: frontmatter.status ?? "draft",
    aliases: frontmatter.aliases ?? [],
    tags: frontmatter.tags ?? [],
    timeline: parsed.timeline,
  };
}

export function legacyGoatBrainDocumentFromEntry(entry: GoatBrainEntry): GoatBrainDocument {
  return {
    frontmatter: {
      id: entry.id,
      folder: entry.folder,
      title: entry.title,
      type: entry.type,
      status: entry.status,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      relations: entry.relations,
      ...(entry.aliases.length > 0 ? { aliases: entry.aliases } : {}),
      ...(entry.tags.length > 0 ? { tags: entry.tags } : {}),
      ...(entry.sources.length > 0 ? { sources: entry.sources } : {}),
    },
    title: entry.title,
    compiledTruth: entry.body,
    timeline: entry.kind === "markdown" ? entry.timeline : [],
  };
}

export function serializeLegacyGoatBrainEntry(entry: GoatBrainEntry): string {
  return serializeGoatBrainDocument(legacyGoatBrainDocumentFromEntry(entry));
}

export function serializeGoatBrainPayload(entry: GoatBrainEntry): string {
  return entry.body;
}

export function serializeGoatBrainSidecar(entry: GoatBrainEntry): string {
  const payload = serializeGoatBrainPayload(entry);
  const payloadPath = goatBrainPayloadRelativePath(
    entry.folder,
    entry.id,
    entry.kind,
    entry.originalFileName,
  );
  const sidecar: GoatBrainSidecar = {
    schemaVersion: GOAT_BRAIN_ENTRY_SCHEMA_VERSION,
    id: entry.id,
    folder: entry.folder,
    title: entry.title,
    kind: entry.kind,
    mimeType: entry.mimeType,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    relations: entry.relations,
    sources: entry.sources,
    type: entry.type,
    status: entry.status,
    ...(entry.aliases.length > 0 ? { aliases: entry.aliases } : {}),
    tags: entry.tags,
    ...(entry.kind === "markdown" ? { timeline: entry.timeline } : {}),
    ...(entry.assetStorageKey ? { assetStorageKey: entry.assetStorageKey } : {}),
    payload: {
      path: payloadPath,
      sha256: goatBrainPayloadHash(payload),
      sizeBytes: goatBrainPayloadSizeBytes(payload),
      ...(entry.originalFileName ? { originalFileName: entry.originalFileName } : {}),
    },
  };
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

export function parseGoatBrainSidecar(source: string): GoatBrainSidecar | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  return isRecord(parsed) ? (parsed as GoatBrainSidecar) : null;
}

export function validateGoatBrainSidecar(input: {
  sidecar: GoatBrainSidecar | null;
  payloadContent: string;
  payloadRelativePath: string;
}): GoatBrainSidecarValidationResult {
  const errors: string[] = [];
  const sidecar = input.sidecar;
  if (!sidecar) return { ok: false, errors: ["Sidecar JSON is invalid."] };
  if (sidecar.schemaVersion !== GOAT_BRAIN_ENTRY_SCHEMA_VERSION) {
    errors.push("sidecar.schemaVersion is invalid.");
  }
  if (!isValidGoatBrainId(sidecar.id)) errors.push("sidecar.id must be a lowercase slug.");
  errors.push(
    ...validateGoatBrainFolderType({
      folder: sidecar.folder,
      type: sidecar.type,
      subject: "sidecar",
    }),
  );
  if (typeof sidecar.title !== "string" || !sidecar.title.trim()) {
    errors.push("sidecar.title must not be empty.");
  }
  if (
    sidecar.status !== undefined &&
    sidecar.status !== "draft" &&
    sidecar.status !== "active" &&
    sidecar.status !== "archived" &&
    sidecar.status !== "merged"
  ) {
    errors.push("sidecar.status is invalid.");
  }
  if (sidecar.aliases && !validStringArray(sidecar.aliases)) {
    errors.push("sidecar.aliases must be an array of non-empty strings.");
  }
  if (sidecar.tags !== undefined && !validStringArray(sidecar.tags)) {
    errors.push("sidecar.tags must be an array of non-empty strings.");
  }
  if (sidecar.sources !== undefined && !Array.isArray(sidecar.sources)) {
    errors.push("sidecar.sources must be an array.");
  }
  if (sidecar.timeline !== undefined && !Array.isArray(sidecar.timeline)) {
    errors.push("sidecar.timeline must be an array.");
  }
  if (sidecar.kind !== "markdown" && sidecar.kind !== "pdf" && sidecar.kind !== "docx") {
    errors.push("sidecar.kind is invalid.");
  }
  if (typeof sidecar.mimeType !== "string" || !sidecar.mimeType.trim()) {
    errors.push("sidecar.mimeType must not be empty.");
  }
  if (!isIsoDate(sidecar.createdAt)) errors.push("sidecar.createdAt must be ISO-8601 UTC.");
  if (!isIsoDate(sidecar.updatedAt)) errors.push("sidecar.updatedAt must be ISO-8601 UTC.");
  if (!sidecar.payload || !isRecord(sidecar.payload)) errors.push("sidecar.payload is required.");
  if (sidecar.payload?.path !== input.payloadRelativePath) {
    errors.push("sidecar.payload.path does not match the payload path.");
  }
  const actualHash = goatBrainPayloadHash(input.payloadContent);
  if (sidecar.payload?.sha256 !== actualHash) errors.push("sidecar.payload.sha256 mismatch.");
  const actualSize = goatBrainPayloadSizeBytes(input.payloadContent);
  if (sidecar.payload?.sizeBytes !== actualSize) errors.push("sidecar.payload.sizeBytes mismatch.");
  errors.push(...validateGoatBrainRelations(sidecar.relations, { fieldName: "sidecar.relations" }));
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    entry: {
      id: sidecar.id,
      folder: sidecar.folder,
      title: sidecar.title.trim(),
      kind: sidecar.kind,
      mimeType: sidecar.mimeType,
      body: input.payloadContent,
      createdAt: sidecar.createdAt,
      updatedAt: sidecar.updatedAt,
      relations: Array.isArray(sidecar.relations) ? sidecar.relations : [],
      sources: Array.isArray(sidecar.sources) ? sidecar.sources : [],
      type: sidecar.type,
      status: sidecar.status ?? "draft",
      aliases: sidecar.aliases ?? [],
      tags: Array.isArray(sidecar.tags) ? sidecar.tags : [],
      timeline:
        sidecar.kind === "markdown" && Array.isArray(sidecar.timeline) ? sidecar.timeline : [],
      ...(sidecar.payload.originalFileName
        ? { originalFileName: sidecar.payload.originalFileName }
        : {}),
      ...(sidecar.assetStorageKey ? { assetStorageKey: sidecar.assetStorageKey } : {}),
    },
  };
}

function extensionForKind(kind: GoatBrainEntryKind, originalFileName?: string) {
  const extension = originalFileName?.split(".").pop()?.trim().toLowerCase();
  if (extension && /^[a-z0-9]{1,12}$/.test(extension)) return extension;
  if (kind === "pdf") return "pdf";
  if (kind === "docx") return "docx";
  return "md";
}

function validStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
