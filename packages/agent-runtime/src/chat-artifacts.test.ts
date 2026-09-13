import { describe, expect, it } from "vitest";
import { HTML_ARTIFACT_CONTENT_SECURITY_POLICY, writeArtifactMediaType } from "./chat-artifacts";

describe("writeArtifactMediaType", () => {
  it("maps the supported authoring extensions case-insensitively", () => {
    expect(writeArtifactMediaType("plan.md")).toBe("text/markdown");
    expect(writeArtifactMediaType("dashboard.HTML")).toBe("text/html");
  });

  it("refuses filenames that do not carry a supported extension", () => {
    expect(writeArtifactMediaType("report.txt")).toBeNull();
    expect(writeArtifactMediaType("report")).toBeNull();
    expect(writeArtifactMediaType(".html")).toBeNull();
  });
});

describe("HTML_ARTIFACT_CONTENT_SECURITY_POLICY", () => {
  it("keeps agent-authored pages inert and origin-isolated", () => {
    const directives = HTML_ARTIFACT_CONTENT_SECURITY_POLICY.split("; ");

    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain("sandbox allow-scripts");
    expect(HTML_ARTIFACT_CONTENT_SECURITY_POLICY).not.toContain("allow-same-origin");
    expect(HTML_ARTIFACT_CONTENT_SECURITY_POLICY).not.toContain("allow-popups");
    expect(HTML_ARTIFACT_CONTENT_SECURITY_POLICY).not.toContain("allow-forms");
    expect(HTML_ARTIFACT_CONTENT_SECURITY_POLICY).not.toContain("allow-top-navigation");
    expect(directives.filter((directive) => directive.includes("https:"))).toEqual([]);
  });
});
