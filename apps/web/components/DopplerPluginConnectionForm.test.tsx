import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  poll: vi.fn(),
  cancel: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/doppler-auth", () => ({
  startDopplerAuth: mocks.start,
  pollDopplerAuth: mocks.poll,
  cancelDopplerAuth: mocks.cancel,
}));

import { DopplerPluginConnectionForm } from "./DopplerPluginConnectionForm";

const settings = { status: null, statusReason: null, accountName: null, lastValidatedAt: null };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.cancel.mockResolvedValue({ ok: true });
});
afterEach(cleanup);
it("shows the authorization code and cancels pending sign-in", async () => {
  mocks.start.mockResolvedValue({
    ok: true,
    flow: {
      id: "flow_1",
      status: "link_ready",
      loginUrl: "https://dashboard.doppler.com/workplace/auth/cli",
      userCode: "demo_code",
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      statusReason: null,
    },
  });
  render(<DopplerPluginConnectionForm settings={settings} enabled />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Connect Doppler" }));
  expect(await screen.findByText("demo_code")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Open Doppler/ })).toHaveAttribute(
    "href",
    "https://dashboard.doppler.com/workplace/auth/cli",
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(false));
  expect(screen.queryByText("demo_code")).not.toBeInTheDocument();
});
it("keeps failures actionable", async () => {
  mocks.start.mockResolvedValue({ ok: false, error: "Could not start Doppler sign-in." });
  render(<DopplerPluginConnectionForm settings={settings} enabled />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Connect Doppler" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not start");
  expect(screen.getByRole("button", { name: "Connect Doppler" })).toBeEnabled();
});
it("requires an enabled plugin", () => {
  render(<DopplerPluginConnectionForm settings={settings} enabled={false} />);
  expect(screen.queryByRole("button", { name: "Connect Doppler" })).not.toBeInTheDocument();
});

it("offers reconnect and disconnect after credential rejection", async () => {
  render(
    <DopplerPluginConnectionForm
      settings={{ ...settings, status: "needs_reauth", statusReason: "Saved login was revoked." }}
      enabled
    />,
  );
  expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
  expect(screen.getByRole("alert")).toHaveTextContent("revoked");
  await userEvent.setup().click(screen.getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(true));
});
