import {
  CLAUDE_CODE_AGENT_MODEL_IDS,
  CLAUDE_CODE_DEFAULT_MODEL_ID,
  CLAUDE_CODE_DEFAULT_REASONING_EFFORT,
  CODEX_AGENT_MODEL_IDS,
  CODEX_DEFAULT_MODEL_ID,
  CODEX_DEFAULT_REASONING_EFFORT,
  CODEX_REASONING_EFFORTS,
  claudeCodeModelSupportsReasoningEffort,
  claudeCodeReasoningEffortsForModel,
  getAgentModelDefinition,
  isAgentModelSelectable,
  isClaudeCodeModelId,
  isClaudeCodeReasoningEffort,
  isCodexModelId,
  isCodexReasoningEffort,
  normalizeChatCatalogModelId,
  OPENCOMPANY_CHAT_MODEL_IDS,
} from "@opencompany/agent-runtime/models";
import type {
  ClaudeCodeReasoningEffort,
  CloudCodingReasoningEffort,
  CodexReasoningEffort,
} from "@opencompany/agent-runtime/types";
import {
  type ConversationDto,
  type MessageEngine,
  MessageEngineSchema,
} from "@opencompany/protocol/schemas";
import { z } from "zod";

export type ComposerEngine = ConversationDto["engine"];
export type CodingEngine = Exclude<ComposerEngine, "opencompany">;

/** Lets the server pick a Chat model from the first message. Only valid for opencompany Chat. */
export const AUTO_MODEL_ID = "auto";

// Mirrors the protocol's CodexGoalModeSchema limits so the sheet can explain them inline.
export const GOAL_OBJECTIVE_MAX_LENGTH = 4_000;
export const GOAL_TOKEN_BUDGET_MAX = 2_000_000;

/**
 * Where the next message goes and how. Each engine keeps its own model and settings, so switching
 * from Codex to Chat and back restores the Codex choices. Goal fields hold unfinished input: they
 * survive turning Goal off, and only a valid, enabled Goal reaches a request.
 */
export interface ComposerSelection {
  engine: ComposerEngine;
  chatModelId: string;
  codexModelId: string;
  claudeModelId: string;
  codex: {
    reasoningEffort: CodexReasoningEffort;
    planModeEnabled: boolean;
    goalModeEnabled: boolean;
    goalObjective: string;
    goalTokenBudget: string;
  };
  claude: {
    reasoningEffort: ClaudeCodeReasoningEffort;
  };
}

export const defaultComposerSelection = (
  chatModelId: string = normalizeChatCatalogModelId(null),
): ComposerSelection => ({
  engine: "opencompany",
  chatModelId,
  codexModelId: CODEX_DEFAULT_MODEL_ID,
  claudeModelId: CLAUDE_CODE_DEFAULT_MODEL_ID,
  codex: {
    reasoningEffort: CODEX_DEFAULT_REASONING_EFFORT,
    planModeEnabled: false,
    goalModeEnabled: false,
    goalObjective: "",
    goalTokenBudget: "",
  },
  claude: { reasoningEffort: CLAUDE_CODE_DEFAULT_REASONING_EFFORT },
});

const DEFAULT_SELECTION = defaultComposerSelection();

// Stored selections come from older app versions too, so each field falls back on its own instead
// of discarding the whole selection.
const StoredSelectionSchema = z.object({
  engine: z.enum(["opencompany", "codex", "claude_code"]).catch(DEFAULT_SELECTION.engine),
  chatModelId: z.string().catch(DEFAULT_SELECTION.chatModelId),
  codexModelId: z.string().catch(DEFAULT_SELECTION.codexModelId),
  claudeModelId: z.string().catch(DEFAULT_SELECTION.claudeModelId),
  codex: z
    .object({
      reasoningEffort: z
        .string()
        .refine(isCodexReasoningEffort)
        .catch(DEFAULT_SELECTION.codex.reasoningEffort),
      planModeEnabled: z.boolean().catch(false),
      goalModeEnabled: z.boolean().catch(false),
      goalObjective: z.string().catch(""),
      goalTokenBudget: z.string().catch(""),
    })
    .catch(DEFAULT_SELECTION.codex),
  claude: z
    .object({
      reasoningEffort: z
        .string()
        .refine(isClaudeCodeReasoningEffort)
        .catch(DEFAULT_SELECTION.claude.reasoningEffort),
    })
    .catch(DEFAULT_SELECTION.claude),
});

/**
 * Reads a draft's selection. Drafts saved before engines existed only have a Chat model, so they
 * keep their original Chat behavior. Current drafts that never chose store an empty model_id.
 */
export const parseStoredSelection = (
  selectionJson: string | null,
  legacyChatModelId: string | null,
): ComposerSelection | null => {
  if (selectionJson === null) {
    return legacyChatModelId
      ? defaultComposerSelection(normalizeChatSelection(legacyChatModelId))
      : null;
  }
  let value: unknown;
  try {
    value = JSON.parse(selectionJson);
  } catch {
    return null;
  }
  const parsed = StoredSelectionSchema.safeParse(value);
  return parsed.success ? (parsed.data as ComposerSelection) : null;
};

const normalizeChatSelection = (value: string): string =>
  value === AUTO_MODEL_ID ? AUTO_MODEL_ID : normalizeChatCatalogModelId(value);

/** The conversation facts the composer needs to hydrate and lock a selection. */
export interface ConversationSelectionSource {
  engine: ComposerEngine;
  model: string;
  composerSettings: ConversationDto["composerSettings"];
  /** Accepted by the server, so its engine and model can no longer change. */
  locked: boolean;
}

const applyComposerSettings = (
  selection: ComposerSelection,
  engine: ComposerEngine,
  settings: ConversationDto["composerSettings"],
): ComposerSelection => {
  if (!settings) return selection;
  if (engine === "codex") {
    const goal = settings.goalMode ?? null;
    return {
      ...selection,
      codex: {
        reasoningEffort: isCodexReasoningEffort(settings.reasoningEffort)
          ? settings.reasoningEffort
          : selection.codex.reasoningEffort,
        planModeEnabled: settings.planModeEnabled ?? false,
        goalModeEnabled: goal !== null,
        goalObjective: goal?.objective ?? "",
        goalTokenBudget: goal?.tokenBudget == null ? "" : String(goal.tokenBudget),
      },
    };
  }
  if (engine === "claude_code")
    return { ...selection, claude: { reasoningEffort: settings.reasoningEffort } };
  return selection;
};

const withEngineModel = (
  selection: ComposerSelection,
  engine: ComposerEngine,
  model: string,
): ComposerSelection => {
  if (engine === "codex") return { ...selection, engine, codexModelId: model };
  if (engine === "claude_code") return { ...selection, engine, claudeModelId: model };
  return { ...selection, engine, chatModelId: model };
};

/**
 * Resolves the selection the composer shows and sends. A saved draft wins for everything the user
 * may still change. A conversation the server accepted always pins its engine and model, even a
 * retired model, while its last composer settings seed a draft that has none yet.
 */
export const resolveComposerSelection = (
  stored: ComposerSelection | null,
  conversation: ConversationSelectionSource | null,
): ComposerSelection => {
  if (!conversation) return stored ?? DEFAULT_SELECTION;
  const hydrated =
    stored ??
    applyComposerSettings(
      withEngineModel(DEFAULT_SELECTION, conversation.engine, conversation.model),
      conversation.engine,
      conversation.composerSettings,
    );
  return conversation.locked
    ? withEngineModel(hydrated, conversation.engine, conversation.model)
    : hydrated;
};

/** Rebuilds a selection from a queued request, so a rejected send restores what was chosen. */
export const selectionFromQueuedIntent = (engine: MessageEngine, model: string): string =>
  JSON.stringify(
    engine.type === "codex"
      ? {
          ...withEngineModel(DEFAULT_SELECTION, "codex", model),
          codex: {
            reasoningEffort: engine.settings.reasoningEffort,
            planModeEnabled: engine.settings.planModeEnabled ?? false,
            goalModeEnabled: Boolean(engine.settings.goalMode),
            goalObjective: engine.settings.goalMode?.objective ?? "",
            goalTokenBudget:
              engine.settings.goalMode?.tokenBudget == null
                ? ""
                : String(engine.settings.goalMode.tokenBudget),
          },
        }
      : engine.type === "claude_code"
        ? {
            ...withEngineModel(DEFAULT_SELECTION, "claude_code", model),
            claude: { reasoningEffort: engine.settings.reasoningEffort },
          }
        : withEngineModel(DEFAULT_SELECTION, "opencompany", model),
  );

export const selectedModelId = (selection: ComposerSelection): string => {
  if (selection.engine === "codex") return selection.codexModelId;
  if (selection.engine === "claude_code") return selection.claudeModelId;
  return selection.chatModelId;
};

export const modelLabel = (modelId: string): string =>
  modelId === AUTO_MODEL_ID ? "Auto" : (getAgentModelDefinition(modelId)?.label ?? modelId);

export const modelDescription = (modelId: string): string =>
  modelId === AUTO_MODEL_ID
    ? "Picks once from your first message"
    : (getAgentModelDefinition(modelId)?.description ?? "");

export const EFFORT_LABELS: Record<CloudCodingReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  ultracode: "Ultracode",
};

export const ENGINE_LABELS: Record<ComposerEngine, string> = {
  opencompany: "Chat",
  codex: "Codex",
  claude_code: "Claude Code",
};

/** Levels the selected model accepts. Chat and models without effort control offer none. */
export const effortOptions = (
  selection: ComposerSelection,
): readonly CloudCodingReasoningEffort[] => {
  if (selection.engine === "codex") return CODEX_REASONING_EFFORTS;
  if (
    selection.engine === "claude_code" &&
    claudeCodeModelSupportsReasoningEffort(selection.claudeModelId)
  )
    return claudeCodeReasoningEffortsForModel(selection.claudeModelId);
  return [];
};

/**
 * The level a request carries. A Claude preference the current model cannot run, such as
 * Ultracode after switching to an ineligible model, falls back to the nearest supported level.
 */
export const effectiveEffort = (
  selection: ComposerSelection,
): CloudCodingReasoningEffort | null => {
  if (selection.engine === "codex") return selection.codex.reasoningEffort;
  if (selection.engine !== "claude_code") return null;
  const options = effortOptions(selection);
  if (options.length === 0) return null;
  const preferred = selection.claude.reasoningEffort;
  if (options.includes(preferred)) return preferred;
  return preferred === "ultracode" ? "xhigh" : CLAUDE_CODE_DEFAULT_REASONING_EFFORT;
};

export interface GoalValidation {
  objective: string | null;
  tokenBudget: string | null;
}

export const validateGoal = (codex: ComposerSelection["codex"]): GoalValidation => {
  const objective = codex.goalObjective.trim();
  const budget = codex.goalTokenBudget.trim();
  const budgetValue = Number(budget);
  return {
    objective: !objective
      ? "Describe the objective Codex should reach."
      : objective.length > GOAL_OBJECTIVE_MAX_LENGTH
        ? `Keep the objective under ${GOAL_OBJECTIVE_MAX_LENGTH.toLocaleString()} characters.`
        : null,
    tokenBudget:
      budget &&
      (!/^\d+$/u.test(budget) ||
        !Number.isSafeInteger(budgetValue) ||
        budgetValue < 1 ||
        budgetValue > GOAL_TOKEN_BUDGET_MAX)
        ? `Enter a whole number from 1 to ${GOAL_TOKEN_BUDGET_MAX.toLocaleString()}, or leave it blank.`
        : null,
  };
};

export const isGoalBlockingSend = (selection: ComposerSelection): boolean => {
  if (selection.engine !== "codex" || !selection.codex.goalModeEnabled) return false;
  const validation = validateGoal(selection.codex);
  return Boolean(validation.objective || validation.tokenBudget);
};

/**
 * The protocol engine payload for a selection. Settings belong to one engine only: Chat sends
 * none, Claude Code never receives Plan or Goal, and a disabled Goal is left out entirely.
 */
export const messageEngineForSelection = (
  selection: ComposerSelection,
): { ok: true; engine: MessageEngine } | { ok: false; error: string } => {
  if (selection.engine === "opencompany")
    return { ok: true, engine: { type: "opencompany", schemaVersion: 1 } };
  if (selection.engine === "claude_code") {
    return {
      ok: true,
      engine: MessageEngineSchema.parse({
        type: "claude_code",
        schemaVersion: 1,
        settings: {
          reasoningEffort: effectiveEffort(selection) ?? CLAUDE_CODE_DEFAULT_REASONING_EFFORT,
        },
      }),
    };
  }
  const { codex } = selection;
  if (codex.goalModeEnabled) {
    const validation = validateGoal(codex);
    const error = validation.objective ?? validation.tokenBudget;
    if (error) return { ok: false, error: `Goal mode: ${error}` };
  }
  const budget = codex.goalTokenBudget.trim();
  return {
    ok: true,
    engine: MessageEngineSchema.parse({
      type: "codex",
      schemaVersion: 1,
      settings: {
        reasoningEffort: codex.reasoningEffort,
        ...(codex.planModeEnabled ? { planModeEnabled: true } : {}),
        ...(codex.goalModeEnabled
          ? {
              goalMode: {
                objective: codex.goalObjective.trim(),
                ...(budget ? { tokenBudget: Number(budget) } : {}),
              },
            }
          : {}),
      },
    }),
  };
};

export const CHAT_PICKER_MODEL_IDS: readonly string[] =
  OPENCOMPANY_CHAT_MODEL_IDS.filter(isAgentModelSelectable);

export const ENGINE_PICKER_MODEL_IDS: Record<CodingEngine, readonly string[]> = {
  codex: CODEX_AGENT_MODEL_IDS.filter(isAgentModelSelectable),
  claude_code: CLAUDE_CODE_AGENT_MODEL_IDS.filter(isAgentModelSelectable),
};

/** Keeps a new selection inside the chosen engine's catalog. */
export const normalizeEngineModelId = (engine: ComposerEngine, value: string): string => {
  if (engine === "codex") return isCodexModelId(value) ? value : CODEX_DEFAULT_MODEL_ID;
  if (engine === "claude_code")
    return isClaudeCodeModelId(value) ? value : CLAUDE_CODE_DEFAULT_MODEL_ID;
  return normalizeChatSelection(value);
};
