import { afterEach, expect, it, vi } from "vitest";
import { getExpiringOAuthAccessToken } from "./expiring-oauth-access-token";

const mocks = vi.hoisted(() => ({ load: vi.fn(), claim: vi.fn() }));
vi.mock("@opencompany/db/integrations", () => ({
  loadIntegrationCredential: mocks.load,
  claimIntegrationCredentialRefresh: mocks.claim,
  markIntegrationStatus: vi.fn(),
  releaseIntegrationCredentialRefresh: vi.fn(),
  rotateIntegrationCredential: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("waits for a provider refresh in another process that takes longer than the fast polls", async () => {
  vi.useFakeTimers();
  const now = new Date("2026-10-07T12:00:00Z");
  vi.setSystemTime(now);
  mocks.claim.mockResolvedValue(false);
  mocks.load.mockImplementation(async () => {
    const rotated = Date.now() - now.getTime() >= 2_000;
    return {
      payload: { access_token: rotated ? "new-token" : "expired-token" },
      lastRotatedAt: rotated ? new Date(now.getTime() + 2_000) : new Date(now.getTime() - 10_000),
      expiresAt: rotated ? new Date(now.getTime() + 28_800_000) : new Date(now.getTime() - 1_000),
    };
  });
  const refresh = vi.fn();
  const result = getExpiringOAuthAccessToken({
    connection: { integrationId: "test", userWorkosId: "test", provider: "sentry" },
    displayName: "Sentry",
    parseCredential: (payload) => ({
      accessToken: String(payload.access_token),
      refreshToken: null,
      payload,
    }),
    refresh,
    createAuthError: (message) => new Error(message),
    missingCredential: { message: "missing", statusReason: "missing" },
    invalidCredential: { message: "invalid", statusReason: "invalid" },
    options: { db: {}, now },
  });
  await vi.advanceTimersByTimeAsync(3_000);
  await expect(result).resolves.toBe("new-token");
  expect(refresh).not.toHaveBeenCalled();
});
