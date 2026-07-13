import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type GoatIntegrationState, goatIntegrationStateFromRows } from "@/lib/integration-state";
import { SettingsIntegrationsPanel } from "./SettingsIntegrationsPanel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => false,
}));

vi.mock("@/lib/codex-auth", () => ({
  disconnectGoatCodexAuth: vi.fn(),
  pollGoatCodexDeviceAuth: vi.fn(),
  startGoatCodexDeviceAuth: vi.fn(),
}));

describe("SettingsIntegrationsPanel", () => {
  it("always exposes the permanent Goat Brain MCP entry", () => {
    render(
      <SettingsIntegrationsPanel
        initialIntegrations={goatIntegrationStateFromRows([]) as GoatIntegrationState}
        isWorkspaceAdmin={false}
        mcpSetup={{ preferredClient: null, completedAt: null }}
      />,
    );

    const entry = screen.getByRole("link", { name: /Goat Brain MCP/ });
    expect(entry).toHaveAttribute("href", "/setup/mcp");
    expect(entry).toHaveTextContent("Set up");
    expect(entry).toHaveTextContent("Claude, ChatGPT, or Cursor");
  });

  it("reports the verified connection and remembered client", () => {
    render(
      <SettingsIntegrationsPanel
        initialIntegrations={goatIntegrationStateFromRows([]) as GoatIntegrationState}
        isWorkspaceAdmin
        mcpSetup={{
          preferredClient: "cursor",
          completedAt: "2026-07-13T09:00:00.000Z",
        }}
      />,
    );

    const entry = screen.getByRole("link", { name: /Goat Brain MCP/ });
    expect(entry).toHaveTextContent("Connected with Cursor");
    expect(entry).toHaveTextContent("Connected");
  });
});
