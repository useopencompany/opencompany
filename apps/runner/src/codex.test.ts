import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistRefreshedCodexAuth } from "./codex";

const codexAuthMocks = vi.hoisted(() => ({
  loadCodexCredential: vi.fn(),
  markCodexCredentialNeedsReauth: vi.fn(),
  rotateCodexCredential: vi.fn(),
}));

vi.mock("@opencompany/db/codex-auth", () => codexAuthMocks);
vi.mock("./db", () => ({ getDb: () => ({}) }));

function sandboxWithAuthFile(content: string | null) {
  return {
    files: {
      read: vi.fn(async () => {
        if (content === null) throw new Error("ENOENT");
        return content;
      }),
    },
  } as never;
}

const auth = {
  kind: "chatgpt" as const,
  authJson: { OPENAI_API_KEY: "original" },
  credentialLastRotatedAt: new Date("2026-08-01T12:00:00.000Z"),
  brokered: false as const,
};

describe("persistRefreshedCodexAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips rotation when the sandbox auth cache is unchanged", async () => {
    const result = await persistRefreshedCodexAuth({
      sandbox: sandboxWithAuthFile(JSON.stringify(auth.authJson)),
      userWorkosId: "user_1",
      auth,
    });

    expect(result).toBe("unchanged");
    expect(codexAuthMocks.rotateCodexCredential).not.toHaveBeenCalled();
  });

  it("rotates with the loaded generation so a concurrent rotation is not clobbered", async () => {
    codexAuthMocks.rotateCodexCredential.mockResolvedValue(true);

    const result = await persistRefreshedCodexAuth({
      sandbox: sandboxWithAuthFile(JSON.stringify({ OPENAI_API_KEY: "refreshed" })),
      userWorkosId: "user_1",
      auth,
    });

    expect(result).toBe("rotated");
    expect(codexAuthMocks.rotateCodexCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        authJson: { OPENAI_API_KEY: "refreshed" },
        expectedLastRotatedAt: auth.credentialLastRotatedAt,
      }),
    );
  });

  it("reports a superseded rotation instead of overwriting newer credentials", async () => {
    codexAuthMocks.rotateCodexCredential.mockResolvedValue(false);

    const result = await persistRefreshedCodexAuth({
      sandbox: sandboxWithAuthFile(JSON.stringify({ OPENAI_API_KEY: "refreshed" })),
      userWorkosId: "user_1",
      auth,
    });

    expect(result).toBe("superseded");
  });

  it("throws when the sandbox auth cache is unreadable", async () => {
    await expect(
      persistRefreshedCodexAuth({
        sandbox: sandboxWithAuthFile(null),
        userWorkosId: "user_1",
        auth,
      }),
    ).rejects.toThrow("Codex did not leave a readable auth cache after running.");
  });

  it("throws when the sandbox auth cache is malformed", async () => {
    await expect(
      persistRefreshedCodexAuth({
        sandbox: sandboxWithAuthFile("not json"),
        userWorkosId: "user_1",
        auth,
      }),
    ).rejects.toThrow("Codex auth cache was malformed after running.");
  });
});
