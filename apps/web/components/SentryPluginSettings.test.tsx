import "@testing-library/jest-dom/vitest";
import type { CompanySentryPluginDto } from "@opencompany/protocol";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SentryPluginSettings } from "./SentryPluginSettings";

vi.mock("@/lib/sentry-actions", () => ({
  connectSentryAction: vi.fn(),
  disconnectSentryAction: vi.fn(),
  listSentryProjectsAction: vi.fn(),
  saveSentrySettingsAction: vi.fn(),
}));
vi.mock("@opencompany/ui/components/sonner", () => ({ toast: { success: vi.fn() } }));
it("lets members see project access and named outcomes without editing shared settings", () => {
  const plugin = {
    configured: true,
    canManage: false,
    installUrl: null,
    connection: {
      integrationId: "sentry_1",
      workspaceId: "workspace_1",
      installationId: "a8e5d37a-696c-4c54-adb5-b3f28d64c7de",
      organizationId: "123",
      organizationSlug: "acme",
      region: "eu",
      selectedProjectIds: ["1"],
      cooldownMinutes: 30,
      dailyCap: 25,
      verifiedAt: "2026-10-01T00:00:00Z",
      lastReceivedAt: null,
      status: "connected",
      capabilityModes: {},
      toolModes: {},
    },
    events: [],
    usage: 3,
    tools: [],
    outcomes: [
      {
        id: "receipt",
        receivedAt: "2026-10-03T12:00:00Z",
        status: "processed",
        reason: "routed",
        runStatus: "ignored",
        runReason: "active investigation",
        issueId: "42",
        taskId: null,
      },
    ],
  } satisfies CompanySentryPluginDto;
  render(
    <SentryPluginSettings plugin={plugin} projects={[{ id: "1", slug: "web", name: "Web" }]} />,
  );
  expect(screen.getByRole("checkbox", { name: "Web" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Web" })).toBeDisabled();
  expect(screen.getByRole("spinbutton", { name: "Daily event-driven Task cap" })).toBeDisabled();
  expect(screen.getByText("active investigation")).toBeInTheDocument();
  expect(screen.getByText(/3 \/ 25/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save and verify installation" }),
  ).not.toBeInTheDocument();
});
