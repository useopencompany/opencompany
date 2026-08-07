import { parse } from "dotenv";

export const GOAT_REPO_ENV_MAX_BYTES = 256 * 1024;
export const GOAT_REPO_SETUP_INSTRUCTIONS_MAX_LENGTH = 4_000;

export type ValidatedRepoEnv = { ok: true } | { ok: false; message: string };

export function validateRepoEnv(content: string): ValidatedRepoEnv {
  if (!content.trim()) {
    return { ok: false, message: "Paste an environment file before saving." };
  }
  if (content.includes("\0")) {
    return { ok: false, message: "Environment files cannot contain null bytes." };
  }
  if (Buffer.byteLength(content, "utf8") > GOAT_REPO_ENV_MAX_BYTES) {
    return {
      ok: false,
      message: `Environment files must be ${GOAT_REPO_ENV_MAX_BYTES / 1024} KB or smaller.`,
    };
  }

  const keys = Object.keys(parse(content));
  if (keys.length === 0) {
    return { ok: false, message: "No environment variables were found." };
  }
  if (keys.length > 512) {
    return { ok: false, message: "Environment files can contain at most 512 variables." };
  }
  if (keys.some((key) => key.length > 256)) {
    return { ok: false, message: "Environment variable names must be 256 characters or fewer." };
  }
  return { ok: true };
}

export function normalizeRepoSetupInstructions(
  value: string,
): { ok: true; instructions: string } | { ok: false; message: string } {
  const instructions = value.trim();
  if (instructions.length > GOAT_REPO_SETUP_INSTRUCTIONS_MAX_LENGTH) {
    return {
      ok: false,
      message: `Setup instructions must be ${GOAT_REPO_SETUP_INSTRUCTIONS_MAX_LENGTH.toLocaleString()} characters or fewer.`,
    };
  }
  return { ok: true, instructions };
}
