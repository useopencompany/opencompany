export type GoatFeatureFlags = {
  taskSpawning: boolean;
  localCodexBridge: boolean;
};

export const DEFAULT_GOAT_FEATURE_FLAGS: GoatFeatureFlags = {
  taskSpawning: false,
  localCodexBridge: false,
};

export const LOCAL_CODEX_BETA_DISABLED_MESSAGE =
  "Local Codex beta is disabled. Enable it in Goat Settings to use Local Codex.";

export const TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE =
  "Tasks & Workflows is disabled. Enable it in Preferences first.";

export function goatFeatureFlagsFromUser(input: {
  taskSpawningEnabled?: boolean | null | undefined;
  localCodexBetaEnabled?: boolean | null | undefined;
}): GoatFeatureFlags {
  return {
    taskSpawning: input.taskSpawningEnabled === true,
    localCodexBridge: input.localCodexBetaEnabled === true,
  };
}
