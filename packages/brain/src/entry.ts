import { createHash } from "node:crypto";
import {
  normalizeBrainBody,
  type ParsedBrainDocument,
  parseBrainDocument,
  serializeBrainDocument,
} from "./document";
import { brainRelativePath } from "./paths";
import {
  type BrainDocument,
  type BrainDocumentFormat,
  type BrainEntityType,
  type BrainFrontmatter,
  type BrainKind,
  type BrainRelation,
  type BrainSource,
  type BrainStatus,
  type BrainTimelineEntry,
  isValidBrainEntityType,
  isValidBrainFolder,
  isValidBrainId,
  isValidBrainKind,
  isValidBrainStatus,
  normalizeBrainFolder,
} from "./schema";
import { isIsoDate } from "./time";
import { validateBrainFolderKindType, validateBrainRelations } from "./validate";

export const BRAIN_ENTRY_SCHEMA_VERSION = "goat.brain.entry.v2";
export const BRAIN_MARKDOWN_MIME_TYPE = "text/markdown";

export type BrainEntryFormat = BrainDocumentFormat;

const BRAIN_ENTRY_FORMATS = new Set<BrainEntryFormat>([
  "markdown",
  "pdf",
  "docx",
  "xlsx",
  "srt",
  "csv",
  "tsv",
  "json",
  "text",
  "image",
]);

export type BrainEntry = {
  id: string;
  folder: string;
  title: string;
  description?: string;
  format: BrainEntryFormat;
  mimeType: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  relations: BrainRelation[];
  sources: BrainSource[];
  kind: BrainKind;
  type: BrainEntityType;
  status: BrainStatus;
  aliases: string[];
  timeline: BrainTimelineEntry[];
  originalFileName?: string;
  assetStorageKey?: string;
};

export type BrainPayloadDescriptor = {
  path: string;
  sha256: string;
  sizeBytes: number;
  originalFileName?: string;
};

export type BrainSidecar = {
  schemaVersion: typeof BRAIN_ENTRY_SCHEMA_VERSION;
  id: string;
  folder: string;
  title: string;
  description?: string;
  format: BrainEntryFormat;
  mimeType: string;
  createdAt: string;
  updatedAt: string;
  relations: BrainRelation[];
  sources: BrainSource[];
  kind: BrainKind;
  type: BrainEntityType;
  status?: BrainStatus;
  aliases?: string[];
  timeline?: BrainTimelineEntry[];
  assetStorageKey?: string;
  payload: BrainPayloadDescriptor;
};

export type BrainSidecarValidationResult =
  | { ok: true; entry: BrainEntry }
  | { ok: false; errors: string[] };

export function brainPayloadRelativePath(
  folder: string,
  id: string,
  format: BrainEntryFormat = "markdown",
  originalFileName?: string,
): string {
  if (format === "markdown") return brainRelativePath(folder, id);
  const normalizedFolder = normalizeBrainFolder(folder);
  if (!isValidBrainFolder(normalizedFolder)) throw new Error("Invalid brain folder.");
  if (!isValidBrainId(id)) throw new Error("Invalid brain id.");
  const extension = extensionForFormat(format, originalFileName);
  return `${normalizedFolder}/${id}.${extension}`;
}

export function brainSidecarRelativePath(folder: string, id: string): string {
  const normalizedFolder = normalizeBrainFolder(folder);
  if (!isValidBrainFolder(normalizedFolder)) throw new Error("Invalid brain folder.");
  if (!isValidBrainId(id)) throw new Error("Invalid brain id.");
  return `${normalizedFolder}/.brain/${id}.json`;
}

export function brainPayloadHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function brainPayloadSizeBytes(content: string | Uint8Array): number {
  return typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
}

export function brainEntryFromLegacyMarkdown(source: string): BrainEntry {
  return brainEntryFromParsedLegacy(parseBrainDocument(source));
}

export function brainEntryFromLegacyDocument(doc: BrainDocument): BrainEntry {
  return {
    id: doc.frontmatter.id,
    folder: doc.frontmatter.folder,
    title: (doc.frontmatter.title ?? doc.title ?? doc.frontmatter.id).trim(),
    ...(doc.frontmatter.description ? { description: doc.frontmatter.description } : {}),
    format: "markdown",
    mimeType: BRAIN_MARKDOWN_MIME_TYPE,
    body: doc.compiledTruth,
    createdAt: doc.frontmatter.createdAt,
    updatedAt: doc.frontmatter.updatedAt,
    relations: doc.frontmatter.relations ?? [],
    sources: doc.frontmatter.sources ?? [],
    kind: doc.frontmatter.kind,
    type: doc.frontmatter.type,
    status: doc.frontmatter.status ?? "draft",
    aliases: doc.frontmatter.aliases ?? [],
    timeline: doc.timeline,
  };
}

export function brainEntryFromParsedLegacy(parsed: ParsedBrainDocument): BrainEntry {
  const frontmatter = parsed.frontmatter as Partial<BrainFrontmatter>;
  const id = frontmatter.id ?? "";
  const folder = frontmatter.folder ?? "";
  if (!isValidBrainId(id)) {
    throw new Error("Brain document is missing a valid frontmatter.id.");
  }
  if (!isValidBrainFolder(folder)) {
    throw new Error("Brain document is missing a valid frontmatter.folder.");
  }
  if (!isValidBrainEntityType(frontmatter.type)) {
    throw new Error("Brain document is missing a valid frontmatter.type.");
  }
  if (!isValidBrainKind(frontmatter.kind)) {
    throw new Error("Brain document is missing a valid frontmatter.kind.");
  }
  const title = (frontmatter.title ?? parsed.title ?? id).trim();
  return {
    id,
    folder,
    title: title || id,
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    format: "markdown",
    mimeType: BRAIN_MARKDOWN_MIME_TYPE,
    body: parsed.compiledTruth,
    createdAt: frontmatter.createdAt ?? "",
    updatedAt: frontmatter.updatedAt ?? "",
    relations: frontmatter.relations ?? [],
    sources: frontmatter.sources ?? [],
    kind: frontmatter.kind,
    type: frontmatter.type,
    status: frontmatter.status ?? "draft",
    aliases: frontmatter.aliases ?? [],
    timeline: parsed.timeline,
  };
}

export function legacyBrainDocumentFromEntry(entry: BrainEntry): BrainDocument {
  return {
    frontmatter: {
      id: entry.id,
      folder: entry.folder,
      title: entry.title,
      ...(entry.description ? { description: entry.description } : {}),
      kind: entry.kind,
      type: entry.type,
      status: entry.status,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      relations: entry.relations,
      ...(entry.aliases.length > 0 ? { aliases: entry.aliases } : {}),
      ...(entry.sources.length > 0 ? { sources: entry.sources } : {}),
    },
    title: entry.title,
    compiledTruth: entry.body,
    timeline: entry.format === "markdown" ? entry.timeline : [],
  };
}

export function serializeLegacyBrainEntry(entry: BrainEntry): string {
  return serializeBrainDocument(legacyBrainDocumentFromEntry(entry));
}

export function serializeBrainPayload(entry: BrainEntry): string {
  return normalizeBrainBody(entry.body);
}

export function serializeBrainSidecar(entry: BrainEntry): string {
  const payload = serializeBrainPayload(entry);
  const payloadPath = brainPayloadRelativePath(
    entry.folder,
    entry.id,
    entry.format,
    entry.originalFileName,
  );
  const sidecar: BrainSidecar = {
    schemaVersion: BRAIN_ENTRY_SCHEMA_VERSION,
    id: entry.id,
    folder: entry.folder,
    title: entry.title,
    ...(entry.description ? { description: entry.description } : {}),
    format: entry.format,
    mimeType: entry.mimeType,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    relations: entry.relations,
    sources: entry.sources,
    kind: entry.kind,
    type: entry.type,
    status: entry.status,
    ...(entry.aliases.length > 0 ? { aliases: entry.aliases } : {}),
    ...(entry.format === "markdown" ? { timeline: entry.timeline } : {}),
    ...(entry.assetStorageKey ? { assetStorageKey: entry.assetStorageKey } : {}),
    payload: {
      path: payloadPath,
      sha256: brainPayloadHash(payload),
      sizeBytes: brainPayloadSizeBytes(payload),
      ...(entry.originalFileName ? { originalFileName: entry.originalFileName } : {}),
    },
  };
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

export function parseBrainSidecar(source: string): BrainSidecar | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  return isRecord(parsed) ? (parsed as BrainSidecar) : null;
}

export function validateBrainSidecar(input: {
  sidecar: BrainSidecar | null;
  payloadContent: string;
  payloadRelativePath: string;
}): BrainSidecarValidationResult {
  const { sidecar, errors } = validateBrainSidecarMetadata(input);
  if (!sidecar) return { ok: false, errors };
  const actualHash = brainPayloadHash(input.payloadContent);
  if (sidecar.payload?.sha256 !== actualHash) errors.push("sidecar.payload.sha256 mismatch.");
  const actualSize = brainPayloadSizeBytes(input.payloadContent);
  if (sidecar.payload?.sizeBytes !== actualSize) errors.push("sidecar.payload.sizeBytes mismatch.");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entry: entryFromValidSidecar(sidecar, input.payloadContent) };
}

export function recoverLegacyBrainEntryFromSidecar(input: {
  sidecar: BrainSidecar | null;
  payloadContent: string;
  payloadRelativePath: string;
}): string | null {
  const { sidecar, errors } = validateBrainSidecarMetadata(input);
  if (!sidecar || errors.length > 0 || sidecar.format !== "markdown") return null;
  return serializeLegacyBrainEntry(entryFromValidSidecar(sidecar, input.payloadContent));
}

function validateBrainSidecarMetadata(input: {
  sidecar: BrainSidecar | null;
  payloadRelativePath: string;
}): { sidecar: BrainSidecar | null; errors: string[] } {
  const errors: string[] = [];
  const sidecar = input.sidecar;
  if (!sidecar) return { sidecar: null, errors: ["Sidecar JSON is invalid."] };
  if (sidecar.schemaVersion !== BRAIN_ENTRY_SCHEMA_VERSION) {
    errors.push("sidecar.schemaVersion is invalid.");
  }
  if (!isValidBrainId(sidecar.id)) errors.push("sidecar.id must be a lowercase slug.");
  errors.push(
    ...validateBrainFolderKindType({
      folder: sidecar.folder,
      kind: sidecar.kind,
      type: sidecar.type,
      subject: "sidecar",
    }),
  );
  if (typeof sidecar.title !== "string" || !sidecar.title.trim()) {
    errors.push("sidecar.title must not be empty.");
  }
  if (sidecar.description !== undefined && !sidecar.description.trim()) {
    errors.push("sidecar.description must not be empty when present.");
  }
  if (sidecar.status !== undefined && !isValidBrainStatus(sidecar.status)) {
    errors.push("sidecar.status is invalid.");
  }
  if (sidecar.aliases && !validStringArray(sidecar.aliases)) {
    errors.push("sidecar.aliases must be an array of non-empty strings.");
  }
  if (sidecar.sources !== undefined && !Array.isArray(sidecar.sources)) {
    errors.push("sidecar.sources must be an array.");
  }
  if (sidecar.timeline !== undefined && !Array.isArray(sidecar.timeline)) {
    errors.push("sidecar.timeline must be an array.");
  }
  if (!BRAIN_ENTRY_FORMATS.has(sidecar.format)) {
    errors.push("sidecar.format is invalid.");
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
  errors.push(...validateBrainRelations(sidecar.relations, { fieldName: "sidecar.relations" }));
  return { sidecar, errors };
}

function entryFromValidSidecar(sidecar: BrainSidecar, payloadContent: string): BrainEntry {
  return {
    id: sidecar.id,
    folder: sidecar.folder,
    title: sidecar.title.trim(),
    ...(sidecar.description ? { description: sidecar.description.trim() } : {}),
    format: sidecar.format,
    mimeType: sidecar.mimeType,
    body: payloadContent,
    createdAt: sidecar.createdAt,
    updatedAt: sidecar.updatedAt,
    relations: Array.isArray(sidecar.relations) ? sidecar.relations : [],
    sources: Array.isArray(sidecar.sources) ? sidecar.sources : [],
    kind: sidecar.kind,
    type: sidecar.type,
    status: sidecar.status ?? "draft",
    aliases: sidecar.aliases ?? [],
    timeline:
      sidecar.format === "markdown" && Array.isArray(sidecar.timeline) ? sidecar.timeline : [],
    ...(sidecar.payload.originalFileName
      ? { originalFileName: sidecar.payload.originalFileName }
      : {}),
    ...(sidecar.assetStorageKey ? { assetStorageKey: sidecar.assetStorageKey } : {}),
  };
}

function extensionForFormat(format: BrainEntryFormat, originalFileName?: string) {
  const extension = originalFileName?.split(".").pop()?.trim().toLowerCase();
  if (extension && /^[a-z0-9]{1,12}$/.test(extension)) return extension;
  if (format === "pdf") return "pdf";
  if (format === "docx") return "docx";
  if (format === "xlsx") return "xlsx";
  if (format === "srt") return "srt";
  if (format === "csv") return "csv";
  if (format === "tsv") return "tsv";
  if (format === "json") return "json";
  if (format === "text") return "txt";
  if (format === "image") return "png";
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
