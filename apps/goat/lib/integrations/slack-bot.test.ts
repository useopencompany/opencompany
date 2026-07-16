import { afterEach, describe, expect, it, vi } from "vitest";
import { isGoatSlackBotConfigured } from "./slack-bot";

const REQUIRED_ENVS = {
  INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: "encryption-key",
  GOAT_SLACK_BOT_CLIENT_ID: "client-id",
  GOAT_SLACK_BOT_CLIENT_SECRET: "client-secret",
  GOAT_SLACK_BOT_SIGNING_SECRET: "signing-secret",
  GOAT_SLACK_BOT_STATE_SECRET: "state-secret",
} as const;

describe("isGoatSlackBotConfigured", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires the credential encryption key as well as the Slack app secrets", () => {
    for (const [name, value] of Object.entries(REQUIRED_ENVS)) vi.stubEnv(name, value);
    expect(isGoatSlackBotConfigured()).toBe(true);

    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", "");
    expect(isGoatSlackBotConfigured()).toBe(false);
  });
});
