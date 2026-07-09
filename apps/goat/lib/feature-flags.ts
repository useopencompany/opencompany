export type GoatFeatureFlags = {
  localCodexBridge: boolean;
};

export const DEFAULT_GOAT_FEATURE_FLAGS: GoatFeatureFlags = {
  localCodexBridge: false,
};

export const LOCAL_CODEX_BETA_DISABLED_MESSAGE =
  "Local Codex beta is disabled. Enable it in Goat Settings to use Local Codex.";

export function goatFeatureFlagsFromUser(input: {
  localCodexBetaEnabled?: boolean | null | undefined;
}): GoatFeatureFlags {
  return {
    localCodexBridge: input.localCodexBetaEnabled === true,
  };
}
