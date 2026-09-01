import { createHash } from "node:crypto";

export function localSandboxNamespace(workspacePath = process.cwd()) {
  const workspaceId = createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
  return `local_${workspaceId}`;
}
