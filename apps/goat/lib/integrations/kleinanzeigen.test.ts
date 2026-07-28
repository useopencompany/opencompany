import {
  createGoatBrowserUseAgentSession,
  isValidGoatBrowserUseApiKey,
  safeBrowserUseLiveUrl,
  safeKleinanzeigenListingUrl,
  validateGoatBrowserUseApiKey,
} from "@opencompany/goat-agent/integrations/kleinanzeigen";

const connection = {
  integrationId: "gint_kleinanzeigen",
  userWorkosId: "user_1",
  accountName: "Browser Use",
  capabilityModes: {},
  apiKey: "browser-use-key-1234567890",
  projectId: "f7d44c26-f2d4-4a73-907d-76ad11340e14",
  profileId: "1cb05392-07af-431e-bc73-5018880ece7b",
  browserWorkspaceId: "d3793d62-d4ca-4f3d-8747-8e634208b811",
  connectedAt: "2026-07-28T00:00:00.000Z",
};

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Kleinanzeigen Browser Use integration", () => {
  it("accepts opaque non-whitespace API keys without assuming a provider prefix", () => {
    expect(isValidGoatBrowserUseApiKey("browser-use-key-1234567890")).toBe(true);
    expect(isValidGoatBrowserUseApiKey("short")).toBe(false);
    expect(isValidGoatBrowserUseApiKey(`key ${"x".repeat(30)}`)).toBe(false);
  });

  it("validates the key against the authenticated Browser Use billing account", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          projectId: "f7d44c26-f2d4-4a73-907d-76ad11340e14",
          name: "Louis",
          totalCreditsBalanceUsd: 8.25,
          planInfo: { planName: "Pay as you go" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateGoatBrowserUseApiKey("browser-use-key-1234567890")).resolves.toEqual({
      ok: true,
      identity: {
        projectId: "f7d44c26-f2d4-4a73-907d-76ad11340e14",
        accountName: "Louis",
        planName: "Pay as you go",
        creditsBalanceUsd: 8.25,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://api.browser-use.com/api/v2/billing/account"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Browser-Use-API-Key": "browser-use-key-1234567890",
        }),
      }),
    );
  });

  it("only returns trusted live-browser and Kleinanzeigen URLs", () => {
    expect(safeBrowserUseLiveUrl("https://live.browser-use.com/session/abc")).toBe(
      "https://live.browser-use.com/session/abc",
    );
    expect(safeBrowserUseLiveUrl("https://browser-use.com.evil.test/session")).toBeNull();
    expect(
      safeKleinanzeigenListingUrl(
        "https://www.kleinanzeigen.de/s-anzeige/holzstuhl/1234567890-86-1234",
      ),
    ).toBe("https://www.kleinanzeigen.de/s-anzeige/holzstuhl/1234567890-86-1234");
    expect(safeKleinanzeigenListingUrl("https://kleinanzeigen.de.evil.test/fake")).toBeNull();
  });

  it("launches a bounded v3 session with the dedicated profile and workspace", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "cb451291-da6e-4b52-a420-3e3eb9587fbd",
          status: "created",
          liveUrl: "https://live.browser-use.com/session/abc",
          output: null,
          isTaskSuccessful: null,
          profileId: connection.profileId,
          workspaceId: connection.browserWorkspaceId,
          lastStepSummary: null,
          totalCostUsd: "0",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createGoatBrowserUseAgentSession({
      connection,
      task: "Create one approved listing",
      outputSchema: { type: "object" },
      keepAlive: true,
    });

    const [, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({
      task: "Create one approved listing",
      model: "claude-sonnet-4.6",
      keepAlive: true,
      maxCostUsd: 0.75,
      profileId: connection.profileId,
      workspaceId: connection.browserWorkspaceId,
      proxyCountryCode: "de",
      enableScheduledTasks: false,
      enableRecording: false,
      skills: false,
      agentmail: false,
      cacheScript: false,
    });
  });
});
