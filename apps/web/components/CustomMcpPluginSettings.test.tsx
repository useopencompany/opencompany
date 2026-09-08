import "@testing-library/jest-dom/vitest";
import type { CustomMcpStatusDto, PluginInstallationDto } from "@opencompany/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createCustomMcp,
  disconnectCustomMcp,
  previewCustomMcp,
  refreshCustomMcp,
} from "@/lib/headless-knowledge-commands";
import { AddCustomMcpPlugin, CustomMcpPluginDetail } from "./CustomMcpPluginSettings";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/headless-knowledge-commands", () => ({
  createCustomMcp: vi.fn(),
  previewCustomMcp: vi.fn(),
  refreshCustomMcp: vi.fn(),
  disconnectCustomMcp: vi.fn(),
  connectCustomMcp: vi.fn(),
  setCustomMcpToolMode: vi.fn(),
  archiveHeadlessPlugin: vi.fn(),
  disableHeadlessPlugin: vi.fn(),
  enableHeadlessPlugin: vi.fn(),
}));
const status: CustomMcpStatusDto = {
  label: "Company tools",
  url: "https://tools.example.com/mcp",
  enabled: true,
  account: {
    integrationId: "account",
    revision: "rev-1",
    connected: true,
    tools: [],
    toolModes: {},
    checkedAt: "2026-09-08T10:00:00.000Z",
    error: null,
  },
};
const plugin = { name: "custom-test" } as PluginInstallationDto;
beforeEach(() => {
  vi.clearAllMocks();
});

it("tests before installation and invalidates the preview when the endpoint changes", async () => {
  const user = userEvent.setup();
  vi.mocked(previewCustomMcp).mockResolvedValue({ tools: [], fingerprint: "f".repeat(64) });
  vi.mocked(createCustomMcp).mockResolvedValue({ plugin, replayed: false });
  render(<AddCustomMcpPlugin canEdit />);
  await user.type(screen.getByLabelText("Name"), "Company tools");
  await user.type(screen.getByLabelText("Server URL"), status.url);
  await user.click(screen.getByRole("button", { name: "Test connection" }));
  expect(await screen.findByText(/currently exposes no tools/)).toBeVisible();
  expect(createCustomMcp).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText("Server URL"), "?project=abc");
  expect(screen.queryByRole("button", { name: "Add plugin and connect" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Test connection" }));
  await user.click(await screen.findByRole("button", { name: "Add plugin and connect" }));
  await waitFor(() =>
    expect(createCustomMcp).toHaveBeenCalledWith(
      {
        label: status.label,
        url: `${status.url}?project=abc`,
        headers: {},
        fingerprint: "f".repeat(64),
      },
      expect.any(String),
    ),
  );
  expect(router.push).toHaveBeenCalledWith("/settings/plugins/custom-test");
});

it("shows a connection failure and lets the user retry without installing", async () => {
  const user = userEvent.setup();
  vi.mocked(previewCustomMcp).mockRejectedValue(
    new Error("The endpoint redirects. Enter its final HTTPS URL."),
  );
  render(<AddCustomMcpPlugin canEdit />);
  await user.type(screen.getByLabelText("Name"), "Company tools");
  await user.type(screen.getByLabelText("Server URL"), status.url);
  await user.click(screen.getByRole("button", { name: "Test connection" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("final HTTPS URL");
  expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
  expect(createCustomMcp).not.toHaveBeenCalled();
});

it("keeps personal connection controls available to members and handles refresh errors", async () => {
  const user = userEvent.setup();
  vi.mocked(refreshCustomMcp).mockResolvedValue({
    ...status,
    account: {
      ...status.account!,
      connected: false,
      error: "The server rejected your credentials.",
    },
  });
  vi.mocked(disconnectCustomMcp).mockResolvedValue({ ...status, account: null });
  render(<CustomMcpPluginDetail plugin={plugin} initialStatus={status} canEdit={false} />);
  expect(screen.queryByRole("button", { name: "Disable plugin" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Refresh tools" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("rejected your credentials");
  await user.click(screen.getByRole("button", { name: "Disconnect my account" }));
  expect(await screen.findByRole("button", { name: "Test and connect" })).toBeVisible();
  expect(disconnectCustomMcp).toHaveBeenCalledWith(plugin.name);
});

it("explains admin installation access without exposing a setup form to members", () => {
  render(<AddCustomMcpPlugin canEdit={false} />);
  expect(screen.getByText(/Ask a workspace admin/)).toBeVisible();
  expect(screen.queryByLabelText("Server URL")).not.toBeInTheDocument();
});
