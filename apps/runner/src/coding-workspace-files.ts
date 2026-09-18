import { createHash } from "node:crypto";
import path from "node:path";
import { shellQuote } from "@opencompany/agent-runtime";
import type { SandboxHandle } from "./sandbox";

/** Entries returned for one directory. Deep trees stay responsive because the client
 *  expands one level at a time, so this only guards pathological directories. */
const MAX_DIRECTORY_ENTRIES = 1_000;
/** Largest file the editor will load as text. */
export const MAX_TEXT_FILE_BYTES = 512 * 1_024;
/** Largest file the editor will let you change. Saves travel as one JSON frame, so this
 *  stays well inside the runtime socket's payload limit even after JSON escaping. */
export const MAX_EDITABLE_FILE_BYTES = 256 * 1_024;
/** Largest image inlined as a data URL. */
export const MAX_IMAGE_PREVIEW_BYTES = 1_024 * 1_024;

const IMAGE_MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export type CodingWorkspaceFileErrorCode =
  | "invalid_path"
  | "not_found"
  | "not_a_file"
  | "not_a_directory"
  | "too_large"
  | "conflict";

export class CodingWorkspaceFileError extends Error {
  constructor(
    message: string,
    readonly code: CodingWorkspaceFileErrorCode,
  ) {
    super(message);
    this.name = "CodingWorkspaceFileError";
  }
}

export type CodingWorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  symlink: boolean;
};

export type CodingWorkspaceDirectoryListing = {
  path: string;
  entries: CodingWorkspaceDirectoryEntry[];
  truncated: boolean;
};

export type CodingWorkspaceFileContent =
  | {
      path: string;
      kind: "text";
      content: string;
      revision: string;
      size: number;
      editable: boolean;
    }
  | { path: string; kind: "image"; dataUrl: string; size: number }
  | { path: string; kind: "binary" | "too_large"; size: number };

export type CodingWorkspaceFileSaved = { path: string; revision: string; size: number };

/**
 * Normalizes a client-supplied workspace path to a POSIX path relative to the work
 * directory. Rejects absolute paths and anything that climbs out of the workspace before
 * the sandbox is ever touched.
 */
export function normalizeWorkspaceRelativePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new CodingWorkspaceFileError("A workspace path is required.", "invalid_path");
  }
  if (value.includes("\0")) {
    throw new CodingWorkspaceFileError("That path is not valid.", "invalid_path");
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "/") return "";
  if (path.posix.isAbsolute(trimmed)) {
    throw new CodingWorkspaceFileError(
      "Only paths inside the working directory can be opened.",
      "invalid_path",
    );
  }
  const normalized = path.posix.normalize(trimmed).replace(/\/+$/, "");
  if (
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new CodingWorkspaceFileError(
      "Only paths inside the working directory can be opened.",
      "invalid_path",
    );
  }
  return normalized;
}

export function isPathWithinDirectory(candidate: string, directory: string) {
  const root = directory.replace(/\/+$/, "");
  return Boolean(candidate && root && (candidate === root || candidate.startsWith(`${root}/`)));
}

/**
 * Resolves a workspace-relative path to its canonical absolute path in the sandbox and
 * proves the result is still inside the work directory. Resolving through `realpath`
 * closes the symlink-escape hole that a purely lexical check would leave open.
 */
async function resolveRealPath(
  sandbox: SandboxHandle,
  workDirectory: string,
  relativePath: string,
) {
  const requested = path.posix.resolve(workDirectory, relativePath);
  if (!isPathWithinDirectory(requested, workDirectory)) {
    throw new CodingWorkspaceFileError(
      "Only paths inside the working directory can be opened.",
      "invalid_path",
    );
  }
  const result = await sandbox.commands.run(`realpath -e -- ${shellQuote(requested)}`, {
    user: "user",
    timeoutMs: 10_000,
  });
  const realPath = String(result.stdout ?? "").trim();
  if (result.exitCode !== 0 || !realPath) {
    throw new CodingWorkspaceFileError("That file no longer exists.", "not_found");
  }
  if (!isPathWithinDirectory(realPath, workDirectory)) {
    throw new CodingWorkspaceFileError(
      "That path points outside the working directory.",
      "invalid_path",
    );
  }
  return realPath;
}

export async function listCodingWorkspaceDirectory(
  sandbox: SandboxHandle,
  input: { workDirectory: string; relativePath: string },
): Promise<CodingWorkspaceDirectoryListing> {
  const realPath = await resolveRealPath(sandbox, input.workDirectory, input.relativePath);
  const info = await sandbox.files.getInfo(realPath, { user: "user" });
  if (info.type !== "dir") {
    throw new CodingWorkspaceFileError("That path is not a directory.", "not_a_directory");
  }

  const listed = await sandbox.files.list(realPath, { user: "user" });
  const entries = listed.map((entry) => ({
    name: entry.name,
    path: input.relativePath === "" ? entry.name : `${input.relativePath}/${entry.name}`,
    // Symlinked directories are rare inside a checkout and resolving each one costs a
    // round trip, so they list as files and report the real problem when opened.
    type: entry.type === "dir" ? ("directory" as const) : ("file" as const),
    size: entry.type === "dir" ? 0 : entry.size,
    symlink: entry.type === "symlink",
  }));
  entries.sort(compareDirectoryEntries);
  return {
    path: input.relativePath,
    entries: entries.slice(0, MAX_DIRECTORY_ENTRIES),
    truncated: entries.length > MAX_DIRECTORY_ENTRIES,
  };
}

/** Directories first, then a case-insensitive natural sort, matching every file explorer. */
export function compareDirectoryEntries(
  a: Pick<CodingWorkspaceDirectoryEntry, "name" | "type">,
  b: Pick<CodingWorkspaceDirectoryEntry, "name" | "type">,
) {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });
}

export async function readCodingWorkspaceFile(
  sandbox: SandboxHandle,
  input: { workDirectory: string; relativePath: string },
): Promise<CodingWorkspaceFileContent> {
  const realPath = await resolveRealPath(sandbox, input.workDirectory, input.relativePath);
  const info = await sandbox.files.getInfo(realPath, { user: "user" });
  if (info.type !== "file") {
    throw new CodingWorkspaceFileError("Only files can be opened here.", "not_a_file");
  }

  const mediaType = IMAGE_MEDIA_TYPE_BY_EXTENSION[path.posix.extname(realPath).toLowerCase()];
  const limit = mediaType ? MAX_IMAGE_PREVIEW_BYTES : MAX_TEXT_FILE_BYTES;
  if (info.size > limit) {
    return { path: input.relativePath, kind: "too_large", size: info.size };
  }

  const bytes = Buffer.from(await sandbox.files.read(realPath, { format: "bytes", user: "user" }));
  if (mediaType) {
    return {
      path: input.relativePath,
      kind: "image",
      dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`,
      size: bytes.byteLength,
    };
  }

  const content = decodeUtf8Text(bytes);
  if (content === null) {
    return { path: input.relativePath, kind: "binary", size: bytes.byteLength };
  }
  return {
    path: input.relativePath,
    kind: "text",
    content,
    revision: revisionOf(bytes),
    size: bytes.byteLength,
    editable: bytes.byteLength <= MAX_EDITABLE_FILE_BYTES,
  };
}

export async function writeCodingWorkspaceFile(
  sandbox: SandboxHandle,
  input: {
    workDirectory: string;
    relativePath: string;
    content: string;
    /** Revision the edit was based on, or null to overwrite whatever is on disk. */
    baseRevision: string | null;
  },
): Promise<CodingWorkspaceFileSaved> {
  const next = Buffer.from(input.content, "utf8");
  if (next.byteLength > MAX_EDITABLE_FILE_BYTES) {
    throw new CodingWorkspaceFileError(
      `Files larger than ${Math.round(MAX_EDITABLE_FILE_BYTES / 1_024)} KB cannot be saved from the editor.`,
      "too_large",
    );
  }

  const realPath = await resolveRealPath(sandbox, input.workDirectory, input.relativePath);
  const info = await sandbox.files.getInfo(realPath, { user: "user" });
  if (info.type !== "file") {
    throw new CodingWorkspaceFileError("Only files can be saved here.", "not_a_file");
  }

  if (input.baseRevision !== null) {
    const current = Buffer.from(
      await sandbox.files.read(realPath, { format: "bytes", user: "user" }),
    );
    if (revisionOf(current) !== input.baseRevision) {
      throw new CodingWorkspaceFileError(
        "This file changed in the workspace after you opened it.",
        "conflict",
      );
    }
  }

  await sandbox.files.write(realPath, input.content, { user: "user" });
  return {
    path: input.relativePath,
    revision: revisionOf(next),
    size: next.byteLength,
  };
}

function revisionOf(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Returns null when the bytes are not valid UTF-8 text, which is how binaries are detected. */
export function decodeUtf8Text(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
