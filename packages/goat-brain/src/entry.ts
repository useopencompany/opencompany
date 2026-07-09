import { createHash } from "node:crypto";
import {
  normalizeGoatBrainBody,
  type ParsedGoatBrainDocument,
  parseGoatBrainDocument,
  serializeGoatBrainDocument,
} from "./document";
import { goatBrainRelativePath } from "./paths";
import {
  type GoatBrainDocument,
  type GoatBrainEntityType,
  type GoatBrainFrontmatter,
  type GoatBrainKind,
  type GoatBrainRelation,
  type GoatBrainSource,
  type GoatBrainStatus,
  type GoatBrainTimelineEntry,
  isValidGoatBrainEntityType,
  isValidGoatBrainFolder,
  isValidGoatBrainId,
  isValidGoatBrainKind,
  isValidGoatBrainStatus,
  normalizeGoatBrainFolder,
} from "./schema";
import { isIsoDate } from "./time";
import { validateGoatBrainFolderKindType, validateGoatBrainRelations } from "./validate";

export const GOAT_BRAIN_ENTRY_SCHEMA_VERSION = "goat.brain.entry.v2";
export const GOAT_BRAIN_MARKDOWN_MIME_TYPE = "text/markdown";

export type GoatBrainEntryFormat = "markdown" | "pdf" | "docx";

export type GoatBrainEntry = {
  id: string;
  folder: string;
  title: string;
  format: GoatBrainEntryFormat;
  mimeType: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  relations: GoatBrainRelation[];
  sources: GoatBrainSource[];
  kind: GoatBrainKind;
  type: GoatBrainEntityType;
  status: GoatBrainStatus;
  aliases: string[];
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
  format: GoatBrainEntryFormat;
  mimeType: string;
  createdAt: string;
  updatedAt: string;
  relations: GoatBrainRelation[];
  sources: GoatBrainSource[];
  kind: GoatBrainKind;
  type: GoatBrainEntityType;
  status?: GoatBrainStatus;
  aliases?: string[];
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
  format: GoatBrainEntryFormat = "markdown",
  originalFileName?: string,
): string {
  if (format === "markdown") return goatBrainRelativePath(folder, id);
  const normalizedFolder = normalizeGoatBrainFolder(folder);
  if (!isValidGoatBrainFolder(normalizedFolder)) throw new Error("Invalid brain folder.");
  if (!isValidGoatBrainId(id)) throw new Error("Invalid brain id.");
  const extension = extensionForFormat(format, originalFileName);
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
    format: "markdown",
    mimeType: GOAT_BRAIN_MARKDOWN_MIME_TYPE,
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

export function goatBrainEntryFromParsedLegacy(parsed: ParsedGoatBrainDocument): GoatBrainEntry {
  const frontmatter = parsed.frontmatter as Partial<GoatBrainFrontmatter>;
  const id = frontmatter.id ?? "";
  const folder = frontmatter.folder ?? "";
  if (!isValidGoatBrainId(id)) {
    throw new Error("Brain document is missing a valid frontmatter.id.");
  }
  if (!isValidGoatBrainFolder(folder)) {
    throw new Error("Brain document is missing a valid frontmatter.folder.");
  }
  if (!isValidGoatBrainEntityType(frontmatter.type)) {
    throw new Error("Brain document is missing a valid frontmatter.type.");
  }
  if (!isValidGoatBrainKind(frontmatter.kind)) {
    throw new Error("Brain document is missing a valid frontmatter.kind.");
  }
  const title = (frontmatter.title ?? parsed.title ?? id).trim();
  return {
    id,
    folder,
    title: title || id,
    format: "markdown",
    mimeType: GOAT_BRAIN_MARKDOWN_MIME_TYPE,
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

export function legacyGoatBrainDocumentFromEntry(entry: GoatBrainEntry): GoatBrainDocument {
  return {
    frontmatter: {
      id: entry.id,
      folder: entry.folder,
      title: entry.title,
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

export function serializeLegacyGoatBrainEntry(entry: GoatBrainEntry): string {
  return serializeGoatBrainDocument(legacyGoatBrainDocumentFromEntry(entry));
}

export function serializeGoatBrainPayload(entry: GoatBrainEntry): string {
  return normalizeGoatBrainBody(entry.body);
}

export function serializeGoatBrainSidecar(entry: GoatBrainEntry): string {
  const payload = serializeGoatBrainPayload(entry);
  const payloadPath = goatBrainPayloadRelativePath(
    entry.folder,
    entry.id,
    entry.format,
    entry.originalFileName,
  );
  const sidecar: GoatBrainSidecar = {
    schemaVersion: GOAT_BRAIN_ENTRY_SCHEMA_VERSION,
    id: entry.id,
    folder: entry.folder,
    title: entry.title,
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
  const { sidecar, errors } = validateGoatBrainSidecarMetadata(input);
  if (!sidecar) return { ok: false, errors };
  const actualHash = goatBrainPayloadHash(input.payloadContent);
  if (sidecar.payload?.sha256 !== actualHash) errors.push("sidecar.payload.sha256 mismatch.");
  const actualSize = goatBrainPayloadSizeBytes(input.payloadContent);
  if (sidecar.payload?.sizeBytes !== actualSize) errors.push("sidecar.payload.sizeBytes mismatch.");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entry: entryFromValidSidecar(sidecar, input.payloadContent) };
}

export function recoverLegacyGoatBrainEntryFromSidecar(input: {
  sidecar: GoatBrainSidecar | null;
  payloadContent: string;
  payloadRelativePath: string;
}): string | null {
  const { sidecar, errors } = validateGoatBrainSidecarMetadata(input);
  if (!sidecar || errors.length > 0 || sidecar.format !== "markdown") return null;
  return serializeLegacyGoatBrainEntry(entryFromValidSidecar(sidecar, input.payloadContent));
}

function validateGoatBrainSidecarMetadata(input: {
  sidecar: GoatBrainSidecar | null;
  payloadRelativePath: string;
}): { sidecar: GoatBrainSidecar | null; errors: string[] } {
  const errors: string[] = [];
  const sidecar = input.sidecar;
  if (!sidecar) return { sidecar: null, errors: ["Sidecar JSON is invalid."] };
  if (sidecar.schemaVersion !== GOAT_BRAIN_ENTRY_SCHEMA_VERSION) {
    errors.push("sidecar.schemaVersion is invalid.");
  }
  if (!isValidGoatBrainId(sidecar.id)) errors.push("sidecar.id must be a lowercase slug.");
  errors.push(
    ...validateGoatBrainFolderKindType({
      folder: sidecar.folder,
      kind: sidecar.kind,
      type: sidecar.type,
      subject: "sidecar",
    }),
  );
  if (typeof sidecar.title !== "string" || !sidecar.title.trim()) {
    errors.push("sidecar.title must not be empty.");
  }
  if (sidecar.status !== undefined && !isValidGoatBrainStatus(sidecar.status)) {
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
  if (sidecar.format !== "markdown" && sidecar.format !== "pdf" && sidecar.format !== "docx") {
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
  errors.push(...validateGoatBrainRelations(sidecar.relations, { fieldName: "sidecar.relations" }));
  return { sidecar, errors };
}

function entryFromValidSidecar(sidecar: GoatBrainSidecar, payloadContent: string): GoatBrainEntry {
  return {
    id: sidecar.id,
    folder: sidecar.folder,
    title: sidecar.title.trim(),
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

function extensionForFormat(format: GoatBrainEntryFormat, originalFileName?: string) {
  const extension = originalFileName?.split(".").pop()?.trim().toLowerCase();
  if (extension && /^[a-z0-9]{1,12}$/.test(extension)) return extension;
  if (format === "pdf") return "pdf";
  if (format === "docx") return "docx";
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
