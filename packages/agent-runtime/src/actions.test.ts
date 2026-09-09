import { describe, expect, it } from "vitest";
import {
  ACTION_HOST_TOOL_CONTRACT_VERSION,
  ACTION_HOST_TOOL_CONTRACT_VERSION_V2,
  CHAT_HOST_TOOL_CONTRACT_VERSION,
  isWikiHostToolContractVersion,
} from "./actions";

describe("Wiki host-tool contracts", () => {
  it.each([
    ACTION_HOST_TOOL_CONTRACT_VERSION_V2,
    ACTION_HOST_TOOL_CONTRACT_VERSION,
    "goat-codex-brain.v1",
  ])("supports %s", (version) => {
    expect(isWikiHostToolContractVersion(version)).toBe(true);
  });

  it.each([CHAT_HOST_TOOL_CONTRACT_VERSION, "unknown", null, undefined])(
    "rejects unsupported contract %s",
    (version) => {
      expect(isWikiHostToolContractVersion(version)).toBe(false);
    },
  );
});

describe("progressive action discovery contracts", () => {
  it("validates one to five exact ID strings without coercing them", async () => {
    const { isDescribeActionsInput } = await import("./actions");
    expect(isDescribeActionsInput({ actions: ["plugin:linear:linear.get_issue"] })).toBe(true);
    expect(isDescribeActionsInput({ actions: Array(5).fill("same") })).toBe(true);
    for (const value of [
      null,
      [],
      {},
      { actions: [] },
      { actions: Array(6).fill("same") },
      { actions: [1] },
      { actions: [" "] },
      { actions: ["id"], query: "extra" },
    ]) {
      expect(isDescribeActionsInput(value)).toBe(false);
    }
  });

  it("serves compact discovery only for v5 while retaining older contract admission", async () => {
    const {
      ACTION_HOST_TOOL_CONTRACT_VERSIONS,
      CHAT_HOST_TOOL_CONTRACT_VERSIONS,
      supportsCompactActionDiscovery,
    } = await import("./actions");
    for (const version of [
      ...ACTION_HOST_TOOL_CONTRACT_VERSIONS,
      ...CHAT_HOST_TOOL_CONTRACT_VERSIONS,
    ]) {
      expect(supportsCompactActionDiscovery(version)).toBe(version.endsWith(".v5"));
    }
    expect(ACTION_HOST_TOOL_CONTRACT_VERSIONS).toContain("goat-codex-host-tools.v4");
    expect(CHAT_HOST_TOOL_CONTRACT_VERSIONS).toContain("goat-chat-host-tools.v4");
    expect(supportsCompactActionDiscovery("unknown")).toBe(false);
  });
});
