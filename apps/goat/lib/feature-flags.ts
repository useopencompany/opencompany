export type GoatFeatureFlags = {
  taskSpawning: boolean;
  localCodexBridge: boolean;
  mainChatIntegrationTools: boolean;
};

export const DEFAULT_GOAT_FEATURE_FLAGS: GoatFeatureFlags = {
  taskSpawning: false,
  localCodexBridge: false,
  mainChatIntegrationTools: false,
};

export const LOCAL_CODEX_BETA_DISABLED_MESSAGE =
  "Local Codex beta is disabled. Enable it in Goat Settings to use Local Codex.";

// Global kill switch for the connected-tools-in-chat beta: flipping the env var
// disables the feature for everyone without a deploy rollback. The flag mapper
// runs server-side (app shell and API routes), so baking the switch in here
// gives one choke point for every consumer.
export function isGoatMainChatIntegrationToolsKillSwitchOn() {
  return process.env.GOAT_MAIN_CHAT_INTEGRATION_TOOLS_DISABLED?.trim().toLowerCase() === "true";
}

export function goatFeatureFlagsFromUser(input: {
  taskSpawningEnabled?: boolean | null | undefined;
  localCodexBetaEnabled?: boolean | null | undefined;
  mainChatIntegrationToolsBetaEnabled?: boolean | null | undefined;
}): GoatFeatureFlags {
  return {
    taskSpawning: input.taskSpawningEnabled === true,
    localCodexBridge: input.localCodexBetaEnabled === true,
    mainChatIntegrationTools:
      input.mainChatIntegrationToolsBetaEnabled === true &&
      !isGoatMainChatIntegrationToolsKillSwitchOn(),
  };
}
