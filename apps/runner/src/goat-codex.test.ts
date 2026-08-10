import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistRefreshedGoatCodexAuth } from "./goat-codex";

const codexAuthMocks = vi.hoisted(() => ({
  loadGoatCodexCredential: vi.fn(),
  markGoatCodexCredentialNeedsReauth: vi.fn(),
  rotateGoatCodexCredential: vi.fn(),
}));

vi.mock("@opencompany/db/goat-codex-auth", () => codexAuthMocks);
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

describe("persistRefreshedGoatCodexAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips rotation when the sandbox auth cache is unchanged", async () => {
    const result = await persistRefreshedGoatCodexAuth({
      sandbox: sandboxWithAuthFile(JSON.stringify(auth.authJson)),
      userWorkosId: "user_1",
      auth,
    });

    expect(result).toBe("unchanged");
    expect(codexAuthMocks.rotateGoatCodexCredential).not.toHaveBeenCalled();
  });

  it("rotates with the loaded generation so a concurrent rotation is not clobbered", async () => {
    codexAuthMocks.rotateGoatCodexCredential.mockResolvedValue(true);

    const result = await persistRefreshedGoatCodexAuth({
      sandbox: sandboxWithAuthFile(JSON.stringify({ OPENAI_API_KEY: "refreshed" })),
      userWorkosId: "user_1",
      auth,
    });

    expect(result).toBe("rotated");
    expect(codexAuthMocks.rotateGoatCodexCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        authJson: { OPENAI_API_KEY: "refreshed" },
        expectedLastRotatedAt: auth.credentialLastRotatedAt,
      }),
    );
  });

  it("reports a superseded rotation instead of overwriting newer credentials", async () => {
    codexAuthMocks.rotateGoatCodexCredential.mockResolvedValue(false);

    const result = await persistRefreshedGoatCodexAuth({
      sandbox: sandboxWithAuthFile(JSON.stringify({ OPENAI_API_KEY: "refreshed" })),
      userWorkosId: "user_1",
      auth,
    });

    expect(result).toBe("superseded");
  });

  it("throws when the sandbox auth cache is unreadable", async () => {
    await expect(
      persistRefreshedGoatCodexAuth({
        sandbox: sandboxWithAuthFile(null),
        userWorkosId: "user_1",
        auth,
      }),
    ).rejects.toThrow("Codex did not leave a readable auth cache after running.");
  });

  it("throws when the sandbox auth cache is malformed", async () => {
    await expect(
      persistRefreshedGoatCodexAuth({
        sandbox: sandboxWithAuthFile("not json"),
        userWorkosId: "user_1",
        auth,
      }),
    ).rejects.toThrow("Codex auth cache was malformed after running.");
  });
});
