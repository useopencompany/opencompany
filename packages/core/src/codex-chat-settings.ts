import { isCodexReasoningEffort } from "@opencompany/agent-runtime";
import type { CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import type { GoatCodexChatTurnSettings } from "@opencompany/db/schema";

export const DEFAULT_CODEX_CHAT_REASONING_EFFORT: CodexReasoningEffort = "xhigh";
export const DEFAULT_CODEX_PLAN_MODE_REASONING_EFFORT: CodexReasoningEffort = "high";
export const CODEX_GOAL_OBJECTIVE_MAX_LENGTH = 4_000;
export const CODEX_GOAL_TOKEN_BUDGET_MAX = 2_000_000;

export type CodexChatSettingsInput = {
  reasoningEffort?: unknown;
  planModeEnabled?: unknown;
  goalMode?: unknown;
};

export type CodexChatSettingsResult =
  | { ok: true; settings: GoatCodexChatTurnSettings }
  | { ok: false; error: string };
type CodexGoalMode = NonNullable<GoatCodexChatTurnSettings["goalMode"]>;
type NormalizedCodexChatSettings = {
  reasoningEffort: CodexReasoningEffort;
  planModeReasoningEffort: CodexReasoningEffort | null;
  goalMode: CodexGoalMode | null;
};

export type GoatCodexComposerSettingsView = {
  reasoningEffort: CodexReasoningEffort;
  planModeEnabled: boolean;
  goalMode: CodexGoalMode | null;
};

export function parseCodexChatSettings(
  value: unknown,
  defaultReasoningEffort = DEFAULT_CODEX_CHAT_REASONING_EFFORT,
): CodexChatSettingsResult {
  if (value == null) {
    return { ok: true, settings: { reasoningEffort: defaultReasoningEffort } };
  }
  if (!isRecord(value)) return { ok: false, error: "Invalid Codex settings." };

  const reasoningEffort = readReasoningEffort(value.reasoningEffort);
  if (!reasoningEffort) return { ok: false, error: "Invalid Codex reasoning effort." };

  const settings: GoatCodexChatTurnSettings = { reasoningEffort };
  if (value.planModeEnabled === true) {
    settings.planModeReasoningEffort = DEFAULT_CODEX_PLAN_MODE_REASONING_EFFORT;
  }

  if (value.goalMode != null) {
    const goalMode = parseGoalMode(value.goalMode);
    if (!goalMode.ok) return goalMode;
    settings.goalMode = goalMode.goalMode;
  }

  return { ok: true, settings };
}

export function normalizeCodexChatSettings(
  value: GoatCodexChatTurnSettings | null | undefined,
  defaultReasoningEffort = DEFAULT_CODEX_CHAT_REASONING_EFFORT,
): NormalizedCodexChatSettings {
  return {
    reasoningEffort: readReasoningEffort(value?.reasoningEffort) ?? defaultReasoningEffort,
    planModeReasoningEffort: readReasoningEffort(value?.planModeReasoningEffort) ?? null,
    goalMode: normalizeGoalMode(value?.goalMode),
  };
}

export function codexComposerSettingsFromTurnSettings(
  value: GoatCodexChatTurnSettings | null | undefined,
  defaultReasoningEffort = DEFAULT_CODEX_CHAT_REASONING_EFFORT,
): GoatCodexComposerSettingsView {
  const settings = normalizeCodexChatSettings(value, defaultReasoningEffort);
  return {
    reasoningEffort: settings.reasoningEffort,
    planModeEnabled: settings.planModeReasoningEffort !== null,
    goalMode: settings.goalMode,
  };
}

function readReasoningEffort(value: unknown): CodexReasoningEffort | null {
  return typeof value === "string" && isCodexReasoningEffort(value) ? value : null;
}

function parseGoalMode(
  value: unknown,
): { ok: true; goalMode: CodexGoalMode } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "Invalid Codex goal mode." };
  const objective = typeof value.objective === "string" ? value.objective.trim() : "";
  if (!objective) return { ok: false, error: "Goal mode needs an objective." };
  if (objective.length > CODEX_GOAL_OBJECTIVE_MAX_LENGTH) {
    return { ok: false, error: "Goal mode objectives can be at most 4,000 characters." };
  }

  const tokenBudget = parseTokenBudget(value.tokenBudget);
  if (tokenBudget === false) return { ok: false, error: "Invalid Codex goal token budget." };
  return {
    ok: true,
    goalMode: {
      objective,
      ...(tokenBudget == null ? {} : { tokenBudget }),
    },
  };
}

function normalizeGoalMode(value: unknown): CodexGoalMode | null {
  const parsed = parseGoalMode(value);
  return parsed.ok ? parsed.goalMode : null;
}

function parseTokenBudget(value: unknown): number | null | false {
  if (value == null || value === "") return null;
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(numeric) || numeric <= 0 || numeric > CODEX_GOAL_TOKEN_BUDGET_MAX) {
    return false;
  }
  return numeric;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
