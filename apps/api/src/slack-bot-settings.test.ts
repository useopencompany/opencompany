import {
  slackBotCanCustomizeIdentity,
  slackBotCanReact,
  slackBotCanReadDirectMessages,
  slackBotCanUploadFiles,
  slackBotScopesSatisfied,
} from "@opencompany/agent/integrations/slack-bot";
import { captureProductServerEvent } from "@opencompany/analytics/product/server";
import type { Actor } from "@opencompany/core";
import { loadIntegrationCredential, markIntegrationStatus } from "@opencompany/db/integrations";
import { getSlackBotIntegrationForWorkspace } from "@opencompany/db/slack-bot";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackBotSettingsService } from "./slack-bot-settings";

vi.mock("@opencompany/analytics/product/server", () => ({
  captureProductServerEvent: vi.fn(async () => undefined),
}));
vi.mock("@opencompany/db/integrations", () => ({
  loadIntegrationCredential: vi.fn(),
  markIntegrationStatus: vi.fn(async () => undefined),
}));
vi.mock("@opencompany/db/slack-bot", () => ({
  getSlackBotIntegrationForWorkspace: vi.fn(),
}));
vi.mock("@opencompany/db/workspaces", () => ({}));
vi.mock("@opencompany/agent/integrations/slack-bot", () => ({
  slackBotScopesSatisfied: vi.fn(() => true),
  slackBotCanCustomizeIdentity: vi.fn(() => true),
  slackBotCanReact: vi.fn(() => true),
  slackBotCanReadDirectMessages: vi.fn(() => true),
  slackBotCanUploadFiles: vi.fn(() => true),
  isSlackBotConfigured: vi.fn(() => true),
}));

const admin: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: [],
  authenticationMethod: "session",
};
const member: Actor = { ...admin, role: "member" };
const integration = {
  id: "gint_slack_bot",
  userWorkosId: "user_owner",
  workspaceId: "workspace_1",
  status: "connected" as const,
  scopes: ["channels:read"],
  externalId: "team_1",
  connectionLabel: "Acme",
  statusReason: null,
  updatedAt: new Date("2026-08-13T12:00:00.000Z"),
};
function unusedDb() {
  const db = { execute: vi.fn(async () => []), select: vi.fn(() => ({ from: vi.fn() })) };
  return { ...db, transaction: async (body: (tx: typeof db) => Promise<void>) => body(db) };
}

describe("Slack bot settings service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(slackBotScopesSatisfied).mockReturnValue(true);
    vi.mocked(slackBotCanCustomizeIdentity).mockReturnValue(true);
    vi.mocked(slackBotCanReact).mockReturnValue(true);
    vi.mocked(slackBotCanUploadFiles).mockReturnValue(true);
    vi.mocked(getSlackBotIntegrationForWorkspace).mockResolvedValue(integration as never);
    vi.mocked(loadIntegrationCredential).mockResolvedValue({
      payload: { access_token: "token_test" },
      expiresAt: null,
      lastRotatedAt: new Date(),
      updatedAt: new Date(),
      encryptionKeyVersion: 1,
    });
  });

  it("exposes Slack capabilities without workspace integration metadata to non-admins", async () => {
    const service = createSlackBotSettingsService({ db: unusedDb() });
    await expect(service.getWorkspaceSettings(member)).resolves.toEqual({
      isAdmin: false,
      configured: true,
      installed: true,
      status: "connected",
      needsScopeUpgrade: false,
      canCustomizeIdentity: true,
      canReact: true,
      canReadDirectMessages: true,
      canPostImages: true,
      teamName: null,
      statusReason: null,
    });
    expect(getSlackBotIntegrationForWorkspace).toHaveBeenCalledWith(
      "workspace_1",
      expect.anything(),
    );
  });

  it("reports each granted capability independently from unrelated missing scopes", async () => {
    vi.mocked(slackBotScopesSatisfied).mockReturnValue(false);
    const service = createSlackBotSettingsService({ db: unusedDb() });

    await expect(service.getWorkspaceSettings(member)).resolves.toMatchObject({
      needsScopeUpgrade: true,
      canCustomizeIdentity: true,
      canReact: true,
    });

    // An install can be behind on one capability and current on the others; Settings words the
    // reconnect from these flags, so they must not move together.
    vi.mocked(slackBotCanReact).mockReturnValue(false);
    await expect(service.getWorkspaceSettings(member)).resolves.toMatchObject({
      canCustomizeIdentity: true,
      canReact: false,
      canReadDirectMessages: true,
    });

    vi.mocked(slackBotCanReadDirectMessages).mockReturnValue(false);
    await expect(service.getWorkspaceSettings(member)).resolves.toMatchObject({
      canCustomizeIdentity: true,
      canReadDirectMessages: false,
    });

    vi.mocked(slackBotCanUploadFiles).mockReturnValue(false);
    await expect(service.getWorkspaceSettings(member)).resolves.toMatchObject({
      canCustomizeIdentity: true,
      canPostImages: false,
    });
  });

  it("disconnects the workspace bot without returning its credential", async () => {
    const service = createSlackBotSettingsService({ db: unusedDb() });
    await service.disconnect(admin);
    expect(markIntegrationStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: "gint_slack_bot",
        status: "disconnected",
      }),
    );
  });
});
