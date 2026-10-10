import type { CompanySentryPluginDto } from "@opencompany/protocol";
export function sentryPluginFixture(): CompanySentryPluginDto {
  return {
    configured: true,
    canManage: true,
    installUrl: null,
    connection: {
      integrationId: "sentry_1",
      workspaceId: "workspace_1",
      installationId: "a8e5d37a-696c-4c54-adb5-b3f28d64c7de",
      organizationId: "123",
      organizationSlug: "acme",
      region: "eu",
      selectedProjectIds: ["1"],
      cooldownMinutes: 30,
      dailyCap: 25,
      verifiedAt: "2026-10-01T00:00:00Z",
      lastReceivedAt: null,
      status: "connected",
      capabilityModes: {},
      toolModes: {},
    },
    events: [],
    usage: 0,
    tools: [],
    outcomes: [],
  };
}
