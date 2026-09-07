import { describe, expect, it } from "vitest";
import nextConfig from "./next.config.mjs";

describe("settings redirects", () => {
  it.each([
    ["/settings/integrations", "/settings/plugins"],
    ["/settings/granola", "/wiki/sources"],
    ["/settings/jamie", "/settings/plugins/jamie"],
    ["/settings/stripe", "/settings/plugins/stripe"],
  ])("redirects %s to %s", async (source, destination) => {
    const redirects = await nextConfig.redirects();

    expect(redirects).toContainEqual({ source, destination, permanent: false });
  });
});
