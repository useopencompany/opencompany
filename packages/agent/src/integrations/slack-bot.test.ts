import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSlackBotConfigured,
  SLACK_BOT_SCOPES,
  slackBotCanReact,
  slackBotCanUploadFiles,
  slackBotDeliveryScopesSatisfied,
  slackBotScopesSatisfied,
} from "./slack-bot";

const REQUIRED_ENVS = {
  INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: "encryption-key",
  OPENCOMPANY_SLACK_BOT_CLIENT_ID: "client-id",
  OPENCOMPANY_SLACK_BOT_CLIENT_SECRET: "client-secret",
  OPENCOMPANY_SLACK_BOT_SIGNING_SECRET: "signing-secret",
  OPENCOMPANY_SLACK_BOT_STATE_SECRET: "state-secret",
} as const;

describe("isSlackBotConfigured", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires the credential encryption key as well as the Slack app secrets", () => {
    for (const [name, value] of Object.entries(REQUIRED_ENVS)) vi.stubEnv(name, value);
    expect(isSlackBotConfigured()).toBe(true);

    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", "");
    expect(isSlackBotConfigured()).toBe(false);
  });
});

describe("slackBotScopesSatisfied", () => {
  it("is true when every required scope was granted", () => {
    expect(slackBotScopesSatisfied([...SLACK_BOT_SCOPES])).toBe(true);
    expect(slackBotScopesSatisfied([...SLACK_BOT_SCOPES, "extra:scope"])).toBe(true);
  });

  it("is false for installs missing the user scopes needed for follow-up attribution", () => {
    const v1Scopes = [
      "app_mentions:read",
      "chat:write",
      "channels:read",
      "groups:read",
      "channels:history",
      "groups:history",
    ];
    expect(slackBotScopesSatisfied(v1Scopes)).toBe(false);
    expect(slackBotScopesSatisfied([])).toBe(false);
  });

  it("keeps existing installations operational while the email scope is reauthorized", () => {
    const existingScopes = SLACK_BOT_SCOPES.filter((scope) => scope !== "users:read.email");
    expect(slackBotDeliveryScopesSatisfied(existingScopes)).toBe(true);
    expect(slackBotScopesSatisfied(existingScopes)).toBe(false);
  });
});

describe("slackBotCanReact", () => {
  it("lets a granted install mark thread replies and leaves older ones delivering unmarked", () => {
    expect(slackBotCanReact([...SLACK_BOT_SCOPES])).toBe(true);

    const beforeReactions = SLACK_BOT_SCOPES.filter((scope) => scope !== "reactions:write");
    expect(slackBotCanReact(beforeReactions)).toBe(false);
    expect(slackBotDeliveryScopesSatisfied(beforeReactions)).toBe(true);
    expect(slackBotScopesSatisfied(beforeReactions)).toBe(false);
  });
});

describe("slackBotCanUploadFiles", () => {
  it("requests image uploads for new installs and keeps older ones delivering text", () => {
    expect(slackBotCanUploadFiles([...SLACK_BOT_SCOPES])).toBe(true);

    const beforeImages = SLACK_BOT_SCOPES.filter((scope) => scope !== "files:write");
    expect(slackBotCanUploadFiles(beforeImages)).toBe(false);
    expect(slackBotDeliveryScopesSatisfied(beforeImages)).toBe(true);
    expect(slackBotScopesSatisfied(beforeImages)).toBe(false);
  });
});
