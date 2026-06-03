import { createHash } from "node:crypto";

/**
 * Compute the Git blob SHA-1 for a UTF-8 string, matching exactly what GitHub
 * stores for a file's content. Git hashes `blob <byteLength>\0<content>`.
 *
 * Computing this locally lets the workspace reconcile diff desired content
 * (from the DB) against the current GitHub tree without fetching each file —
 * we only push blobs whose SHA differs.
 */
export function gitBlobSha(content: string): string {
  const body = Buffer.from(content, "utf8");
  const header = Buffer.from(`blob ${body.length}\0`, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([header, body]))
    .digest("hex");
}
