import { isDeepStrictEqual } from "node:util";
import {
  loadGoatCodexCredential,
  markGoatCodexCredentialNeedsReauth,
  rotateGoatCodexCredential,
} from "@opencompany/db/goat-codex-auth";
import type { CodexCliAuth } from "./codex-cli";
import { getDb } from "./db";
import type { SandboxHandle } from "./sandbox";

const CODEX_HOME = "/home/user/.opencompany-goat/codex-home";

export async function loadGoatCodexCliAuth(userWorkosId: string): Promise<CodexCliAuth | null> {
  let credential: Awaited<ReturnType<typeof loadGoatCodexCredential>>;
  try {
    credential = await loadGoatCodexCredential({ db: getDb(), userWorkosId });
  } catch {
    await markGoatCodexCredentialNeedsReauth({
      db: getDb(),
      userWorkosId,
      statusReason: "Codex credentials could not be decrypted. Reconnect Codex in Goat settings.",
    });
    return null;
  }
  if (!credential || credential.status !== "connected") return null;
  return {
    kind: "chatgpt",
    authJson: credential.authJson,
    credentialLastRotatedAt: credential.lastRotatedAt,
    brokered: false,
  };
}

export async function persistRefreshedGoatCodexAuth(input: {
  sandbox: SandboxHandle;
  userWorkosId: string;
  auth: CodexCliAuth;
  codexHome?: string;
}) {
  if (input.auth.kind !== "chatgpt") return;
  let content: string;
  try {
    const raw = await input.sandbox.files.read(`${input.codexHome ?? CODEX_HOME}/auth.json`);
    content = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  } catch (error) {
    throw new Error("Codex did not leave a readable auth cache after running.", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error("Codex auth cache was malformed after running.", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex auth cache was malformed after running.");
  }
  if (isDeepStrictEqual(parsed, input.auth.authJson)) return "unchanged" as const;

  const rotated = await rotateGoatCodexCredential({
    db: getDb(),
    userWorkosId: input.userWorkosId,
    authJson: parsed as Record<string, unknown>,
    expectedLastRotatedAt: input.auth.credentialLastRotatedAt,
  });
  return rotated ? ("rotated" as const) : ("superseded" as const);
}
