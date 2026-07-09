import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoatBrainView } from "@/components/GoatBrainView";
import { GoatBrainRoute, GoatSettingsRoute } from "./GoatRoutes";

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
    workspaceMembers: [],
    featureFlags: { localCodexBridge: false },
    integrations: {},
  },
}));

const userPreferencesMock = vi.hoisted(() => ({
  updateGoatLocalCodexBetaAction: vi.fn(async (enabled: boolean) => ({ ok: true, enabled })),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: toastMock,
}));

vi.mock("@/components/GoatBrainView", () => ({
  GoatBrainView: vi.fn(() => <div data-testid="brain-view" />),
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
  const fetchMock = vi.fn();
  const createObjectUrlMock = vi.fn(() => "blob:bridge-launcher");
  const revokeObjectUrlMock = vi.fn();

  beforeEach(() => {
    appDataMock.value.featureFlags.localCodexBridge = false;
    routerMock.refresh.mockReset();
    userPreferencesMock.updateGoatLocalCodexBetaAction.mockClear();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
    fetchMock.mockReset();
    createObjectUrlMock.mockClear();
    revokeObjectUrlMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: createObjectUrlMock,
      revokeObjectURL: revokeObjectUrlMock,
    });
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

  it("downloads a paired Local Codex bridge launcher when beta is enabled", async () => {
    appDataMock.value.featureFlags.localCodexBridge = true;
    fetchMock.mockResolvedValueOnce(new Response("#!/bin/zsh\necho bridge\n"));
    const clickMock = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const user = userEvent.setup();
    render(<GoatSettingsRoute />);

    await user.click(screen.getByRole("button", { name: "Download Mac launcher" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/local-codex/bridges/launcher", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: expect.stringContaining("Local Codex"),
    });
    await waitFor(() => expect(createObjectUrlMock).toHaveBeenCalled());
    expect(clickMock).toHaveBeenCalled();
    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:bridge-launcher");
    expect(toastMock.success).toHaveBeenCalledWith("Bridge launcher downloaded.");

    clickMock.mockRestore();
  });
});

describe("GoatBrainRoute", () => {
  beforeEach(() => {
    vi.mocked(GoatBrainView).mockClear();
  });

  it("passes an explicit route brain id through to the Brain view", () => {
    render(
      <GoatBrainRoute
        path={["people", "ada-lovelace"]}
        routeBrainId="goat_brain_team"
        selectedBrain={teamBrain}
        initialBrainSnapshot={brainSnapshot}
      />,
    );

    expect(screen.getByTestId("brain-view")).toBeInTheDocument();
    expect(vi.mocked(GoatBrainView)).toHaveBeenCalledWith(
      expect.objectContaining({
        brainRef: "goat_brain_team",
        brain: teamBrain,
        folders: brainSnapshot.folders,
        documents: brainSnapshot.documents,
        initialFolderPath: "people",
        initialBrainId: "ada-lovelace",
        routeBrainId: "goat_brain_team",
      }),
      undefined,
    );
  });

  it("uses the selected active brain for default /brain routes without URL prefixing", () => {
    render(
      <GoatBrainRoute
        path={["people", "ada-lovelace"]}
        routeBrainId={null}
        selectedBrain={defaultBrain}
        initialBrainSnapshot={brainSnapshot}
      />,
    );

    expect(vi.mocked(GoatBrainView)).toHaveBeenCalledWith(
      expect.objectContaining({
        brainRef: "goat_brain_default",
        brain: defaultBrain,
        initialFolderPath: "people",
        initialBrainId: "ada-lovelace",
        routeBrainId: null,
      }),
      undefined,
    );
  });
});

const defaultBrain = {
  id: "goat_brain_default",
  name: "Default",
  slug: "default",
  description: null,
  visibility: "workspace" as const,
};

const teamBrain = {
  id: "goat_brain_team",
  name: "Team",
  slug: "team",
  description: null,
  visibility: "workspace" as const,
};

const brainSnapshot = {
  folders: [
    {
      id: "folder_people",
      path: "people",
      name: "People",
      source: "system" as const,
      createdAt: "2026-07-06T12:00:00.000Z",
      updatedAt: "2026-07-06T12:00:00.000Z",
    },
  ],
  documents: [
    {
      id: "doc_ada",
      brainId: "ada-lovelace",
      folderPath: "people",
      path: "people/ada-lovelace.md",
      title: "Ada Lovelace",
      content: "",
      body: "Compiler and collaborator.",
      timeline: [],
      format: "markdown" as const,
      mimeType: "text/markdown",
      originalFileName: null,
      assetStorageKey: null,
      assetSizeBytes: null,
      relations: [],
      sources: [],
      kind: "page" as const,
      type: "person" as const,
      status: "draft" as const,
      aliases: [],
      contentHash: "hash",
      sizeBytes: 128,
      createdAt: "2026-07-06T12:00:00.000Z",
      updatedAt: "2026-07-06T12:00:00.000Z",
    },
  ],
};
