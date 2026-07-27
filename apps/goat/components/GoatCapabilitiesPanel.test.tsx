import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoatCapabilitiesPanel } from "./GoatCapabilitiesPanel";

const mocks = vi.hoisted(() => ({
  setCapability: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/capabilities/actions", () => ({
  setWorkspaceCapabilityAction: mocks.setCapability,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

const capabilities = [
  { source: "x", enabled: true },
  { source: "linkedin", enabled: true },
  { source: "youtube", enabled: true },
  { source: "instagram", enabled: true },
  { source: "tiktok", enabled: true },
  { source: "lead", enabled: true },
  { source: "seo", enabled: true },
] as const;

describe("GoatCapabilitiesPanel", () => {
  beforeEach(() => {
    mocks.setCapability.mockResolvedValue({ ok: true, source: "x", enabled: false });
  });

  it("shows all managed sources as enabled to every workspace member", () => {
    render(<GoatCapabilitiesPanel capabilities={[...capabilities]} isAdmin={false} />);
    expect(screen.getAllByRole("switch")).toHaveLength(7);
    for (const toggle of screen.getAllByRole("switch")) {
      expect(toggle).toBeChecked();
      expect(toggle).toHaveAttribute("aria-disabled", "true");
    }
    expect(screen.getByText(/Only workspace admins can change/i)).toBeVisible();
    expect(screen.getByText(/provider cost plus a 20% platform fee/i)).toBeVisible();
    expect(screen.getByText("Prospecting")).toBeVisible();
    expect(screen.getByText(/Find targeted professional prospects/i)).toBeVisible();
  });

  it("lets an admin disable one source without changing the others", async () => {
    const user = userEvent.setup();
    render(<GoatCapabilitiesPanel capabilities={[...capabilities]} isAdmin />);
    await user.click(screen.getByRole("switch", { name: "Disable X" }));
    await waitFor(() =>
      expect(mocks.setCapability).toHaveBeenCalledWith({ source: "x", enabled: false }),
    );
    expect(screen.getByRole("switch", { name: "Enable X" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Disable LinkedIn" })).toBeChecked();
    expect(mocks.refresh).toHaveBeenCalled();
  });
});
