export type GoatFeatureFlags = {
  taskSpawning: boolean;
};

export const DEFAULT_GOAT_FEATURE_FLAGS: GoatFeatureFlags = {
  taskSpawning: false,
};

export const TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE =
  "Tasks & Workflows is disabled. Enable it in Preferences first.";

export function goatFeatureFlagsFromUser(input: {
  taskSpawningEnabled?: boolean | null | undefined;
}): GoatFeatureFlags {
  return {
    taskSpawning: input.taskSpawningEnabled === true,
  };
}
