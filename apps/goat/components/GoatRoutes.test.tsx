import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoatSettingsRoute } from "./GoatRoutes";

const routerMock = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

const appDataMock = vi.hoisted(() => ({
  value: {
    user: {
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: null,
    },
    workspace: { id: "goat_ws_1", name: "Ada's Workspace", role: "admin" },
    featureFlags: { localCodexBridge: false },
    integrations: {},
  },
}));

const userPreferencesMock = vi.hoisted(() => ({
  updateGoatLocalCodexBetaAction: vi.fn(async (enabled: boolean) => ({ ok: true, enabled })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/components/GoatBrainView", () => ({
  GoatBrainView: () => null,
}));

vi.mock("@/components/GoatBrainSettings", () => ({
  GoatBrainSettings: () => null,
}));

vi.mock("@/components/GoatSurface", () => ({
  GoatSurface: () => null,
}));

vi.mock("@/components/JamieIntegrationSetup", () => ({
  JamieIntegrationSetup: () => null,
}));

vi.mock("@/components/TaskDetailPanel", () => ({
  TaskDetailPanel: () => null,
}));

vi.mock("@/components/TaskRunPanel", () => ({
  TaskRunPanel: () => null,
}));

vi.mock("@/components/GoatAppDataProvider", () => ({
  useGoatAppData: () => appDataMock.value,
}));

vi.mock("@/components/SettingsIntegrationsPanel", () => ({
  SettingsIntegrationsPanel: () => <div>Integrations</div>,
}));

vi.mock("@/lib/user-preferences", () => ({
  updateGoatLocalCodexBetaAction: userPreferencesMock.updateGoatLocalCodexBetaAction,
}));

describe("GoatSettingsRoute", () => {
  beforeEach(() => {
    appDataMock.value.featureFlags.localCodexBridge = false;
    routerMock.refresh.mockReset();
    userPreferencesMock.updateGoatLocalCodexBetaAction.mockClear();
  });

  it("shows the Local Codex bridge beta switch and persists changes", async () => {
    const user = userEvent.setup();
    render(<GoatSettingsRoute />);

    const toggle = screen.getByRole("switch", { name: "Local Codex bridge" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(toggle);

    expect(userPreferencesMock.updateGoatLocalCodexBetaAction).toHaveBeenCalledWith(true);
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalled());
  });
});
