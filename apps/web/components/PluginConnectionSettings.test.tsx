import "@testing-library/jest-dom/vitest";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginConnectionFeedback } from "./PluginConnectionSettings";

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: {
    error: toastError,
    success: toastSuccess,
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/lib/integration-account-actions", () => ({
  disconnectIntegrationAccountAction: vi.fn(async () => ({ ok: true })),
  getIntegrationAccountUsageAction: vi.fn(async () => ({
    ok: true,
    affectedBrainSourceCount: 0,
  })),
}));

describe("PluginConnectionFeedback", () => {
  beforeEach(() => {
    toastError.mockClear();
    toastSuccess.mockClear();
    window.history.replaceState({}, "", "/settings/plugins/hubspot");
  });

  it("shows an actionable OAuth error once and removes the consumed query parameters", async () => {
    window.history.replaceState(
      {},
      "",
      "/settings/plugins/hubspot?integration=hubspot&setup=error&reason=not_configured&section=accounts",
    );

    render(<PluginConnectionFeedback />);

    await waitFor(() => expect(toastError).toHaveBeenCalledOnce());
    expect(toastError).toHaveBeenCalledWith(
      "HubSpot isn't available right now. Please try again later.",
    );
    expect(window.location.search).toBe("?section=accounts");
  });

  it("confirms a completed OAuth connection and clears its callback parameters", async () => {
    window.history.replaceState(
      {},
      "",
      "/settings/plugins/hubspot?integration=hubspot&setup=connected",
    );

    render(<PluginConnectionFeedback />);

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("HubSpot connected."));
    expect(window.location.search).toBe("");
  });
});
