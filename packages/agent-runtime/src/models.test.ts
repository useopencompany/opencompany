import { describe, expect, it } from "vitest";
import {
  AGENT_MODEL_CATALOG,
  CODEX_AGENT_MODEL_IDS,
  codexCliModelNameForModelId,
  isCodexModelId,
} from "./models";

describe("Codex model catalog", () => {
  it.each([
    ["openai/gpt-5.6-sol", "gpt-5.6-sol"],
    ["openai/gpt-5.6-terra", "gpt-5.6-terra"],
    ["openai/gpt-5.6-luna", "gpt-5.6-luna"],
  ])("maps %s to its Codex CLI model name", (modelId, cliModel) => {
    expect(isCodexModelId(modelId)).toBe(true);
    expect(codexCliModelNameForModelId(modelId)).toBe(cliModel);
  });

  it("has display metadata for every supported Codex model", () => {
    const catalogIds = new Set(AGENT_MODEL_CATALOG.map((model) => model.id));
    expect(CODEX_AGENT_MODEL_IDS.every((modelId) => catalogIds.has(modelId))).toBe(true);
  });
});
