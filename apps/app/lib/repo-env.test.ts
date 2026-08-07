import { describe, expect, it } from "vitest";
import {
  GOAT_REPO_ENV_MAX_BYTES,
  normalizeGoatRepoSetupInstructions,
  validateGoatRepoEnv,
} from "./repo-env";

describe("validateGoatRepoEnv", () => {
  it("accepts dotenv files with comments, quotes, multiline values, and equals signs", () => {
    const result = validateGoatRepoEnv(`# local setup
DATABASE_URL="database.example.test/db?sslmode=require"
TOKEN='abc=def'
export API_URL=https://example.test/api
PRIVATE_KEY="-----BEGIN KEY-----
line=inside-the-value
-----END KEY-----"
EMPTY=
`);

    expect(result).toEqual({ ok: true });
  });

  it("rejects empty and oversized files without returning any values", () => {
    expect(validateGoatRepoEnv("# comments only")).toEqual({
      ok: false,
      message: "No environment variables were found.",
    });
    expect(validateGoatRepoEnv(`KEY=${"x".repeat(GOAT_REPO_ENV_MAX_BYTES)}`)).toEqual({
      ok: false,
      message: "Environment files must be 256 KB or smaller.",
    });
    expect(validateGoatRepoEnv(`${"K".repeat(257)}=value`)).toEqual({
      ok: false,
      message: "Environment variable names must be 256 characters or fewer.",
    });
  });
});

describe("normalizeGoatRepoSetupInstructions", () => {
  it("trims the workspace instructions", () => {
    expect(normalizeGoatRepoSetupInstructions("  run bun install  ")).toEqual({
      ok: true,
      instructions: "run bun install",
    });
  });
});
