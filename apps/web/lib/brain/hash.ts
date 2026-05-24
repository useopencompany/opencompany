import { createHash } from "node:crypto";

export function hashBrainContent(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function brainContentSize(content: string) {
  return Buffer.byteLength(content, "utf8");
}
