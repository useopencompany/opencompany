import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { normalizeModel } from "@/lib/model-options";

export const TASK_PROMPT_MAX_LENGTH = 10_000;

export type TaskInput = {
  prompt: string;
  model: AgentModelId;
};

export function validateTaskInput(input: {
  prompt: unknown;
  model: unknown;
}): { ok: true; value: TaskInput } | { ok: false; error: string } {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) {
    return { ok: false, error: "Enter a task before starting a run." };
  }
  if (prompt.length > TASK_PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      error: `Tasks can be at most ${TASK_PROMPT_MAX_LENGTH.toLocaleString()} characters.`,
    };
  }

  return {
    ok: true,
    value: {
      prompt,
      model: normalizeModel(input.model),
    },
  };
}
