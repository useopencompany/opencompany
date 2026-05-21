import { createHash } from "node:crypto";

export function hashAgentSource(source: string) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}
