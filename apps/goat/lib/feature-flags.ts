export type GoatFeatureFlags = {
  taskSpawning: boolean;
  localCodexBridge: boolean;
  chatCapabilities: boolean;
};

export const DEFAULT_GOAT_FEATURE_FLAGS: GoatFeatureFlags = {
  taskSpawning: false,
  localCodexBridge: false,
  chatCapabilities: false,
};

export const LOCAL_CODEX_BETA_DISABLED_MESSAGE =
  "Local Codex beta is disabled. Enable it in Goat Settings to use Local Codex.";

export function goatFeatureFlagsFromUser(input: {
  taskSpawningEnabled?: boolean | null | undefined;
  localCodexBetaEnabled?: boolean | null | undefined;
  chatCapabilitiesBetaEnabled?: boolean | null | undefined;
}): GoatFeatureFlags {
  return {
    taskSpawning: input.taskSpawningEnabled === true,
    localCodexBridge: input.localCodexBetaEnabled === true,
    chatCapabilities: input.chatCapabilitiesBetaEnabled === true,
  };
}
