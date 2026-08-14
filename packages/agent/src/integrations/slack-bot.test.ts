import { afterEach, describe, expect, it, vi } from "vitest";
import { isSlackBotConfigured, SLACK_BOT_SCOPES, slackBotScopesSatisfied } from "./slack-bot";

const REQUIRED_ENVS = {
  INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: "encryption-key",
  GOAT_SLACK_BOT_CLIENT_ID: "client-id",
  GOAT_SLACK_BOT_CLIENT_SECRET: "client-secret",
  GOAT_SLACK_BOT_SIGNING_SECRET: "signing-secret",
  GOAT_SLACK_BOT_STATE_SECRET: "state-secret",
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

  it("is false for pre-v2 installs missing the DM/reaction/user scopes", () => {
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
});
