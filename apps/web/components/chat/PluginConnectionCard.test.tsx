import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PluginConnectionCard } from "./PluginConnectionCard";

const state = vi.hoisted(() => ({ connected: false, refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: state.refresh }),
}));
vi.mock("@/components/AppDataProvider", () => ({
  useAppDataOptional: () => ({ integrations: {} }),
}));
vi.mock("@/lib/plugin-connection-state", () => ({
  pluginAccountsFromState: () => ({}),
  pluginConnectionSatisfied: () => state.connected,
}));

afterEach(() => {
  state.connected = false;
  state.refresh.mockReset();
  window.sessionStorage.clear();
});

it("resumes the session once the clicked connection becomes healthy", async () => {
  const onResume = vi.fn(async () => undefined);
  const props = {
    pluginName: "stripe",
    status: "needs_reauth" as const,
    messageId: "assistant_1",
    onResume,
  };
  const { rerender } = render(<PluginConnectionCard {...props} />);
  expect(screen.getByText("Reconnect to continue")).toBeVisible();
  expect(onResume).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("link", { name: "Reconnect" }));
  state.connected = true;
  rerender(<PluginConnectionCard {...props} />);
  await waitFor(() => expect(onResume).toHaveBeenCalledOnce());
  expect(onResume).toHaveBeenCalledWith("stripe", expect.any(String));
  await waitFor(() => expect(screen.getByText("Connected")).toBeVisible());
  rerender(<PluginConnectionCard {...props} />);
  expect(onResume).toHaveBeenCalledOnce();
});

it("restores a pending connection after the chat remounts", async () => {
  const onResume = vi.fn(async () => undefined);
  const props = {
    pluginName: "stripe",
    status: "not_connected" as const,
    messageId: "assistant_after_reload",
    onResume,
  };
  const first = render(<PluginConnectionCard {...props} />);
  await userEvent.click(screen.getByRole("link", { name: "Connect" }));
  first.unmount();

  state.connected = true;
  render(<PluginConnectionCard {...props} />);
  await waitFor(() => expect(onResume).toHaveBeenCalledOnce());
});

it("refreshes server-backed connection state when the user returns to chat", async () => {
  render(
    <PluginConnectionCard
      pluginName="infisical"
      status="not_connected"
      messageId="assistant_server_snapshot"
      onResume={vi.fn(async () => undefined)}
    />,
  );
  await userEvent.click(screen.getByRole("link", { name: "Connect" }));

  window.dispatchEvent(new Event("focus"));

  await waitFor(() => expect(state.refresh).toHaveBeenCalledOnce());
});
