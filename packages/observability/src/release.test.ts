import { describe, expect, it } from "vitest";
import { deployedRelease } from "./release";

describe("deployedRelease", () => {
  it("prefers the platform commit over a configured release", () => {
    expect(
      deployedRelease({
        KAMAL_VERSION: "kamal-sha",
        RENDER_GIT_COMMIT: "render-sha",
        OBSERVABILITY_RELEASE: "configured",
      }),
    ).toBe("kamal-sha");
    expect(
      deployedRelease({ RENDER_GIT_COMMIT: "render-sha", OBSERVABILITY_RELEASE: "configured" }),
    ).toBe("render-sha");
    expect(
      deployedRelease({ VERCEL_GIT_COMMIT_SHA: "vercel-sha", OBSERVABILITY_RELEASE: "configured" }),
    ).toBe("vercel-sha");
  });

  it("skips blank values, which Kamal ships for unset secrets", () => {
    expect(deployedRelease({ KAMAL_VERSION: " ", OBSERVABILITY_RELEASE: "configured" })).toBe(
      "configured",
    );
    expect(deployedRelease({})).toBeUndefined();
  });
});
