import { describe, expect, it } from "vitest";
import nextConfig from "./next.config.mjs";

describe("settings redirects", () => {
  it.each([
    ["/settings/integrations", "/plugins"],
    ["/settings/plugins", "/plugins"],
    ["/settings/plugins/:path*", "/plugins/:path*"],
    ["/settings/skills", "/skills"],
    ["/settings/skills/:path*", "/skills/:path*"],
    ["/settings/granola", "/wiki/sources"],
    ["/settings/jamie", "/plugins/jamie"],
    ["/settings/stripe", "/plugins/stripe"],
  ])("redirects %s to %s", async (source, destination) => {
    const redirects = await nextConfig.redirects();

    expect(redirects).toContainEqual({ source, destination, permanent: false });
  });
});
