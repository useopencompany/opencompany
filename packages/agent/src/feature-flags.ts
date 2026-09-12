export type FeatureFlags = {
  bots?: boolean;
  taskSpawning: boolean;
  autoModelRouting: boolean;
  legacyBrain: boolean;
  reviewInbox: boolean;
  sidebarProjects: boolean;
};

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  bots: false,
  taskSpawning: false,
  autoModelRouting: false,
  legacyBrain: false,
  reviewInbox: false,
  sidebarProjects: false,
};

export const TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE =
  "Tasks & Workflows is disabled. Enable it in Preferences first.";

export function featureFlagsFromUser(input: {
  botsEnabled?: boolean | null | undefined;
  taskSpawningEnabled?: boolean | null | undefined;
  autoModelRoutingEnabled?: boolean | null | undefined;
  legacyBrainEnabled?: boolean | null | undefined;
  reviewInboxEnabled?: boolean | null | undefined;
  sidebarProjectsEnabled?: boolean | null | undefined;
}): FeatureFlags {
  return {
    bots: input.botsEnabled === true,
    taskSpawning: input.taskSpawningEnabled === true,
    autoModelRouting: input.autoModelRoutingEnabled === true,
    legacyBrain: input.legacyBrainEnabled === true,
    reviewInbox: input.reviewInboxEnabled === true,
    sidebarProjects: input.sidebarProjectsEnabled === true,
  };
}
