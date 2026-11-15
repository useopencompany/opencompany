import { describe, expect, it } from "vitest";
import { SENSITIVE_CALLBACK_REQUEST_PATTERN } from "./request-logging.mjs";

describe("sensitive callback request logging", () => {
  it.each([
    "/auth/callback?code=workos-code",
    "/integrations/sentry/setup?installationId=test&code=sentry-code",
    "/signin?returnPathname=%2Fintegrations%2Fsentry%2Fsetup%3Fcode%3Dgrant",
    "/signup?returnPathname=%2Fintegrations%2Fsentry%2Fsetup%3Fcode%3Dgrant",
    "/api/integrations/linear/callback?code=linear-code&state=signed-state",
    "/api/integrations/google-drive/callback?state=signed-state",
  ])("suppresses %s", (url) => {
    expect(SENSITIVE_CALLBACK_REQUEST_PATTERN.test(url)).toBe(true);
  });

  it.each([
    "/api/integrations/linear/start",
    "/api/integrations/linear/callback-details",
    "/plugins",
    "/signin",
    "/signup?email=test%40example.com",
  ])("keeps ordinary request logging for %s", (url) => {
    expect(SENSITIVE_CALLBACK_REQUEST_PATTERN.test(url)).toBe(false);
  });
});
