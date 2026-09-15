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
  setCustomMcpToolMode,
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
  expect(router.push).toHaveBeenCalledWith("/plugins/custom-test");
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

it("keeps personal connection controls available without installation write permission and handles refresh errors", async () => {
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

it("requires plugin write permission for installation", () => {
  render(<AddCustomMcpPlugin canEdit={false} />);
  expect(screen.getByText(/You need plugin write permission/)).toBeVisible();
  expect(screen.queryByLabelText("Server URL")).not.toBeInTheDocument();
});

it("uses the shared tool permission control, defaulting each tool to Ask", async () => {
  const user = userEvent.setup();
  const withTools: CustomMcpStatusDto = {
    ...status,
    account: {
      ...status.account!,
      tools: [
        { name: "run_query", description: "Run a read-only query." },
        { name: "drop_table", description: "Delete a table and its rows." },
      ],
      toolModes: { drop_table: "off" },
    },
  };
  vi.mocked(setCustomMcpToolMode).mockResolvedValue(withTools);
  render(<CustomMcpPluginDetail plugin={plugin} initialStatus={withTools} canEdit />);

  // A custom server has no capability group, so an unset tool reads Ask and only the tool the
  // user moved off that default carries the marker.
  expect(screen.getByRole("combobox", { name: "Permission for run_query" })).toHaveTextContent(
    "Ask",
  );
  expect(screen.getByRole("combobox", { name: "Permission for drop_table" })).toHaveTextContent(
    "Off",
  );

  await user.click(screen.getByRole("combobox", { name: "Permission for run_query" }));
  await user.click(await screen.findByRole("option", { name: "On" }));
  await waitFor(() =>
    expect(setCustomMcpToolMode).toHaveBeenCalledWith("custom-test", {
      tool: "run_query",
      mode: "on",
      revision: "rev-1",
    }),
  );

  // "Default" has to reach the store as Ask, since there is no group key to clear here.
  await user.click(screen.getByRole("combobox", { name: "Permission for drop_table" }));
  await user.click(await screen.findByRole("option", { name: "Default (Ask)" }));
  await waitFor(() =>
    expect(setCustomMcpToolMode).toHaveBeenLastCalledWith("custom-test", {
      tool: "drop_table",
      mode: "ask",
      revision: "rev-1",
    }),
  );
});
