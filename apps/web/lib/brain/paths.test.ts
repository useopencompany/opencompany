import { describe, expect, it } from "vitest";
import { normalizeBrainPath, workspaceBrainPath } from "./paths";

describe("brain paths", () => {
  it("normalizes paths inside the brain root", () => {
    expect(normalizeBrainPath("/docs//README.md")).toBe("docs/README.md");
    expect(normalizeBrainPath("brain/product/", { allowFolder: true })).toBe("product/");
    expect(workspaceBrainPath("docs/README.md")).toBe("brain/docs/README.md");
  });

  it("rejects unsafe paths", () => {
    expect(() => normalizeBrainPath("../secrets.md")).toThrow();
    expect(() => normalizeBrainPath(".env")).toThrow();
    expect(() => normalizeBrainPath("notes/../../secrets.md")).toThrow();
  });
});
