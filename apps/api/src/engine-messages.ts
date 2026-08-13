import {
  CLAUDE_CODE_DEFAULT_MODEL_ID,
  CODEX_DEFAULT_MODEL_ID,
  claudeCodeCliModelNameForModelId,
  codexCliModelNameForModelId,
  isClaudeCodeModelId,
  isCodexModelId,
} from "@opencompany/agent-runtime";
import type { Actor, ChatEngine } from "@opencompany/core";
import type { MessageEngine } from "@opencompany/protocol";
import type { EngineAuthService } from "./engine-auth";
import { ApiError } from "./errors";

const CODEX_DISCONNECTED_MESSAGE =
  "Connect Codex in Goat settings before chatting with the Codex engine.";
const CLAUDE_CODE_DISCONNECTED_MESSAGE =
  "Connect Claude Code in Goat settings before chatting with the Claude engine.";

export type EngineMessageAdmission = {
  engine: ChatEngine;
  model: string;
  runtimeModel: string;
  settings?: Readonly<Record<string, unknown>>;
};

export async function admitEngineMessage(input: {
  actor: Actor;
  engine: MessageEngine;
  model?: string;
  defaultOpenCompanyModel: string;
  auth: Pick<EngineAuthService, "getClaudeCodeStatus" | "getCodexStatus">;
}): Promise<EngineMessageAdmission> {
  if (input.engine.type === "opencompany") {
    const model = input.model ?? input.defaultOpenCompanyModel;
    return { engine: "opencompany", model, runtimeModel: model };
  }

  if (input.engine.type === "codex") {
    const status = await input.auth.getCodexStatus(input.actor);
    if (status.status !== "connected") {
      throw new ApiError(409, "conflict", CODEX_DISCONNECTED_MESSAGE);
    }
    const model = input.model ?? CODEX_DEFAULT_MODEL_ID;
    if (!isCodexModelId(model)) {
      throw new ApiError(400, "invalid_request", "Select a supported Codex model.");
    }
    const runtimeModel = codexCliModelNameForModelId(model);
    if (!runtimeModel) {
      throw new ApiError(400, "invalid_request", "Select a supported Codex model.");
    }
    const settings = {
      reasoningEffort: input.engine.settings.reasoningEffort,
      ...(input.engine.settings.planModeEnabled ? { planModeReasoningEffort: "high" } : {}),
      ...(input.engine.settings.goalMode
        ? {
            goalMode: {
              objective: input.engine.settings.goalMode.objective.trim(),
              ...(input.engine.settings.goalMode.tokenBudget
                ? { tokenBudget: input.engine.settings.goalMode.tokenBudget }
                : {}),
            },
          }
        : {}),
    };
    return { engine: "codex", model, runtimeModel, settings };
  }

  const status = await input.auth.getClaudeCodeStatus(input.actor);
  if (status.status !== "connected") {
    throw new ApiError(409, "conflict", CLAUDE_CODE_DISCONNECTED_MESSAGE);
  }
  const model = input.model ?? CLAUDE_CODE_DEFAULT_MODEL_ID;
  if (!isClaudeCodeModelId(model)) {
    throw new ApiError(400, "invalid_request", "Select a supported Claude model.");
  }
  const runtimeModel = claudeCodeCliModelNameForModelId(model);
  if (!runtimeModel) {
    throw new ApiError(400, "invalid_request", "Select a supported Claude model.");
  }
  return {
    engine: "claude_code",
    model,
    runtimeModel,
    settings: { reasoningEffort: input.engine.settings.reasoningEffort },
  };
}
