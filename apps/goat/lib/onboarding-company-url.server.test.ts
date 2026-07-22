import { describe, expect, it, vi } from "vitest";
import { isPublicIpAddress, verifyGoatOnboardingCompanyUrl } from "./onboarding-company-url.server";

describe("verifyGoatOnboardingCompanyUrl", () => {
  const publicLookup = vi.fn(async () => [{ address: "93.184.216.34" }]);

  it("accepts a reachable public website", async () => {
    const fetchUrl = vi.fn(async () => new Response("ok", { status: 200 }));

    await expect(
      verifyGoatOnboardingCompanyUrl("https://example.com/", {
        lookup: publicLookup,
        fetch: fetchUrl,
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchUrl).toHaveBeenCalledOnce();
  });

  it("validates every redirect target before following it", async () => {
    const fetchUrl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/admin" },
        }),
    );

    await expect(
      verifyGoatOnboardingCompanyUrl("https://example.com/", {
        lookup: publicLookup,
        fetch: fetchUrl,
      }),
    ).resolves.toEqual({ ok: false, error: "Enter a public company URL." });
    expect(fetchUrl).toHaveBeenCalledOnce();
  });

  it("rejects unreachable and missing websites", async () => {
    await expect(
      verifyGoatOnboardingCompanyUrl("https://example.com/", {
        lookup: publicLookup,
        fetch: vi.fn(async () => new Response(null, { status: 404 })),
      }),
    ).resolves.toEqual({
      ok: false,
      error: "We couldn't find a working website at that URL.",
    });

    await expect(
      verifyGoatOnboardingCompanyUrl("https://example.com/", {
        lookup: publicLookup,
        fetch: vi.fn(async () => {
          throw new Error("DNS failure");
        }),
      }),
    ).resolves.toEqual({
      ok: false,
      error: "We couldn't reach that company URL. Check it and try again.",
    });
  });
});

describe("isPublicIpAddress", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "::ffff:127.0.0.1",
  ])("rejects private or reserved address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it("accepts a public address", () => {
    expect(isPublicIpAddress("93.184.216.34")).toBe(true);
  });
});
