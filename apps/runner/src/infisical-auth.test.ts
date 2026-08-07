import { describe, expect, it, vi } from "vitest";
import {
  decodeInfisicalBrowserToken,
  ensureInfisicalTmuxInstalled,
  parseInfisicalLoginUrl,
} from "./infisical-auth";
import { INFISICAL_CLI_LINUX_AMD64_SHA256 } from "./infisical-version";
import type { SandboxHandle } from "./sandbox";

describe("Infisical CLI browser login", () => {
  it("pins the published Linux amd64 release checksum", () => {
    expect(INFISICAL_CLI_LINUX_AMD64_SHA256).toBe(
      "f00f2d8db130ba7938efeea17d6f95ca054db2824cc704f78c6f0877bfd99950",
    );
  });

  it("installs tmux as root when a stock Codex sandbox does not include it", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const sandbox = { commands: { run } } as unknown as SandboxHandle;

    await ensureInfisicalTmuxInstalled(sandbox);

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining("apt-get install -y -qq --no-install-recommends tmux"),
      { user: "root", timeoutMs: 120_000 },
    );
  });

  it("accepts only the pinned Infisical Cloud callback URL", () => {
    expect(
      parseInfisicalLoginUrl(
        "To complete your login, open this address in your browser: https://app.infisical.com/login?callback_port=43123",
      ),
    ).toBe("https://app.infisical.com/login?callback_port=43123");
    expect(
      parseInfisicalLoginUrl(
        "To complete your login, open this address in your browser: https://app.infisical\n.com/login?callback_port=43123",
      ),
    ).toBe("https://app.infisical.com/login?callback_port=43123");
    expect(parseInfisicalLoginUrl("https://evil.example/login?callback_port=43123")).toBeNull();
    expect(
      parseInfisicalLoginUrl("https://app.infisical.com/login?callback_port=99999"),
    ).toBeNull();
  });

  it("decodes the credential envelope used by Infisical's paste fallback", () => {
    const token = Buffer.from(
      JSON.stringify({
        email: "founder@example.com",
        privateKey: "private-key",
        JTWToken: "signed.jwt.token",
        RefreshToken: "refresh-token",
      }),
      "utf8",
    ).toString("base64");

    expect(decodeInfisicalBrowserToken(token)).toEqual({
      email: "founder@example.com",
      privateKey: "private-key",
      jwt: "signed.jwt.token",
      refreshToken: "refresh-token",
    });
  });

  it("rejects malformed or incomplete browser tokens", () => {
    expect(() => decodeInfisicalBrowserToken("not-base64-json")).toThrow(
      "That does not look like a valid Infisical browser token.",
    );
    expect(() =>
      decodeInfisicalBrowserToken(
        Buffer.from(JSON.stringify({ email: "founder@example.com" })).toString("base64"),
      ),
    ).toThrow("That does not look like a valid Infisical browser token.");
  });
});
