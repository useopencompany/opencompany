import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotSettingsButton, BotsProvider, SidebarBots } from "./Bots";

const state = vi.hoisted(() => ({
  enabled: true,
  list: vi.fn(),
  save: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/components/AppDataProvider", () => ({
  useAppData: () => ({ featureFlags: { bots: state.enabled }, workspace: { id: "workspace_1" } }),
}));
vi.mock("@/lib/bots", () => ({ listBots: state.list, saveBot: state.save }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/chat/bot_1",
  useRouter: () => ({ push: state.push, refresh: state.refresh }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = true;
  state.list.mockResolvedValue([]);
  window.localStorage.clear();
});
afterEach(cleanup);
it("hides bots and does not fetch when disabled", () => {
  state.enabled = false;
  render(
    <BotsProvider>
      <SidebarBots />
    </BotsProvider>,
  );
  expect(screen.queryByRole("button", { name: "Create bot" })).not.toBeInTheDocument();
  expect(state.list).not.toHaveBeenCalled();
});
it("creates a bot and keeps the creation ID on a failed request retry", async () => {
  const user = userEvent.setup();
  state.save
    .mockRejectedValueOnce(new Error("Please retry"))
    .mockImplementationOnce(async (bot) => bot);
  render(
    <BotsProvider>
      <SidebarBots />
    </BotsProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Create bot" }));
  await user.type(screen.getByLabelText("Name"), "Research");
  await user.type(screen.getByLabelText("Description"), "Find customers");
  const submit = screen.getByRole("button", { name: "Create bot" });
  await user.click(submit);
  expect(await screen.findByRole("alert")).toHaveTextContent("Please retry");
  await user.click(submit);
  await waitFor(() => expect(state.push).toHaveBeenCalled());
  expect(state.save.mock.calls[0]?.[0]).toEqual(state.save.mock.calls[1]?.[0]);
  expect(state.save.mock.calls[1]?.[0]).toMatchObject({
    name: "Research",
    description: "Find customers",
  });
});
it("edits settings on the existing conversation", async () => {
  const user = userEvent.setup();
  state.list.mockResolvedValue([{ id: "bot_1", name: "Research", description: "Find customers" }]);
  state.save.mockImplementation(async (bot) => bot);
  render(
    <BotsProvider>
      <SidebarBots />
      <BotSettingsButton conversationId="bot_1" />
    </BotsProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Bot settings" }));
  await user.clear(screen.getByLabelText("Name"));
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await user.type(screen.getByLabelText("Name"), "Customer research");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(state.save).toHaveBeenCalledWith(
      { id: "bot_1", name: "Customer research", description: "Find customers" },
      false,
    ),
  );
  expect(state.push).not.toHaveBeenCalled();
});

it("keeps the shared chat surface usable outside the authenticated bots provider", () => {
  render(<BotSettingsButton conversationId="chat_1" />);
  expect(screen.queryByRole("button", { name: "Bot settings" })).not.toBeInTheDocument();
});

it("retains existing bots when creation finishes before the initial list loads", async () => {
  const user = userEvent.setup();
  const existing = { id: "bot_existing", name: "Existing assistant", description: "" };
  let resolveInitial!: (bots: (typeof existing)[]) => void;
  state.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveInitial = resolve;
      }),
  );
  state.save.mockImplementationOnce(async (bot) => {
    state.list.mockResolvedValue([bot, existing]);
    return bot;
  });
  render(
    <BotsProvider>
      <SidebarBots />
    </BotsProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Create bot" }));
  await user.type(screen.getByLabelText("Name"), "New assistant");
  await user.click(screen.getByRole("button", { name: "Create bot" }));
  expect(await screen.findByRole("link", { name: "Existing assistant" })).toBeInTheDocument();
  await act(async () => {
    resolveInitial([]);
  });
  expect(screen.getByRole("link", { name: "New assistant" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Existing assistant" })).toBeInTheDocument();
});

it("collapses the bots section and remembers the choice", async () => {
  const user = userEvent.setup();
  state.list.mockResolvedValue([{ id: "bot_1", name: "Research", description: "Find customers" }]);
  const { unmount } = render(
    <BotsProvider>
      <SidebarBots />
    </BotsProvider>,
  );
  expect(await screen.findByRole("link", { name: "Research" })).toBeInTheDocument();
  const toggle = screen.getByRole("button", { name: "Bots" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");

  await user.click(toggle);

  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("link", { name: "Research" })).not.toBeInTheDocument();

  unmount();
  render(
    <BotsProvider>
      <SidebarBots />
    </BotsProvider>,
  );

  expect(screen.getByRole("button", { name: "Bots" })).toHaveAttribute("aria-expanded", "false");
  await user.click(screen.getByRole("button", { name: "Bots" }));
  expect(await screen.findByRole("link", { name: "Research" })).toBeInTheDocument();
});

it("keeps a collapsed bots section closed when creation is abandoned", async () => {
  const user = userEvent.setup();
  window.localStorage.setItem("opencompany-sidebar-bots-collapsed", "true");
  state.list.mockResolvedValue([]);
  render(
    <BotsProvider>
      <SidebarBots />
    </BotsProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Create bot" }));
  await user.keyboard("{Escape}");

  expect(state.save).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Bots" })).toHaveAttribute("aria-expanded", "false");
});

it("reopens a collapsed bots section when a bot is created", async () => {
  const user = userEvent.setup();
  window.localStorage.setItem("opencompany-sidebar-bots-collapsed", "true");
  state.list.mockResolvedValue([]);
  state.save.mockImplementation(async (bot) => {
    state.list.mockResolvedValue([bot]);
    return bot;
  });
  render(
    <BotsProvider>
      <SidebarBots />
    </BotsProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Create bot" }));
  await user.type(screen.getByLabelText("Name"), "Research");
  await user.click(screen.getByRole("button", { name: "Create bot" }));

  expect(await screen.findByRole("link", { name: "Research" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Bots" })).toHaveAttribute("aria-expanded", "true");
});
