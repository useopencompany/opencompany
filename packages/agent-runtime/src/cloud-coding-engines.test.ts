import { describe, expect, it } from "vitest";
import { CLOUD_CODING_ENGINE_CONFIG, isCloudCodingEngine } from "./cloud-coding-engines";

describe("cloud coding engine configuration", () => {
  it("defines the trusted working directory for every supported engine", () => {
    expect(CLOUD_CODING_ENGINE_CONFIG).toEqual({
      codex: {
        label: "Codex",
        workDirectory: "/home/user/opencompany-goat/codex-chat",
      },
      claude_code: {
        label: "Claude Code",
        workDirectory: "/home/user/opencompany-goat/claude-chat",
      },
    });
  });

  it("accepts configured engines without trusting inherited object keys", () => {
    expect(isCloudCodingEngine("codex")).toBe(true);
    expect(isCloudCodingEngine("claude_code")).toBe(true);
    expect(isCloudCodingEngine("toString")).toBe(false);
    expect(isCloudCodingEngine("opencompany")).toBe(false);
  });
});
