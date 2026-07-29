export type GoatFeatureFlags = {
  taskSpawning: boolean;
};

export const DEFAULT_GOAT_FEATURE_FLAGS: GoatFeatureFlags = {
  taskSpawning: false,
};

export function goatFeatureFlagsFromUser(input: {
  taskSpawningEnabled?: boolean | null | undefined;
}): GoatFeatureFlags {
  return {
    taskSpawning: input.taskSpawningEnabled === true,
  };
}
