import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOAT_HOME_NAVIGATION_EVENT } from "@/lib/chat-navigation";
import { GoatSidebar } from "./GoatSidebar";

const pathnameMock = vi.hoisted(() => ({ value: "/" }));
const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
}));
const workspaceRoleMock = vi.hoisted(() => ({
  value: "admin" as "admin" | "member",
}));
const mcpSetupMock = vi.hoisted(() => ({ completedAt: null as string | null }));
const recentChatsMock = vi.hoisted(() => ({
  value: [] as Array<{
    id: string;
    title: string;
    model: string;
    engine: string;
    codexComposerSettings: null;
    preview: string;
    updatedAt: string;
    pinnedAt: string | null;
  }>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock.value,
  useRouter: () => routerMock,
}));

vi.mock("@/lib/workspace-actions", () => ({
  switchGoatBrainAction: vi.fn(),
  switchGoatWorkspaceAction: vi.fn(),
  createGoatBrainAction: vi.fn(),
  setGoatBrainAccessAction: vi.fn(),
  getGoatBrainAccessDetailsAction: vi.fn(),
}));

const chatActionsMock = vi.hoisted(() => ({
  closeGoatChatSessionAction: vi.fn(async () => ({ ok: true, error: null })),
  setGoatChatPinnedAction: vi.fn(async () => ({ ok: true, error: null })),
}));

vi.mock("@/lib/chat-actions", () => chatActionsMock);

vi.mock("@/components/GoatAppDataProvider", () => ({
  useGoatAppData: () => ({
    user: {
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: null,
    },
    workspace: { id: "goat_ws_1", name: "Ada's Workspace", role: workspaceRoleMock.value },
    workspaces: [{ id: "goat_ws_1", name: "Ada's Workspace", role: workspaceRoleMock.value }],
    workspaceMembers: [],
    brains: [
      {
        id: "goat_brain_1",
        name: "General",
        slug: "general",
        description: null,
        visibility: "workspace",
      },
    ],
    activeBrain: {
      id: "goat_brain_1",
      name: "General",
      slug: "general",
      description: null,
      visibility: "workspace",
    },
    recentChats: recentChatsMock.value,
    mcpSetup: { preferredClient: null, completedAt: mcpSetupMock.completedAt },
  }),
}));

describe("GoatSidebar", () => {
  afterEach(() => {
    vi.clearAllMocks();
    pathnameMock.value = "/";
    workspaceRoleMock.value = "admin";
    mcpSetupMock.completedAt = null;
    recentChatsMock.value = [];
  });

  it("renders home, the brain list, and footer links", () => {
    pathnameMock.value = "/";
    const { container } = render(<GoatSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByText("Ada's Workspace")).toBeInTheDocument();
    expect(screen.queryByText("admin")).not.toBeInTheDocument();
    expect(container.querySelector('svg[viewBox="0 0 100 100"]')).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "Goat primary" });
    const home = within(nav).getByRole("link", { name: "Home" });
    expect(home).toHaveAttribute("href", "/");
    expect(home).toHaveAttribute("aria-current", "page");
    expect(within(nav).queryByRole("link", { name: "Brain" })).not.toBeInTheDocument();
    expect(screen.getByText("Brains")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "General" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "New brain" })).toHaveClass("opacity-0");
    expect(screen.queryByText("New brain")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Manage access to General" }),
    ).not.toBeInTheDocument();

    const settings = screen.getByRole("link", { name: /Ada Lovelace/ });
    expect(settings).toHaveAttribute("href", "/settings");

    const feedback = screen.getByRole("button", { name: "Feedback" });
    const changelog = screen.getByRole("link", { name: "Changelog" });
    expect(changelog).toHaveAttribute("href", "/changelog");
    expect(feedback.nextElementSibling).toBe(changelog);
    expect(changelog.nextElementSibling).toBe(settings);
  });

  it("requests an immediate home reset on a normal Home click", async () => {
    const user = userEvent.setup();
    const homeNavigation = vi.fn();
    window.addEventListener(GOAT_HOME_NAVIGATION_EVENT, homeNavigation);
    render(<GoatSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(screen.getByRole("link", { name: "Home" }));

    expect(homeNavigation).toHaveBeenCalledOnce();
    window.removeEventListener(GOAT_HOME_NAVIGATION_EVENT, homeNavigation);
  });

  it("does not mark home active on nested brain routes", () => {
    pathnameMock.value = "/brain/people/ada-lovelace";
    render(<GoatSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const nav = screen.getByRole("navigation", { name: "Goat primary" });
    expect(within(nav).getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "page");
  });

  it("shows MCP setup until the first successful query is verified", () => {
    pathnameMock.value = "/settings/mcp";
    render(<GoatSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const setup = screen.getByRole("link", { name: "Connect your brain" });
    expect(setup).toHaveAttribute("href", "/settings/mcp");
    expect(setup).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /Ada Lovelace/ })).not.toHaveAttribute("aria-current");
  });

  it("hides MCP setup after completion", () => {
    pathnameMock.value = "/settings/mcp";
    mcpSetupMock.completedAt = "2026-07-13T09:00:00.000Z";
    render(<GoatSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.queryByRole("link", { name: "Connect your brain" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ada Lovelace/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("does not mark home active on chat subroutes", () => {
    pathnameMock.value = "/chat/goat_chat_123";
    render(<GoatSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const nav = screen.getByRole("navigation", { name: "Goat primary" });
    expect(within(nav).getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("exposes the active brain as a prefetchable route", () => {
    pathnameMock.value = "/";
    render(<GoatSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByRole("link", { name: "General" })).toHaveAttribute(
      "href",
      "/brain/goat_brain_1",
    );
  });

  it("does not show brain creation to workspace members", () => {
    workspaceRoleMock.value = "member";
    pathnameMock.value = "/";

    render(<GoatSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByRole("link", { name: "General" })).toBeInTheDocument();
    expect(screen.queryByText("member")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New brain" })).not.toBeInTheDocument();
  });

  it("splits pinned chats into their own section above recent chats", () => {
    pathnameMock.value = "/";
    recentChatsMock.value = [
      {
        id: "goat_chat_pinned",
        title: "Pinned chat",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Pinned",
        updatedAt: "2026-07-01T09:00:00.000Z",
        pinnedAt: "2026-07-13T09:00:00.000Z",
      },
      {
        id: "goat_chat_recent",
        title: "Recent chat",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Recent",
        updatedAt: "2026-07-14T09:00:00.000Z",
        pinnedAt: null,
      },
    ];
    render(<GoatSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const pinnedNav = screen.getByRole("navigation", { name: "Pinned chats" });
    expect(within(pinnedNav).getByRole("link", { name: "Pinned chat" })).toHaveAttribute(
      "href",
      "/chat/goat_chat_pinned",
    );
    const recentNav = screen.getByRole("navigation", { name: "Recent chats" });
    expect(within(recentNav).getByRole("link", { name: "Recent chat" })).toBeInTheDocument();
    expect(within(recentNav).queryByRole("link", { name: "Pinned chat" })).not.toBeInTheDocument();
  });

  it("pins and unpins chats via the row toggle", async () => {
    const user = userEvent.setup();
    pathnameMock.value = "/";
    recentChatsMock.value = [
      {
        id: "goat_chat_pinned",
        title: "Pinned chat",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Pinned",
        updatedAt: "2026-07-01T09:00:00.000Z",
        pinnedAt: "2026-07-13T09:00:00.000Z",
      },
      {
        id: "goat_chat_recent",
        title: "Recent chat",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Recent",
        updatedAt: "2026-07-14T09:00:00.000Z",
        pinnedAt: null,
      },
    ];
    render(<GoatSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Pin Recent chat" }));
    expect(chatActionsMock.setGoatChatPinnedAction).toHaveBeenCalledWith("goat_chat_recent", true);
    expect(screen.getByRole("button", { name: "Unpin Recent chat" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const unpin = screen.getByRole("button", { name: "Unpin Pinned chat" });
    expect(unpin).toHaveAttribute("aria-pressed", "true");
    await user.click(unpin);
    expect(chatActionsMock.setGoatChatPinnedAction).toHaveBeenCalledWith("goat_chat_pinned", false);
  });

  it("tracks concurrent pin requests independently and restores failed rows", async () => {
    const user = userEvent.setup();
    let resolvePin!: (value: { ok: true; error: null }) => void;
    let rejectUnpin!: (reason: Error) => void;
    chatActionsMock.setGoatChatPinnedAction
      .mockImplementationOnce(() => new Promise((resolve) => (resolvePin = resolve)))
      .mockImplementationOnce(() => new Promise((_, reject) => (rejectUnpin = reject)));
    recentChatsMock.value = [
      {
        id: "goat_chat_pinned",
        title: "Pinned chat",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Pinned",
        updatedAt: "2026-07-01T09:00:00.000Z",
        pinnedAt: "2026-07-13T09:00:00.000Z",
      },
      {
        id: "goat_chat_recent",
        title: "Recent chat",
        model: "claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        preview: "Recent",
        updatedAt: "2026-07-14T09:00:00.000Z",
        pinnedAt: null,
      },
    ];
    render(<GoatSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Pin Recent chat" }));
    await user.click(screen.getByRole("button", { name: "Unpin Pinned chat" }));

    expect(chatActionsMock.setGoatChatPinnedAction).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Unpin Recent chat" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pin Pinned chat" })).toBeDisabled();

    await act(async () => resolvePin({ ok: true, error: null }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unpin Recent chat" })).toBeEnabled(),
    );

    await act(async () => rejectUnpin(new Error("network unavailable")));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unpin Pinned chat" })).toBeEnabled(),
    );
  });

  it("collapses to zero width and toggles via the sidebar button", () => {
    pathnameMock.value = "/";
    const onToggleCollapsed = vi.fn();
    render(<GoatSidebar collapsed onToggleCollapsed={onToggleCollapsed} />);

    const aside = document.querySelector("aside");
    expect(aside).toHaveAttribute("aria-hidden", "true");
    expect(aside?.className).toContain("w-0");
  });
});
