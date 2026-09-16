export type FeatureFlags = {
  bots?: boolean;
  autoModelRouting: boolean;
  reviewInbox: boolean;
  sidebarProjects: boolean;
  subagents: boolean;
  pastSessionAccess?: boolean;
  imessage: boolean;
};

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  bots: false,
  autoModelRouting: false,
  reviewInbox: false,
  sidebarProjects: false,
  subagents: false,
  pastSessionAccess: false,
  imessage: false,
};

export function featureFlagsFromUser(input: {
  botsEnabled?: boolean | null | undefined;
  autoModelRoutingEnabled?: boolean | null | undefined;
  reviewInboxEnabled?: boolean | null | undefined;
  sidebarProjectsEnabled?: boolean | null | undefined;
  pastSessionAccessEnabled?: boolean | null | undefined;
  subagentsEnabled?: boolean | null | undefined;
  imessageEnabled?: boolean | null | undefined;
}): FeatureFlags {
  return {
    bots: input.botsEnabled === true,
    autoModelRouting: input.autoModelRoutingEnabled === true,
    reviewInbox: input.reviewInboxEnabled === true,
    sidebarProjects: input.sidebarProjectsEnabled === true,
    subagents: input.subagentsEnabled === true,
    pastSessionAccess: input.pastSessionAccessEnabled === true,
    imessage: input.imessageEnabled === true,
  };
}
