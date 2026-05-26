import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGitHubWorkInstallationToken } from "./github";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GitHub installation tokens", () => {
  it("explains work repository installation 404s as an app credential mismatch", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    vi.stubEnv("GITHUB_INTEGRATION_APP_ID", "12345");
    vi.stubEnv(
      "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
      privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }),
    );

    await expect(getGitHubWorkInstallationToken("135242330")).rejects.toThrow(
      "GitHub work repository integration installation 135242330 is not accessible to the configured GitHub App.",
    );
  });
});
