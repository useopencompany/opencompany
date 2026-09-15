import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSandboxSizeResult } from "@/lib/sandbox-size";
import { SandboxSettingsPanel, type SandboxSizeOptionView } from "./SandboxSettingsPanel";

const { setWorkspaceSandboxSizeAction, toastError, toastSuccess } = vi.hoisted(() => ({
  setWorkspaceSandboxSizeAction: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

vi.mock("@/lib/sandbox-size", () => ({ setWorkspaceSandboxSizeAction }));

const SANDBOX_SIZE_OPTIONS: SandboxSizeOptionView[] = [
  {
    size: "small",
    label: "Small",
    summary: "Editing, small repos, and quick scripts.",
    cpuCount: 2,
    memoryMB: 4096,
    hourlyCostUsdMicros: 165_600,
  },
  {
    size: "standard",
    label: "Standard",
    summary: "Most work: installs, test suites, and a browser.",
    cpuCount: 4,
    memoryMB: 8192,
    hourlyCostUsdMicros: 331_200,
  },
  {
    size: "large",
    label: "Large",
    summary: "Heavy builds, containers, and large test runs.",
    cpuCount: 8,
    memoryMB: 16384,
    hourlyCostUsdMicros: 662_400,
  },
];

function renderPanel(
  canManage = false,
  sandboxSize: WorkspaceSandboxSizeResult = { ok: true, sandboxSize: "standard" },
) {
  return render(
    <SandboxSettingsPanel
      canManage={canManage}
      sandboxSize={sandboxSize}
      sandboxSizeOptions={SANDBOX_SIZE_OPTIONS}
    />,
  );
}

describe("SandboxSettingsPanel", () => {
  beforeEach(() => {
    setWorkspaceSandboxSizeAction.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
  });

  it("shows each sandbox size with its allocation and hourly price, read-only for members", () => {
    renderPanel();

    const section = screen.getByRole("region", { name: "Sandbox size" });
    expect(within(section).getByText("Small · 2 vCPU · 4 GB")).toBeInTheDocument();
    expect(
      within(section).getByText(/About \$0\.33 per hour of running time\./),
    ).toBeInTheDocument();
    expect(within(section).getByText("Managed by workspace admins.")).toBeInTheDocument();
    for (const radio of within(section).getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
  });

  it("saves an admin's size change and says running sessions keep theirs", async () => {
    setWorkspaceSandboxSizeAction.mockResolvedValueOnce({ ok: true, sandboxSize: "small" });
    renderPanel(true);

    const section = screen.getByRole("region", { name: "Sandbox size" });
    fireEvent.click(within(section).getByRole("radio", { name: /Small/ }));

    await waitFor(() => expect(setWorkspaceSandboxSizeAction).toHaveBeenCalledWith("small"));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "New sessions will run on Small. Sessions already running keep their size.",
      ),
    );
    expect(within(section).getByRole("radio", { name: /Small/ })).toBeChecked();
  });

  it("restores the previous size when the save fails", async () => {
    setWorkspaceSandboxSizeAction.mockResolvedValueOnce({ ok: false, error: "Nope." });
    renderPanel(true);

    const section = screen.getByRole("region", { name: "Sandbox size" });
    fireEvent.click(within(section).getByRole("radio", { name: /Small/ }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Nope."));
    expect(within(section).getByRole("radio", { name: /Standard/ })).toBeChecked();
  });

  it("surfaces a read failure in the card instead of the choices", () => {
    renderPanel(true, { ok: false, error: "Could not load it." });

    const section = screen.getByRole("region", { name: "Sandbox size" });
    expect(within(section).getByText("Could not load it.")).toBeInTheDocument();
    expect(within(section).queryAllByRole("radio")).toHaveLength(0);
  });
});
