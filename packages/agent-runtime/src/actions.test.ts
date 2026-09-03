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
