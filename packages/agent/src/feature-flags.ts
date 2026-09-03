export type FeatureFlags = {
  taskSpawning: boolean;
  autoModelRouting: boolean;
  imessage: boolean;
  legacyBrain: boolean;
};

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  taskSpawning: false,
  autoModelRouting: false,
  imessage: false,
  legacyBrain: false,
};

export const TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE =
  "Tasks & Workflows is disabled. Enable it in Preferences first.";

export function featureFlagsFromUser(input: {
  taskSpawningEnabled?: boolean | null | undefined;
  autoModelRoutingEnabled?: boolean | null | undefined;
  imessageEnabled?: boolean | null | undefined;
  legacyBrainEnabled?: boolean | null | undefined;
}): FeatureFlags {
  return {
    taskSpawning: input.taskSpawningEnabled === true,
    autoModelRouting: input.autoModelRoutingEnabled === true,
    imessage: input.imessageEnabled === true,
    legacyBrain: input.legacyBrainEnabled === true,
  };
}
