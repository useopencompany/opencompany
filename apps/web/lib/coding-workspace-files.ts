/** Client half of the coding-workspace file protocol served by `apps/runner`. */

export type WorkspaceFileEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  symlink: boolean;
};

export type WorkspaceDirectoryListing = {
  path: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
};

export type WorkspaceFileContent =
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

export type WorkspaceFileError = {
  /** Which request failed, so the tree, the editor, and a save each show their own error. */
  scope: "list" | "open" | "save";
  path: string;
  code:
    | "invalid_path"
    | "not_found"
    | "not_a_file"
    | "not_a_directory"
    | "too_large"
    | "conflict"
    | "failed";
  message: string;
};

export type WorkspaceFileMessage =
  | ({ type: "files.listing" } & WorkspaceDirectoryListing)
  | ({ type: "files.content" } & WorkspaceFileContent)
  | { type: "files.saved"; path: string; revision: string; size: number }
  | ({ type: "files.error" } & WorkspaceFileError);

export function parseWorkspaceFileMessage(raw: unknown): WorkspaceFileMessage | null {
  if (typeof raw !== "string") return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || typeof value.path !== "string") return null;
  const path = value.path;

  if (value.type === "files.listing" && Array.isArray(value.entries)) {
    return {
      type: "files.listing",
      path,
      entries: value.entries.filter(isWorkspaceFileEntry),
      truncated: value.truncated === true,
    };
  }
  if (value.type === "files.content" && typeof value.size === "number") {
    if (
      value.kind === "text" &&
      typeof value.content === "string" &&
      typeof value.revision === "string"
    ) {
      return {
        type: "files.content",
        path,
        kind: "text",
        content: value.content,
        revision: value.revision,
        size: value.size,
        editable: value.editable === true,
      };
    }
    if (value.kind === "image" && typeof value.dataUrl === "string") {
      // The data URL is rendered in an <img>, so refuse anything that is not an inline image.
      if (!/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]*$/i.test(value.dataUrl)) return null;
      return {
        type: "files.content",
        path,
        kind: "image",
        dataUrl: value.dataUrl,
        size: value.size,
      };
    }
    if (value.kind === "binary" || value.kind === "too_large") {
      return { type: "files.content", path, kind: value.kind, size: value.size };
    }
    return null;
  }
  if (
    value.type === "files.saved" &&
    typeof value.revision === "string" &&
    typeof value.size === "number"
  ) {
    return { type: "files.saved", path, revision: value.revision, size: value.size };
  }
  if (value.type === "files.error" && typeof value.message === "string") {
    return {
      type: "files.error",
      scope: isWorkspaceFileErrorScope(value.scope) ? value.scope : "open",
      path,
      code: isWorkspaceFileErrorCode(value.code) ? value.code : "failed",
      message: value.message,
    };
  }
  return null;
}

function isWorkspaceFileEntry(value: unknown): value is WorkspaceFileEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === "string" &&
    typeof entry.path === "string" &&
    (entry.type === "file" || entry.type === "directory") &&
    typeof entry.size === "number" &&
    typeof entry.symlink === "boolean"
  );
}

function isWorkspaceFileErrorScope(value: unknown): value is WorkspaceFileError["scope"] {
  return value === "list" || value === "open" || value === "save";
}

function isWorkspaceFileErrorCode(value: unknown): value is WorkspaceFileError["code"] {
  return (
    value === "invalid_path" ||
    value === "not_found" ||
    value === "not_a_file" ||
    value === "not_a_directory" ||
    value === "too_large" ||
    value === "conflict" ||
    value === "failed"
  );
}

export function parentDirectoryPath(filePath: string) {
  const index = filePath.lastIndexOf("/");
  return index === -1 ? "" : filePath.slice(0, index);
}

/** Every ancestor directory of a path, outermost first, so the tree can reveal a file. */
export function ancestorDirectoryPaths(filePath: string) {
  const segments = filePath.split("/").slice(0, -1);
  return segments.map((_segment, index) => segments.slice(0, index + 1).join("/"));
}

export function formatFileSize(bytes: number) {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
