import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { normalizeGoatModel } from "@/lib/model-options";

export const GOAT_TASK_PROMPT_MAX_LENGTH = 10_000;

export type GoatTaskInput = {
  prompt: string;
  model: AgentModelId;
};

export function validateGoatTaskInput(input: {
  prompt: unknown;
  model: unknown;
}): { ok: true; value: GoatTaskInput } | { ok: false; error: string } {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) {
    return { ok: false, error: "Enter a task before starting a run." };
  }
  if (prompt.length > GOAT_TASK_PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      error: `Tasks can be at most ${GOAT_TASK_PROMPT_MAX_LENGTH.toLocaleString()} characters.`,
    };
  }

  return {
    ok: true,
    value: {
      prompt,
      model: normalizeGoatModel(input.model),
    },
  };
}
