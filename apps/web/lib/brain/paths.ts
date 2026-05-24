export const BRAIN_ROOT = "brain";
export const MAX_BRAIN_FILE_BYTES = 256 * 1024;
export const MAX_BRAIN_MOUNT_FILES = 80;
export const MAX_BRAIN_MOUNT_BYTES = 2 * 1024 * 1024;

export function normalizeBrainPath(input: string, options: { allowFolder?: boolean } = {}) {
  const raw = input
    .trim()
    .replace(/^brain\//, "")
    .replace(/^\/+/, "");
  const isFolder = options.allowFolder && raw.endsWith("/");
  const normalized = raw.split("/").filter(Boolean).join("/");
  const path = isFolder ? `${normalized}/` : normalized;

  if (!path || path === "/" || path.startsWith(".") || path.includes("..")) {
    throw new Error("Brain path must be a relative path inside brain/.");
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\/?$/.test(path)) {
    throw new Error("Brain path contains unsupported characters.");
  }

  return path;
}

export function workspaceBrainPath(path: string) {
  return `${BRAIN_ROOT}/${normalizeBrainPath(path)}`;
}

export function conflictPath(path: string) {
  const normalized = normalizeBrainPath(path);
  const dot = normalized.lastIndexOf(".");
  const suffix = `.conflict-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (dot <= 0) return `${normalized}${suffix}`;
  return `${normalized.slice(0, dot)}${suffix}${normalized.slice(dot)}`;
}

export function isBrainTextFile(path: string) {
  const normalized = normalizeBrainPath(path);
  return !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|mp4|mov|mp3|woff2?)$/i.test(normalized);
}
