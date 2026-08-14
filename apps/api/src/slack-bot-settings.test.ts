import { captureGoatServerEvent } from "@opencompany/analytics/goat/server";
import type { Actor } from "@opencompany/core";
import { upsertGoatBrainSource } from "@opencompany/db/goat-brain-sources";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
} from "@opencompany/db/goat-integrations";
import { getGoatSlackBotIntegrationForWorkspace } from "@opencompany/db/goat-slack-bot";
import { getGoatBrainAccess } from "@opencompany/db/goat-workspaces";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackBotSettingsService } from "./slack-bot-settings";

vi.mock("@opencompany/analytics/goat/server", () => ({
  captureGoatServerEvent: vi.fn(async () => undefined),
}));
vi.mock("@opencompany/db/goat-brain-sources", () => ({
  upsertGoatBrainSource: vi.fn(async () => ({ id: "source_1", created: true })),
}));
vi.mock("@opencompany/db/goat-integrations", () => ({
  loadGoatIntegrationCredential: vi.fn(),
  markGoatIntegrationStatus: vi.fn(async () => undefined),
}));
vi.mock("@opencompany/db/goat-slack-bot", () => ({
  getGoatSlackBotIntegrationForWorkspace: vi.fn(),
}));
vi.mock("@opencompany/db/goat-workspaces", () => ({
  getGoatBrainAccess: vi.fn(),
}));
vi.mock("@opencompany/goat-agent/integrations/slack-bot", () => ({
  goatSlackBotScopesSatisfied: vi.fn(() => true),
  isGoatSlackBotConfigured: vi.fn(() => true),
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
const access = {
  brain: { id: "brain_1", workspaceId: "workspace_1", visibility: "workspace" },
  workspaceRole: "admin",
};

function unusedDb() {
  return { select: vi.fn(() => ({ from: vi.fn() })) };
}

describe("Slack bot settings service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGoatSlackBotIntegrationForWorkspace).mockResolvedValue(integration as never);
    vi.mocked(getGoatBrainAccess).mockResolvedValue(access as never);
    vi.mocked(loadGoatIntegrationCredential).mockResolvedValue({
      payload: { access_token: "token_test" },
      expiresAt: null,
      lastRotatedAt: new Date(),
      updatedAt: new Date(),
      encryptionKeyVersion: 1,
    });
  });

  it("does not expose workspace integration metadata to non-admins", async () => {
    const service = createSlackBotSettingsService({ db: unusedDb() });
    await expect(service.getWorkspaceSettings(member)).resolves.toEqual({
      isAdmin: false,
      configured: true,
      installed: false,
      status: "not_connected",
      needsScopeUpgrade: false,
      teamName: null,
      statusReason: null,
      destinationCount: 0,
    });
    expect(getGoatSlackBotIntegrationForWorkspace).not.toHaveBeenCalled();
  });

  it("admin-gates channel listing before loading the bot credential", async () => {
    const service = createSlackBotSettingsService({ db: unusedDb() });
    await expect(service.listChannels(member, "brain_1")).rejects.toMatchObject({
      status: 403,
      message: "Only workspace admins can configure the Slack bot.",
    });
    expect(loadGoatIntegrationCredential).not.toHaveBeenCalled();
  });

  it("pages and sorts channels without returning the bot credential", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        channels: [{ id: "C2", name: "zeta", is_private: true, is_member: false }],
        response_metadata: { next_cursor: "next" },
      })
      .mockResolvedValueOnce({
        channels: [{ id: "C1", name: "alpha", is_private: false, is_member: true }],
      });
    const service = createSlackBotSettingsService({ db: unusedDb(), request });

    await expect(service.listChannels(admin, "brain_1")).resolves.toEqual({
      channels: [
        { id: "C1", name: "alpha", isPrivate: false, isMember: true },
        { id: "C2", name: "zeta", isPrivate: true, isMember: false },
      ],
      partial: false,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("sanitizes destination channels and preserves source-create analytics", async () => {
    const service = createSlackBotSettingsService({ db: unusedDb() });
    await service.setDestination(admin, "brain_1", {
      enabled: true,
      channels: [
        { id: " C1 ", name: " general " },
        { id: "C1", name: "duplicate" },
        { id: "C2", name: "" },
      ],
    });

    expect(upsertGoatBrainSource).toHaveBeenCalledWith(
      expect.objectContaining({
        brainRef: "brain_1",
        integrationId: "gint_slack_bot",
        config: {
          channels: [
            { id: "C1", name: "general" },
            { id: "C2", name: "C2" },
          ],
        },
      }),
    );
    expect(captureGoatServerEvent).toHaveBeenCalledWith(
      "brain_source_added",
      "user_1",
      expect.objectContaining({ provider: "slack_bot" }),
    );
  });

  it("disconnects the workspace bot without returning its credential", async () => {
    const service = createSlackBotSettingsService({ db: unusedDb() });
    await service.disconnect(admin);
    expect(markGoatIntegrationStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: "gint_slack_bot",
        status: "disconnected",
      }),
    );
  });
});
