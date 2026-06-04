import { createHash, randomUUID } from "node:crypto";

export function hashContent(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function conflictPath(path: string) {
  const dot = path.lastIndexOf(".");
  // Random (not timestamp) suffix so concurrent conflicts can't collide.
  const suffix = `.conflict-${randomUUID().slice(0, 8)}`;
  if (dot <= 0) return `${path}${suffix}`;
  return `${path.slice(0, dot)}${suffix}${path.slice(dot)}`;
}
