export type FeatureFlags = {
  bots?: boolean;
  approveForMe?: boolean;
  autoModelRouting: boolean;
  legacyBrain: boolean;
  reviewInbox: boolean;
  sidebarProjects: boolean;
  subagents: boolean;
  pastSessionAccess?: boolean;
  imessage: boolean;
  whatsapp: boolean;
};

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  bots: false,
  approveForMe: false,
  autoModelRouting: false,
  legacyBrain: false,
  reviewInbox: false,
  sidebarProjects: false,
  subagents: false,
  pastSessionAccess: false,
  imessage: false,
  whatsapp: false,
};

export function featureFlagsFromUser(input: {
  botsEnabled?: boolean | null | undefined;
  approveForMeEnabled?: boolean | null | undefined;
  autoModelRoutingEnabled?: boolean | null | undefined;
  legacyBrainEnabled?: boolean | null | undefined;
  reviewInboxEnabled?: boolean | null | undefined;
  sidebarProjectsEnabled?: boolean | null | undefined;
  pastSessionAccessEnabled?: boolean | null | undefined;
  subagentsEnabled?: boolean | null | undefined;
  imessageEnabled?: boolean | null | undefined;
  whatsappEnabled?: boolean | null | undefined;
}): FeatureFlags {
  return {
    bots: input.botsEnabled === true,
    approveForMe: input.approveForMeEnabled === true,
    autoModelRouting: input.autoModelRoutingEnabled === true,
    legacyBrain: input.legacyBrainEnabled === true,
    reviewInbox: input.reviewInboxEnabled === true,
    sidebarProjects: input.sidebarProjectsEnabled === true,
    subagents: input.subagentsEnabled === true,
    pastSessionAccess: input.pastSessionAccessEnabled === true,
    imessage: input.imessageEnabled === true,
    whatsapp: input.whatsappEnabled === true,
  };
}
